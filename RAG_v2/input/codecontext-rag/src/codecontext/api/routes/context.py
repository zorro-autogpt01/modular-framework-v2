from fastapi import APIRouter, Depends, HTTPException, Request, Response
from typing import List, Dict, Tuple, Set, Optional
import uuid
import inspect as _inspect

from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import ContextRequest
from ...diagramming.serializers import to_mermaid
from ...core.reranker import LocalReranker
from ...integrations.llm_gateway import LLMGatewayClient
from ...config import settings

router = APIRouter(prefix="/repositories", tags=["Context"], dependencies=[Depends(authorize)])

def _normalize_candidates(candidates: List[Dict]) -> List[Dict]:
    out = []
    for c in candidates:
        if '_distance' in c and isinstance(c['_distance'], (int, float)):
            out.append(c); continue
        score = c.get('score', None)
        dist = 0.5
        if isinstance(score, (int, float)):
            if 0.0 <= score <= 1.0: dist = 1.0 - float(score)
            else: dist = float(score)
        c['_distance'] = dist
        out.append(c)
    return out

def _compute_signature(text: str, name: str | None = None) -> str:
    import hashlib, re
    t = re.sub(r'\s+', '', (text or ""))
    if name: t = name + '|' + t
    return hashlib.sha1(t.encode('utf-8', errors='ignore')).hexdigest()

def _dedup_by_signature(items: List[Dict], sig_counts: Dict[str, int]) -> Tuple[List[Dict], Dict[str, int]]:
    seen: Set[str] = set(); kept: List[Dict] = []; stats: Dict[str, int] = {}
    for it in items:
        code = it.get('code') or it.get('snippet') or ''
        sig = _compute_signature(code, it.get('name'))
        if sig in seen: continue
        seen.add(sig)
        if sig in sig_counts and sig_counts[sig] > 1:
            rs = list(it.get('reasons') or [])
            rs.append({'type': 'dedup','score': 1.0,'explanation': f"Deduplicated {sig_counts[sig]-1} similar definitions"})
            it['reasons'] = rs; stats[sig] = sig_counts[sig]
        kept.append(it)
    return kept, stats

def _build_callgraph_artifact(call_graph: Dict, selected_names: List[str], depth: int, direction: str = "forward") -> str:
    if not call_graph: return ""
    nodes = call_graph.get("nodes") or []; edges = call_graph.get("edges") or []
    from collections import defaultdict, deque
    fwd=defaultdict(list); rev=defaultdict(list)
    for e in edges:
        if e.get("type")=="calls":
            s=e.get("source"); t=e.get("target"); fwd[s].append(t); rev[t].append(s)
    use=fwd if direction=="forward" else rev
    subs={}; sube=[]; q=deque([(n,0) for n in selected_names]); seen=set(selected_names)
    for n in selected_names: subs[n]={"id":n,"label":n,"type":"function"}
    while q:
        cur,d=q.popleft()
        if d>=depth: continue
        for nxt in use.get(cur, []):
            if direction=="forward": sube.append({"source":cur,"target":nxt,"type":"calls"})
            else: sube.append({"source":nxt,"target":cur,"type":"calls"})
            if nxt not in seen:
                seen.add(nxt); subs[nxt]={"id":nxt,"label":nxt,"type":"function"}; q.append((nxt,d+1))
    return to_mermaid({"nodes": list(subs.values()), "edges": sube}, kind="call")

async def _function_entity_for_name(request: Request, repo_id: str, func_name: str) -> Optional[Dict]:
    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    if _inspect.iscoroutinefunction(getattr(embedder,"embed_text",None)):
        emb = await embedder.embed_text(func_name)
    else:
        emb = embedder.embed_text(func_name)
    try:
        hits = vector_store.search(embedding=emb, k=1, filters={'repo_id': repo_id, 'entity_type': 'function'})
    except Exception:
        hits = []
    return hits[0] if hits else None

async def _agentic_expand(request: Request, repo_id: str, query: str, chunks: List[Dict], query_embedding: List[float]) -> Tuple[List[Dict], List[Dict]]:
    """
    Ask LLM what extra files/symbols are needed; fetch top chunks for those files.
    """
    llm = LLMGatewayClient()
    try:
        file_list = list({c.get("file_path") for c in chunks if c.get("file_path")})[:12]
        preview = "\n".join(f"- {f}" for f in file_list if f)
        messages = [
            {"role":"system","content":"You are a code assistant optimizing retrieval. The user will provide a task and current included files. Respond with a short bullet list of additional file paths or function names needed. Only list items, no prose."},
            {"role":"user","content":f"Task:\n{query}\n\nCurrently included files:\n{preview}\n\nList more file paths or function symbols that are likely needed:"}
        ]
        resp = await llm.chat(messages=messages, temperature=0.2, max_tokens=120)
        content = (resp.get("content") or "")
    finally:
        await llm.close()
    import re
    wanted = []
    for line in content.splitlines():
        line=line.strip("- •\t ").strip()
        if not line: continue
        wanted.append(line)
    # Fetch chunks by file match or symbol search
    vector_store = request.app.state.vector_store
    embedder = request.app.state.embedder
    added: List[Dict] = []
    for w in wanted[:10]:
        if "/" in w and "." in w:
            # looks like a path
            ents = vector_store.get_by_file(repo_id, w)
            file_chunks = [e for e in ents if e.get("entity_type")=="chunk"]
            # rank by proximity via filtered vector search if possible
            if _inspect.iscoroutinefunction(getattr(embedder,"embed_text",None)):
                emb = await embedder.embed_text(query)
            else:
                emb = embedder.embed_text(query)
            try:
                local = vector_store.search(embedding=emb, k=3, filters={'repo_id': repo_id, 'entity_type':'chunk','file_path': w})
            except Exception:
                local = file_chunks[:3]
            for it in local[:3]:
                it["snippet"] = (it.get("code") or "")[:1200]
                added.append(it)
        else:
            # symbol name -> function entity top-1 -> pick nearby chunk
            ent = await _function_entity_for_name(request, repo_id, w)
            if ent and ent.get("file_path"):
                try:
                    local = vector_store.search(embedding=query_embedding, k=2, filters={'repo_id': repo_id, 'entity_type':'chunk','file_path': ent['file_path']})
                except Exception:
                    local = []
                for it in local[:2]:
                    it["snippet"] = (it.get("code") or "")[:1200]
                    added.append(it)
    return added, [{"type":"agentic", "label":"agentic_suggestions", "content":"\n".join(wanted)}]

@router.post("/{repo_id}/context")
async def get_minimal_context(
    request: Request,
    repo_id: str,
    body: ContextRequest,
    response: Response
):
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    ranker = request.app.state.ranker
    indexer = request.app.state.indexer

    if _inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
        query_embedding = await embedder.embed_text(body.query)
    else:
        query_embedding = embedder.embed_text(body.query)

    centrality_scores = indexer.dependency_centrality.get(repo_id, {}) or {}
    comodification_scores = indexer.comodification_scores.get(repo_id, {}) or {}
    recency_scores = indexer.git_recency.get(repo_id, {}) or {}
    sig_counts = (indexer.signature_counts or {}).get(repo_id, {}) if hasattr(indexer, "signature_counts") else {}

    max_chunks = body.max_chunks or 8
    artifacts: List[Dict] = []
    retrieval_mode = (body.retrieval_mode or "vector").lower()
    preferred_files: Set[str] = set()

    # Callgraph / slice as before
    if retrieval_mode == "callgraph":
        func_k = max_chunks * 6
        func_candidates = vector_store.search(embedding=query_embedding, k=func_k, filters={'repo_id': repo_id, 'entity_type': 'function'})
        func_candidates = _normalize_candidates(func_candidates)
        func_candidates, _ = _dedup_by_signature(func_candidates, sig_counts)
        # local reranker on top functions
        if LocalReranker.available():
            func_candidates = LocalReranker.rerank(body.query, func_candidates, top_k=func_k)
        ranked_funcs = ranker.rank(func_candidates, centrality_scores, comodification_scores, recency_scores)
        for it in ranked_funcs[: max(3, max_chunks // 2)]:
            if it.get('file_path'):
                preferred_files.add(it['file_path'])
        top_names = [it.get('name') for it in ranked_funcs[:5] if it.get('name')]
        call_mermaid = _build_callgraph_artifact(indexer.call_graphs.get(repo_id) or {}, top_names, body.call_graph_depth or 2, "forward")
        if call_mermaid:
            artifacts.append({"type": "mermaid", "label": "callgraph", "content": call_mermaid})
    elif retrieval_mode == "slice":
        call_graph = indexer.call_graphs.get(repo_id) or {}
        depth = max(1, int(body.slice_depth or 2))
        direction = (body.slice_direction or "forward").lower()
        seed = (body.slice_target or "").strip() or body.query
        seed_entity = await _function_entity_for_name(request, repo_id, seed)
        seed_name = seed_entity.get('name') if seed_entity else seed
        if seed_name:
            art = _build_callgraph_artifact(call_graph, [seed_name], depth, direction)
            if art:
                artifacts.append({"type": "mermaid", "label": f"slice({direction})", "content": art})
            # prefer files
            ent = seed_entity
            if ent and ent.get('file_path'):
                preferred_files.add(ent['file_path'])

    # Chunk search
    k = (max_chunks or 8) * 4
    filters = {'repo_id': repo_id, 'entity_type': 'chunk'}
    if body.filters and body.filters.languages:
        filters['language'] = body.filters.languages[0]
    candidates = vector_store.search(embedding=query_embedding, k=k, filters=filters)
    candidates = _normalize_candidates(candidates)
    if preferred_files:
        for c in candidates:
            if c.get('file_path') in preferred_files:
                c['_distance'] = max(0.0, float(c.get('_distance', 0.5)) - 0.07)
    # local rerank chunks top-k before final rank
    if LocalReranker.available():
        topk = min(len(candidates), settings.reranker_topk)
        head = LocalReranker.rerank(body.query, candidates[:topk], top_k=topk)
        candidates = head + candidates[topk:]
    ranked = ranker.rank(candidates, centrality_scores, comodification_scores, recency_scores)
    ranked, _ = _dedup_by_signature(ranked, sig_counts)

    seen_chunk_ids = set()
    results = []
    for item in ranked:
        file_path = item.get('file_path'); chunk_id = item.get('chunk_id') or item.get('id')
        if not file_path or not chunk_id: continue
        if chunk_id in seen_chunk_ids: continue
        seen_chunk_ids.add(chunk_id)
        snippet = (item.get('code') or item.get('snippet') or '')[:1200]
        results.append({
            'file_path': file_path,
            'start_line': int(item.get('start_line') or 0),
            'end_line': int(item.get('end_line') or 0),
            'language': item.get('language') or 'unknown',
            'snippet': snippet,
            'confidence': int(item.get('confidence', 0)),
            'reasons': item.get('reasons', []),
            'distance': float(item.get('_distance', 0.5))
        })
        if len(results) >= max_chunks: break

    # Agentic loop (optional)
    if (body.expand_neighbors or settings.agentic_default) and getattr(body, "agentic", settings.agentic_default):
        iters = max(0, int(getattr(body, "max_agentic_iters", settings.agentic_max_iters)))
        for _ in range(iters):
            added, agentic_artifacts = await _agentic_expand(request, repo_id, body.query, results, query_embedding)
            if not added: break
            artifacts.extend(agentic_artifacts)
            # Merge and dedup
            merge = results + added
            # rerank merge with light distance trick to push added
            for a in added: a['_distance'] = max(0.0, float(a.get('_distance', 0.5)) - 0.03)
            ranked2 = ranker.rank(_normalize_candidates(merge), centrality_scores, comodification_scores, recency_scores)
            # prune to max_chunks
            seen_chunk_ids = set()
            new_results = []
            for item in ranked2:
                cid = item.get("chunk_id") or item.get("id")
                if not cid or cid in seen_chunk_ids: continue
                seen_chunk_ids.add(cid)
                item['snippet'] = (item.get('code') or item.get('snippet') or "")[:1200]
                new_results.append({
                    'file_path': item.get('file_path'),
                    'start_line': int(item.get('start_line') or 0),
                    'end_line': int(item.get('end_line') or 0),
                    'language': item.get('language') or 'unknown',
                    'snippet': item.get('snippet'),
                    'confidence': int(item.get('confidence', 0)),
                    'reasons': item.get('reasons', []),
                    'distance': float(item.get('_distance', 0.5))
                })
                if len(new_results) >= max_chunks: break
            results = new_results

    # Optional neighbor expansion (existing)
    if body.expand_neighbors and results:
        expanded = list(results)
        for r in results:
            if len(expanded) >= max_chunks: break
            file_entities = vector_store.get_by_file(repo_id, r['file_path'])
            file_chunks = [e for e in file_entities if e.get('entity_type') == 'chunk']
            def proximity_score(e):
                s = int(e.get('start_line') or 0); center = (r['start_line'] + r['end_line']) // 2
                return abs(s - center)
            file_chunks.sort(key=proximity_score)
            for ch in file_chunks[:2]:
                ch_id = ch.get('chunk_id') or ch.get('id')
                if ch_id in seen_chunk_ids: continue
                seen_chunk_ids.add(ch_id)
                expanded.append({
                    'file_path': ch.get('file_path'),
                    'start_line': int(ch.get('start_line') or 0),
                    'end_line': int(ch.get('end_line') or 0),
                    'language': ch.get('language') or 'unknown',
                    'snippet': (ch.get('code') or '')[:1000],
                    'confidence': int(ch.get('confidence', 0)),
                    'reasons': ch.get('reasons', []),
                    'distance': float(ch.get('_distance', 0.5))
                })
                if len(expanded) >= max_chunks: break
        results = expanded[:max_chunks]

    data = {
        'query': body.query,
        'chunks': results,
        'summary': {
            'total_chunks': len(results),
            'avg_confidence': sum(r['confidence'] for r in results) / max(1, len(results)),
            'retrieval_mode': retrieval_mode
        },
        'artifacts': artifacts
    }
    return success_response(request, data, response)