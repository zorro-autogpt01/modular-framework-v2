from fastapi import APIRouter, Depends, HTTPException, Request, Response
from typing import List, Dict, Any, Optional, Tuple, Set
import uuid
import inspect as _inspect

from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import PromptRequest, PromptOptions
from ...integrations.llm_gateway import LLMGatewayClient
from ...core.reranker import LocalReranker
from ...config import settings

router = APIRouter(prefix="/repositories", tags=["Prompts"], dependencies=[Depends(authorize)])

def _normalize_candidates(candidates: List[Dict]) -> List[Dict]:
    out=[]; 
    for c in candidates:
        if "_distance" in c and isinstance(c["_distance"], (int,float)): out.append(c); continue
        score=c.get("score",None); dist=0.5
        if isinstance(score,(int,float)):
            if 0.0<=score<=1.0: dist=1.0-float(score)
            else: dist=float(score)
        c["_distance"]=dist; out.append(c)
    return out

def _keyword_score(query: str, text: str) -> float:
    if not query or not text: return 0.0
    q_terms=[t.lower() for t in query.split() if len(t)>2]
    if not q_terms: return 0.0
    text_l=text.lower(); hits=sum(1 for t in q_terms if t in text_l)
    return min(1.0, hits/max(1,len(q_terms)))

def _hybrid_rerank(candidates: List[Dict], query: str, alpha: float = 0.2) -> List[Dict]:
    reranked=[]
    for c in candidates:
        sem=1.0-float(c.get("_distance",0.5))
        blob=" ".join([c.get("name") or "", c.get("file_path") or "", (c.get("code") or "")])[:4000]
        kw=_keyword_score(query, blob); blended=(sem*(1.0-alpha))+(kw*alpha); c["_hybrid"]=blended; reranked.append(c)
    reranked.sort(key=lambda x:x.get("_hybrid",0.0), reverse=True); return reranked

def _compute_signature(text: str, name: Optional[str]) -> str:
    import hashlib, re
    t=re.sub(r'\s+','',(text or "")); 
    if name: t=name+'|'+t
    return hashlib.sha1(t.encode('utf-8',errors='ignore')).hexdigest()

def _dedup_by_signature(items: List[Dict], sig_counts: Dict[str, int]) -> List[Dict]:
    seen=set(); out=[]
    for it in items:
        sig=_compute_signature(it.get('code') or it.get('snippet') or '', it.get('name'))
        if sig in seen: continue
        seen.add(sig)
        if sig in sig_counts and sig_counts[sig]>1:
            rs=list(it.get('reasons') or [])
            rs.append({'type':'dedup','score':1.0,'explanation': f"Deduplicated {sig_counts[sig]-1} similar definitions"})
            it['reasons']=rs
        out.append(it)
    return out

async def _agentic_expand(request: Request, repo_id: str, query: str, base_files: List[str], query_embedding: List[float]) -> Tuple[List[Dict], List[Dict]]:
    llm = LLMGatewayClient()
    try:
        preview="\n".join(f"- {f}" for f in base_files[:12])
        messages=[
            {"role":"system","content":"You are a code assistant optimizing retrieval. Reply with a short bullet list of file paths or symbols still needed. Only list items."},
            {"role":"user","content":f"Task:\n{query}\n\nFiles so far:\n{preview}\n\nList additional items:"}
        ]
        resp=await llm.chat(messages=messages, temperature=0.2, max_tokens=120)
        content=(resp.get("content") or "")
    finally:
        await llm.close()
    wanted=[ln.strip("- •\t ").strip() for ln in content.splitlines() if ln.strip()]
    vector_store=request.app.state.vector_store
    embedder=request.app.state.embedder
    added=[]
    import inspect as _inspect2
    for w in wanted[:10]:
        if "/" in w and "." in w:
            ents = vector_store.get_by_file(repo_id, w)
            file_chunks=[e for e in ents if e.get("entity_type")=="chunk"]
            if _inspect2.iscoroutinefunction(getattr(embedder,"embed_text",None)):
                emb = await embedder.embed_text(query)
            else:
                emb = embedder.embed_text(query)
            try:
                local = vector_store.search(embedding=emb, k=3, filters={'repo_id': repo_id, 'entity_type':'chunk','file_path': w})
            except Exception:
                local = file_chunks[:3]
            for it in local[:3]:
                it["snippet"]=(it.get("code") or "")[:1200]; added.append(it)
        else:
            # symbol -> best effort by name
            if _inspect2.iscoroutinefunction(getattr(embedder,"embed_text",None)):
                embn = await embedder.embed_text(w)
            else:
                embn = embedder.embed_text(w)
            try:
                ent = vector_store.search(embedding=embn, k=1, filters={'repo_id': repo_id, 'entity_type':'function'})
            except Exception:
                ent=[]
            if ent and ent[0].get("file_path"):
                try:
                    local = vector_store.search(embedding=query_embedding, k=2, filters={'repo_id': repo_id, 'entity_type':'chunk','file_path': ent[0]['file_path']})
                except Exception:
                    local = []
                for it in local[:2]:
                    it["snippet"]=(it.get("code") or "")[:1200]; added.append(it)
    return added, [{"type":"agentic","label":"agentic_suggestions","content":"\n".join(wanted)}]

async def _vector_top_chunks(
    request: Request,
    repo_id: str,
    query: str,
    max_chunks: int,
    languages: Optional[List[str]],
    retrieval_mode: str = "vector",
    call_graph_depth: int = 2,
    slice_target: Optional[str] = None,
    slice_direction: str = "forward",
    slice_depth: int = 2,
    agentic: bool = False,
    max_agentic_iters: int = 0
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    ranker = request.app.state.ranker
    indexer = request.app.state.indexer

    if _inspect.iscoroutinefunction(getattr(embedder,"embed_text",None)):
        query_embedding = await embedder.embed_text(query)
    else:
        query_embedding = embedder.embed_text(query)

    filters={"repo_id": repo_id, "entity_type": "chunk"}
    if languages and len(languages)>0: filters["language"]=languages[0]

    artifacts: List[Dict[str,Any]] = []
    preferred_files: Set[str] = set()

    # callgraph/slice preference (as in context)
    if retrieval_mode.lower() in ("callgraph","slice"):
        call_graph=indexer.call_graphs.get(repo_id) or {}
        if retrieval_mode.lower()=="callgraph":
            if _inspect.iscoroutinefunction(getattr(embedder,"embed_text",None)):
                qf=await embedder.embed_text(query)
            else:
                qf=embedder.embed_text(query)
            func_candidates=vector_store.search(embedding=qf, k=max_chunks*6, filters={"repo_id": repo_id,"entity_type":"function"})
            func_candidates=_normalize_candidates(func_candidates)
            sig_counts=(indexer.signature_counts or {}).get(repo_id,{}) if hasattr(indexer,"signature_counts") else {}
            func_candidates=_dedup_by_signature(func_candidates,sig_counts)
            if LocalReranker.available():
                func_candidates=LocalReranker.rerank(query, func_candidates, top_k=min(len(func_candidates), 50))
            centrality=indexer.dependency_centrality.get(repo_id,{}) or {}
            comod=indexer.comodification_scores.get(repo_id,{}) or {}
            recency=indexer.git_recency.get(repo_id,{}) or {}
            ranked_funcs=ranker.rank(func_candidates, centrality, comod, recency)
            for it in ranked_funcs[:max(3, max_chunks//2)]:
                if it.get("file_path"): preferred_files.add(it["file_path"])
            top_names=[it.get("name") for it in ranked_funcs[:5] if it.get("name")]
            from ...api.routes.context import _build_callgraph_artifact
            mer=_build_callgraph_artifact(call_graph, top_names, call_graph_depth, "forward")
            if mer: artifacts.append({"type":"mermaid","label":"callgraph","content":mer})
        else:
            from ...api.routes.context import _function_entity_for_name as _fmap, _build_callgraph_artifact
            seed=(slice_target or "").strip() or query
            ent=await _fmap(request, repo_id, seed)
            seed_name=ent.get("name") if ent else seed
            mer=_build_callgraph_artifact(call_graph, [seed_name], slice_depth, slice_direction.lower())
            if mer: artifacts.append({"type":"mermaid","label":f"slice({slice_direction})","content":mer})
            if ent and ent.get("file_path"): preferred_files.add(ent["file_path"])

    candidates = vector_store.search(embedding=query_embedding, k=max_chunks*4, filters=filters)
    candidates = _normalize_candidates(candidates)
    if preferred_files:
        for c in candidates:
            if c.get("file_path") in preferred_files:
                c["_distance"]=max(0.0,float(c.get("_distance",0.5))-0.07)
    if LocalReranker.available():
        topk=min(len(candidates), settings.reranker_topk)
        head=LocalReranker.rerank(query, candidates[:topk], top_k=topk)
        candidates=head + candidates[topk:]

    candidates = _hybrid_rerank(candidates, query, alpha=0.2)

    centrality=indexer.dependency_centrality.get(repo_id,{}) or {}
    comod=indexer.comodification_scores.get(repo_id,{}) or {}
    recency=indexer.git_recency.get(repo_id,{}) or {}
    ranked = ranker.rank(candidates, centrality, comod, recency)

    sig_counts = (indexer.signature_counts or {}).get(repo_id,{}) if hasattr(indexer,"signature_counts") else {}
    ranked = _dedup_by_signature(ranked, sig_counts)

    seen=set(); top=[]
    for it in ranked:
        cid=it.get("chunk_id") or it.get("id")
        if not cid or cid in seen: continue
        seen.add(cid); it["snippet"]=(it.get("code") or "")[:1600]; top.append(it)
        if len(top)>=max_chunks: break

    # Per-file summaries for prompt header
    per_file_summaries: Dict[str,str] = {}
    selected_files=sorted(list({c.get("file_path") for c in top if c.get("file_path")}))
    for fp in selected_files:
        ents = request.app.state.vector_store.get_by_file(repo_id, fp)
        cls = [e.get('name') for e in ents if e.get('entity_type')=='class'][:8]
        fns = [e.get('name') for e in ents if e.get('entity_type')=='function'][:12]
        per_file_summaries[fp] = f"File: {fp}\nClasses: {', '.join(cls) or '-'}\nFunctions: {', '.join(fns) or '-'}"

    # Agentic
    if agentic and max_agentic_iters>0:
        for _ in range(max_agentic_iters):
            added, ag_art = await _agentic_expand(request, repo_id, query, selected_files, query_embedding)
            if not added: break
            artifacts.extend(ag_art)
            for a in added: a['_distance']=max(0.0, float(a.get('_distance',0.5))-0.03)
            merge = _normalize_candidates(top + added)
            ranked2 = ranker.rank(merge, centrality, comod, recency)
            seen=set(); new_top=[]
            for it in ranked2:
                cid=it.get("chunk_id") or it.get("id")
                if not cid or cid in seen: continue
                seen.add(cid); it["snippet"]=(it.get("code") or "")[:1600]; new_top.append(it)
                if len(new_top)>=max_chunks: break
            top=new_top
            selected_files=sorted(list({c.get("file_path") for c in top if c.get("file_path")}))

    return top, artifacts, per_file_summaries

async def _dependency_neighbor_chunks(
    request: Request,
    repo_id: str,
    query_embedding: List[float],
    base_files: List[str],
    depth: int,
    direction: str,
    neighbor_files_limit: int,
    per_file_neighbor_chunks: int,
    languages: Optional[List[str]]
) -> List[Dict[str, Any]]:
    indexer=request.app.state.indexer; vector_store=request.app.state.vector_store
    dep_graph=indexer.graphs.get(repo_id)
    if not dep_graph: return []
    neighbor_files: List[str]=[]
    for f in base_files:
        try: deps=dep_graph.dependencies_of(f, depth=depth, direction=direction)
        except Exception: deps={"imports": [], "imported_by": []}
        files=[]
        if direction in ("imports","both"): files.extend(deps.get("imports") or [])
        if direction in ("imported_by","both"): files.extend(deps.get("imported_by") or [])
        for nf in files:
            if nf not in neighbor_files and nf not in base_files: neighbor_files.append(nf)
        if len(neighbor_files)>=neighbor_files_limit: break
    results=[]
    for nf in neighbor_files[:neighbor_files_limit]:
        filters={"repo_id": repo_id,"entity_type":"chunk","file_path": nf}
        if languages and len(languages)>0: filters["language"]=languages[0]
        try:
            local=vector_store.search(embedding=query_embedding, k=per_file_neighbor_chunks, filters=filters)
        except Exception:
            local=[]
        local=_normalize_candidates(local)
        for it in local[:per_file_neighbor_chunks]:
            it["snippet"]=(it.get("code") or "")[:1200]; results.append(it)
    return results

@router.post("/{repo_id}/prompt")
async def build_prompt(
    request: Request,
    repo_id: str,
    body: PromptRequest,
    response: Response
):
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    options = body.options or PromptOptions()
    model = options.model or None
    temperature = options.temperature or 0.2
    max_tokens = options.max_tokens or 2200
    max_chunks = options.max_chunks or 12
    per_file_neighbor_chunks = options.per_file_neighbor_chunks or 2
    include_dep = options.include_dependency_expansion if options.include_dependency_expansion is not None else True
    dep_depth = options.dependency_depth or 1
    dep_dir = options.dependency_direction or "both"
    neighbor_files_limit = options.neighbor_files_limit or 4
    retrieval_mode = (options.retrieval_mode or "vector").lower()
    call_graph_depth = options.call_graph_depth or 2
    slice_target = options.slice_target
    slice_direction = options.slice_direction or "forward"
    slice_depth = options.slice_depth or 2
    languages = options.languages or (body.filters.languages if body.filters and body.filters.languages else None)
    agentic = getattr(options, "agentic", settings.agentic_default)
    max_agentic_iters = getattr(options, "max_agentic_iters", settings.agentic_max_iters)

    embedder = request.app.state.embedder

    base_chunks, artifacts, per_file_summaries = await _vector_top_chunks(
        request=request,
        repo_id=repo_id,
        query=body.query,
        max_chunks=max_chunks,
        languages=languages,
        retrieval_mode=retrieval_mode,
        call_graph_depth=call_graph_depth,
        slice_target=slice_target,
        slice_direction=slice_direction,
        slice_depth=slice_depth,
        agentic=agentic,
        max_agentic_iters=max_agentic_iters
    )

    neighbor_chunks: List[Dict[str, Any]] = []
    if include_dep and base_chunks:
        import inspect as _inspect2
        if _inspect2.iscoroutinefunction(getattr(embedder,"embed_text",None)):
            q_emb = await embedder.embed_text(body.query)
        else:
            q_emb = embedder.embed_text(body.query)
        base_files = list({b.get("file_path") for b in base_chunks if b.get("file_path")})
        neighbor_chunks = await _dependency_neighbor_chunks(request, repo_id, q_emb, base_files, dep_depth, dep_dir, neighbor_files_limit, per_file_neighbor_chunks, languages)

    from ...core.prompt import PromptAssembler
    assembler = PromptAssembler(LLMGatewayClient())
    header_blocks = [per_file_summaries[fp] for fp in sorted(per_file_summaries.keys())]

    messages, usage = await assembler.assemble(
        query=body.query,
        base_chunks=base_chunks,
        neighbor_chunks=neighbor_chunks,
        model=model,
        system_prompt=options.system_prompt,
        temperature=temperature,
        max_tokens=max_tokens,
        header_blocks=header_blocks
    )

    selected_chunks=[]; seen_ids=set()
    for c in base_chunks+neighbor_chunks:
        cid=c.get("chunk_id") or c.get("id")
        if not cid or cid in seen_ids: continue
        snip=(c.get("snippet") or c.get("code") or "")[:60]
        included=any(snip and (snip in m.get("content","")) for m in messages)
        if included:
            selected_chunks.append({
                "id": cid,
                "file_path": c.get("file_path"),
                "start_line": int(c.get("start_line") or 0),
                "end_line": int(c.get("end_line") or 0),
                "language": c.get("language") or "unknown",
                "confidence": int(c.get("confidence") or 0),
                "reasons": c.get("reasons") or []
            })
            seen_ids.add(cid)

    data={
        "query": body.query,
        "model": model,
        "messages": messages,
        "selected_chunks": selected_chunks,
        "token_usage": usage,
        "summary": {
            "base_chunks_requested": max_chunks,
            "base_chunks_found": len(base_chunks),
            "neighbor_chunks_added": len([sc for sc in selected_chunks if sc["id"] not in {b.get('id') or b.get('chunk_id') for b in base_chunks}]),
            "dependency_expansion": include_dep,
            "dependency_depth": dep_depth,
            "dependency_direction": dep_dir,
            "retrieval_mode": retrieval_mode
        },
        "artifacts": artifacts
    }
    return success_response(request, data, response)
