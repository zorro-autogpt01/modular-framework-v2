from typing import List, Dict, Optional
import json
import os
from pathlib import Path

from ..core.parser import CodeParser
from ..core.embedder import Embedder
from ..core.graph import DependencyGraph
from ..storage.vector_store import VectorStore
from ..git.analyzer import GitAnalyzer
from ..config import settings

# Diagramming runners
from ..diagramming.pyreverse_runner import run_pyreverse
from ..diagramming.depcruise_runner import run_depcruise
from ..diagramming.doxygen_runner import run_doxygen

def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def _compute_signature(text: str, name: str | None = None) -> str:
    import hashlib, re
    t = (text or "")
    t = re.sub(r'\s+', '', t)
    if name:
        t = name + '|' + t
    return hashlib.sha1(t.encode('utf-8', errors='ignore')).hexdigest()

class Indexer:
    def __init__(
        self,
        vector_store: VectorStore,
        parser: CodeParser,
        embedder: Embedder,
        meta_path: str | None = None
    ):
        self.vector_store = vector_store
        self.parser = parser
        self.embedder = embedder

        # In-memory caches keyed by repo_id
        self.graphs: Dict[str, DependencyGraph] = {}
        self.dependency_centrality: Dict[str, Dict[str, float]] = {}
        self.git_recency: Dict[str, Dict[str, float]] = {}
        self.comodification_scores: Dict[str, Dict[str, float]] = {}

        # Higher-level graphs
        self.class_graphs: Dict[str, Dict] = {}
        self.module_graphs: Dict[str, Dict] = {}
        self.call_graphs: Dict[str, Dict] = {}

        # Signature-based dedup info
        self.signature_counts: Dict[str, Dict[str, int]] = {}
        self.signature_representative: Dict[str, Dict[str, str]] = {}

        self.meta_path = Path(meta_path or settings.index_meta_path)
        self.repo_store = None

    def _meta_file(self, repo_id: str) -> Path:
        return self.meta_path / f"{repo_id}.json"

    def save_metadata(self, repo_id: str) -> None:
        dep_graph = self.graphs.get(repo_id)
        edges: List[List[str]] = []
        if dep_graph and getattr(dep_graph, "graph", None):
            try:
                edges = [[str(u), str(v)] for (u, v) in dep_graph.graph.edges()]
            except Exception:
                edges = []

        payload = {
            "repo_id": repo_id,
            "graph": {"edges": edges},
            "centrality": self.dependency_centrality.get(repo_id, {}),
            "recency": self.git_recency.get(repo_id, {}),
            "comodification": self.comodification_scores.get(repo_id, {}),
            "class_graph": self.class_graphs.get(repo_id, {"nodes": [], "edges": []}),
            "module_graph": self.module_graphs.get(repo_id, {"nodes": [], "edges": []}),
            "call_graph": self.call_graphs.get(repo_id, {"nodes": [], "edges": []}),
            "signature_counts": self.signature_counts.get(repo_id, {}),
            "signature_representative": self.signature_representative.get(repo_id, {}),
        }
        _atomic_write(self._meta_file(repo_id), payload)

    def load_metadata_for_repo(self, repo_id: str) -> bool:
        fp = self._meta_file(repo_id)
        if not fp.exists():
            return False
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"Failed to load index metadata for {repo_id}: {e}")
            return False

        dg = DependencyGraph()
        edges = data.get("graph", {}).get("edges", []) or []
        try:
            for u, v in edges:
                dg.graph.add_edge(u, v)
        except Exception:
            pass

        self.graphs[repo_id] = dg
        self.dependency_centrality[repo_id] = data.get("centrality", {}) or {}
        self.git_recency[repo_id] = data.get("recency", {}) or {}
        self.comodification_scores[repo_id] = data.get("comodification", {}) or {}

        self.class_graphs[repo_id] = data.get("class_graph", {"nodes": [], "edges": []}) or {"nodes": [], "edges": []}
        self.module_graphs[repo_id] = data.get("module_graph", {"nodes": [], "edges": []}) or {"nodes": [], "edges": []}
        self.call_graphs[repo_id] = data.get("call_graph", {"nodes": [], "edges": []}) or {"nodes": [], "edges": []}

        self.signature_counts[repo_id] = data.get("signature_counts", {}) or {}
        self.signature_representative[repo_id] = data.get("signature_representative", {}) or {}
        return True

    def load_all_metadata(self) -> int:
        if not self.meta_path.exists():
            return 0
        count = 0
        for fp in self.meta_path.glob("*.json"):
            repo_id = fp.stem
            if self.load_metadata_for_repo(repo_id):
                count += 1
        return count

    async def incremental_index(
        self,
        repo_id: str,
        changed_files: List[str]
    ) -> Dict:
        if not self.repo_store:
            raise ValueError("Indexer.repo_store is not set")
        repo = self.repo_store.get(repo_id)
        if not repo:
            raise ValueError(f"Repository {repo_id} not found")

        repo_path = repo.get('source_path') or f"./repositories/{repo_id}"

        from .incremental import IncrementalIndexer
        inc_indexer = IncrementalIndexer(self.parser, self.embedder, self.vector_store)
        result = await inc_indexer.reindex_files(repo_id=repo_id, repo_path=repo_path, changed_files=changed_files)

        from ..utils.time import utc_now_iso
        repo['last_indexed_at'] = utc_now_iso()

        try:
            self.save_metadata(repo_id)
        except Exception as e:
            print(f"Warning: failed to save index metadata (incremental) for {repo_id}: {e}")

        return {'status': 'completed', 'mode': 'incremental', 'files_updated': result['files_updated'], 'entities_updated': result['entities_updated']}

    def _sync_graphs_to_neo4j(self, repo_id: str):
        if not settings.neo4j_enabled:
            return
        try:
            from ..integrations.neo4j_client import Neo4jClient
            client = Neo4jClient(settings.neo4j_url, settings.neo4j_user, settings.neo4j_password)
            client.ensure_schema()
            dep_edges = []
            dg = self.graphs.get(repo_id)
            if dg and getattr(dg, "graph", None):
                try:
                    for (u, v) in dg.graph.edges():
                        dep_edges.append({"source": str(u), "target": str(v), "type": "imports"})
                except Exception:
                    pass
            dep_graph = {
                "nodes": [{"id": str(n), "label": str(n).split("/")[-1], "type": "file"} for n in (dg.graph.nodes() if dg else [])],
                "edges": dep_edges
            }
            client.upsert_graph(repo_id, "dependency", dep_graph)
            client.upsert_graph(repo_id, "module", self.module_graphs.get(repo_id) or {"nodes": [], "edges": []})
            client.upsert_graph(repo_id, "class", self.class_graphs.get(repo_id) or {"nodes": [], "edges": []})
            client.upsert_graph(repo_id, "call", self.call_graphs.get(repo_id) or {"nodes": [], "edges": []})
            client.close()
        except Exception as e:
            print(f"Neo4j sync failed: {e}")

    def index(
        self,
        repo_id: str,
        repo_path: str,
        mode: str = "incremental",
        options: Optional[Dict] = None
    ) -> Dict:
        options = options or {}

        print(f"Parsing repository: {repo_path}")
        parsed_data = self.parser.parse_repository(repo_path)

        print("Building dependency graph...")
        dep_graph = DependencyGraph()
        dep_graph.build_from_parsed_files(parsed_data['files'], repo_path)
        self.graphs[repo_id] = dep_graph

        langs_present = set(parsed_data.get('language_stats', {}).keys())
        class_graph = {"nodes": [], "edges": []}
        module_graph = {"nodes": [], "edges": []}
        call_graph = {"nodes": [], "edges": []}

        if 'python' in langs_present:
            try:
                pyrev = run_pyreverse(repo_path)
                class_graph = pyrev.get("class_graph", {"nodes": [], "edges": []})
                module_graph = pyrev.get("module_graph", {"nodes": [], "edges": []}) or module_graph
            except Exception as e:
                print(f"pyreverse failed: {e}")

        if 'javascript' in langs_present:
            try:
                depc = run_depcruise(repo_path)
                if depc and depc.get("nodes") is not None:
                    module_graph = depc
            except Exception as e:
                print(f"dependency-cruiser failed: {e}")

        try:
            doxy = run_doxygen(repo_path)
            if doxy and doxy.get("call_graph"):
                call_graph = doxy["call_graph"]
            if doxy and doxy.get("class_graph"):
                dg = doxy["class_graph"]
                if not class_graph.get("nodes"):
                    class_graph = dg
        except Exception as e:
            print(f"doxygen runner failed: {e}")

        self.class_graphs[repo_id] = class_graph or {"nodes": [], "edges": []}
        self.module_graphs[repo_id] = module_graph or {"nodes": [], "edges": []}
        self.call_graphs[repo_id] = call_graph or {"nodes": [], "edges": []}

        git_analyzer = None
        if options.get('analyze_git_history', True) and settings.enable_git_analysis:
            print("Analyzing git history...")
            try:
                git_analyzer = GitAnalyzer(repo_path)
            except Exception as e:
                print(f"Git analysis skipped (not a git repo): {e}")

        try:
            centrality = dep_graph.get_centrality_scores() if dep_graph else {}
        except Exception:
            centrality = {}
        self.dependency_centrality[repo_id] = centrality or {}

        recency_scores: Dict[str, float] = {}
        if git_analyzer:
            try:
                for file_data in parsed_data['files']:
                    fp = file_data['file_path']
                    recency_scores[fp] = git_analyzer.get_file_recency(fp)
            except Exception:
                pass
        self.git_recency[repo_id] = recency_scores or {}

        history_scores: Dict[str, float] = {}
        if git_analyzer:
            try:
                raw_freq: Dict[str, int] = {}
                for file_data in parsed_data['files']:
                    fp = file_data['file_path']
                    raw_freq[fp] = int(git_analyzer.get_change_frequency(fp, months_back=12) or 0)
                max_freq = max(raw_freq.values()) if raw_freq else 0
                if max_freq > 0:
                    for fp, cnt in raw_freq.items():
                        history_scores[fp] = float(cnt) / float(max_freq)
                else:
                    history_scores = {fp: 0.0 for fp in raw_freq.keys()}
            except Exception as e:
                print(f"History score computation failed: {e}")
        self.comodification_scores[repo_id] = history_scores or {}

        print("Generating embeddings...")
        entities_to_index = []

        # Reset signature maps
        self.signature_counts[repo_id] = {}
        self.signature_representative[repo_id] = {}

        for file_data in parsed_data['files']:
            file_path = file_data['file_path']

            file_entity = {
                'id': f"{repo_id}:file:{file_path}",
                'repo_id': repo_id,
                'file_path': file_path,
                'entity_type': 'file',
                'name': file_path.split('/')[-1],
                'code': '',
                'language': file_data['language'],
                'start_line': 0,
                'end_line': file_data['lines_of_code'],
                'chunk_id': ''
            }
            file_entity = self.embedder.embed_code_entity(file_entity)
            entities_to_index.append(file_entity)

            for func in file_data.get('functions', []):
                sig = _compute_signature(func.get('code', ''), func.get('name'))
                cnts = self.signature_counts[repo_id]
                cnts[sig] = cnts.get(sig, 0) + 1
                rep_map = self.signature_representative[repo_id]
                is_new = sig not in rep_map
                if is_new:
                    rep_map[sig] = f"{repo_id}:func:{file_path}:{func['name']}"
                else:
                    continue

                func_entity = {
                    'id': rep_map[sig],
                    'repo_id': repo_id,
                    'file_path': file_path,
                    'entity_type': 'function',
                    'name': func['name'],
                    'code': func.get('code', ''),
                    'language': file_data['language'],
                    'start_line': func['start_line'],
                    'end_line': func['end_line'],
                    'chunk_id': ''
                }
                func_entity = self.embedder.embed_code_entity(func_entity)
                entities_to_index.append(func_entity)

            for cls in file_data.get('classes', []):
                sig = _compute_signature(cls.get('code', ''), cls.get('name'))
                cnts = self.signature_counts[repo_id]
                cnts[sig] = cnts.get(sig, 0) + 1
                rep_map = self.signature_representative[repo_id]
                is_new = sig not in rep_map
                if is_new:
                    rep_map[sig] = f"{repo_id}:class:{file_path}:{cls['name']}"
                else:
                    continue

                cls_entity = {
                    'id': rep_map[sig],
                    'repo_id': repo_id,
                    'file_path': file_path,
                    'entity_type': 'class',
                    'name': cls['name'],
                    'code': cls.get('code', ''),
                    'language': file_data['language'],
                    'start_line': cls['start_line'],
                    'end_line': cls['end_line'],
                    'chunk_id': ''
                }
                cls_entity = self.embedder.embed_code_entity(cls_entity)
                entities_to_index.append(cls_entity)

            for idx, ch in enumerate(file_data.get('chunks', [])):
                chunk_id = f"{repo_id}:chunk:{file_path}:{ch['start_line']}-{ch['end_line']}"
                chunk_entity = {
                    'id': chunk_id,
                    'repo_id': repo_id,
                    'file_path': file_path,
                    'entity_type': 'chunk',
                    'name': f"chunk_{idx}",
                    'code': ch.get('code', '')[:4000],
                    'language': file_data['language'],
                    'start_line': ch['start_line'],
                    'end_line': ch['end_line'],
                    'chunk_id': chunk_id
                }
                chunk_entity = self.embedder.embed_code_entity(chunk_entity)
                entities_to_index.append(chunk_entity)

        print(f"Indexing {len(entities_to_index)} entities...")
        self.vector_store.upsert(entities_to_index)

        # Run feature extraction (safely) if enabled
        if settings.enable_feature_extraction:
            print("Running feature extraction...")
            try:
                from ..features.extractor import FeatureExtractor
                from ..storage.feature_store import FeatureStore
                from ..integrations.llm_gateway import LLMGatewayClient
                import asyncio

                feature_store = FeatureStore()
                llm_client = LLMGatewayClient()
                extractor = FeatureExtractor(self.embedder, llm_client)

                # Execute async extractor inside this sync method
                try:
                    features = asyncio.run(
                        extractor.extract_features(repo_id, repo_path, parsed_data, self.vector_store)
                    )
                except RuntimeError:
                    # If we're already in an event loop (rare here), create a new one
                    loop = asyncio.new_event_loop()
                    try:
                        features = loop.run_until_complete(
                            extractor.extract_features(repo_id, repo_path, parsed_data, self.vector_store)
                        )
                    finally:
                        loop.close()

                feature_store.save_features(features)
                # Best-effort close LLM client
                try:
                    asyncio.run(llm_client.close())
                except Exception:
                    pass

                print(f"Saved {len(features)} features")

            except Exception as e:
                print(f"Feature extraction failed: {e}")

        # Best-effort persist
        try:
            self.save_metadata(repo_id)
        except Exception as e:
            print(f"Warning: failed to save index metadata for {repo_id}: {e}")

        # Optional: push graphs to Neo4j
        self._sync_graphs_to_neo4j(repo_id)

        result = {
            'status': 'completed',
            'entities_indexed': len(entities_to_index),
            'files_processed': len(parsed_data['files']),
            'dependency_graph': dep_graph,
            'git_analyzer': git_analyzer,
            'graphs_summary': {
                'class_nodes': len(self.class_graphs[repo_id].get('nodes', [])),
                'class_edges': len(self.class_graphs[repo_id].get('edges', [])),
                'module_nodes': len(self.module_graphs[repo_id].get('nodes', [])),
                'module_edges': len(self.module_graphs[repo_id].get('edges', [])),
                'call_nodes': len(self.call_graphs[repo_id].get('nodes', [])),
                'call_edges': len(self.call_graphs[repo_id].get('edges', [])),
            },
            'dedup_summary': {
                'unique_signatures': len(self.signature_counts[repo_id]),
                'total_occurrences': sum(self.signature_counts[repo_id].values()),
            }
        }
        return result