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


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


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
        # Used by ranker as "history_score"
        self.comodification_scores: Dict[str, Dict[str, float]] = {}

        # Persistence path for metadata
        self.meta_path = Path(meta_path or settings.index_meta_path)

        # repo_store will be attached by main.py
        self.repo_store = None

    def _meta_file(self, repo_id: str) -> Path:
        return self.meta_path / f"{repo_id}.json"

    def save_metadata(self, repo_id: str) -> None:
        """Persist graph edges + centrality + recency + 'history' (comodification_scores) for a repo."""
        dep_graph = self.graphs.get(repo_id)
        edges: List[List[str]] = []
        if dep_graph and getattr(dep_graph, "graph", None):
            try:
                edges = [[str(u), str(v)] for (u, v) in dep_graph.graph.edges()]
            except Exception:
                edges = []

        payload = {
            "repo_id": repo_id,
            "graph": {
                "edges": edges
            },
            "centrality": self.dependency_centrality.get(repo_id, {}),
            "recency": self.git_recency.get(repo_id, {}),
            # Store "history" under 'comodification' key (used by ranker already)
            "comodification": self.comodification_scores.get(repo_id, {}),
        }
        _atomic_write(self._meta_file(repo_id), payload)

    def load_metadata_for_repo(self, repo_id: str) -> bool:
        """Load metadata for a single repo, rebuild in-memory caches."""
        fp = self._meta_file(repo_id)
        if not fp.exists():
            return False
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"Failed to load index metadata for {repo_id}: {e}")
            return False

        # Rebuild dependency graph
        dg = DependencyGraph()
        edges = data.get("graph", {}).get("edges", []) or []
        try:
            for u, v in edges:
                dg.graph.add_edge(u, v)
        except Exception:
            # If malformed, keep an empty graph
            pass

        self.graphs[repo_id] = dg
        self.dependency_centrality[repo_id] = data.get("centrality", {}) or {}
        self.git_recency[repo_id] = data.get("recency", {}) or {}
        self.comodification_scores[repo_id] = data.get("comodification", {}) or {}
        return True

    def load_all_metadata(self) -> int:
        """Scan meta directory and load all repo metadata files."""
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
        """
        Perform incremental re-index of specific files

        Used by webhooks when files change
        """
        if not self.repo_store:
            raise ValueError("Indexer.repo_store is not set")

        repo = self.repo_store.get(repo_id)
        if not repo:
            raise ValueError(f"Repository {repo_id} not found")

        repo_path = repo.get('source_path') or f"./repositories/{repo_id}"

        from .incremental import IncrementalIndexer
        inc_indexer = IncrementalIndexer(
            self.parser,
            self.embedder,
            self.vector_store
        )

        result = await inc_indexer.reindex_files(
            repo_id=repo_id,
            repo_path=repo_path,
            changed_files=changed_files
        )

        # Update repository metadata time
        from ..utils.time import utc_now_iso
        repo['last_indexed_at'] = utc_now_iso()

        # Note: For simplicity, we don't recompute centrality/recency/history here.
        # A full reindex or a separate recompute step can refresh these signals.

        # Persist updated metadata (best-effort)
        try:
            self.save_metadata(repo_id)
        except Exception as e:
            print(f"Warning: failed to save index metadata (incremental) for {repo_id}: {e}")

        return {
            'status': 'completed',
            'mode': 'incremental',
            'files_updated': result['files_updated'],
            'entities_updated': result['entities_updated']
        }

    def index(
        self,
        repo_id: str,
        repo_path: str,
        mode: str = "incremental",
        options: Optional[Dict] = None
    ) -> Dict:
        """Execute full indexing pipeline"""
        options = options or {}

        # Step 1: Parse repository
        print(f"Parsing repository: {repo_path}")
        parsed_data = self.parser.parse_repository(repo_path)

        # Step 2: Build dependency graph
        print("Building dependency graph...")
        dep_graph = DependencyGraph()
        dep_graph.build_from_parsed_files(parsed_data['files'], repo_path)
        self.graphs[repo_id] = dep_graph

        # Step 3: Git analysis (if enabled)
        git_analyzer = None
        if options.get('analyze_git_history', True) and settings.enable_git_analysis:
            print("Analyzing git history...")
            try:
                git_analyzer = GitAnalyzer(repo_path)
            except Exception as e:
                print(f"Git analysis skipped (not a git repo): {e}")

        # Compute signals and cache them
        # 3a) Dependency centrality
        try:
            centrality = dep_graph.get_centrality_scores() if dep_graph else {}
        except Exception:
            centrality = {}
        self.dependency_centrality[repo_id] = centrality or {}

        # 3b) Git recency (simple per-file score)
        recency_scores: Dict[str, float] = {}
        if git_analyzer:
            try:
                for file_data in parsed_data['files']:
                    fp = file_data['file_path']
                    recency_scores[fp] = git_analyzer.get_file_recency(fp)
            except Exception:
                pass
        self.git_recency[repo_id] = recency_scores or {}

        # 3c) Git change frequency as "history" score (normalized 0..1)
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
                        # Normalize to 0..1
                        history_scores[fp] = float(cnt) / float(max_freq)
                else:
                    # No history — default to 0.0 to avoid bias
                    history_scores = {fp: 0.0 for fp in raw_freq.keys()}
            except Exception as e:
                print(f"History score computation failed: {e}")
        self.comodification_scores[repo_id] = history_scores or {}

        # Step 4: Generate embeddings and prepare for vector store
        print("Generating embeddings...")
        entities_to_index = []

        for file_data in parsed_data['files']:
            file_path = file_data['file_path']

            # Index file-level
            file_entity = {
                'id': f"{repo_id}:file:{file_path}",
                'repo_id': repo_id,
                'file_path': file_path,
                'entity_type': 'file',
                'name': file_path.split('/')[-1],
                'code': '',  # Not storing full file
                'language': file_data['language'],
                'start_line': 0,
                'end_line': file_data['lines_of_code'],
            }
            file_entity = self.embedder.embed_code_entity(file_entity)
            entities_to_index.append(file_entity)

            # Index function-level
            for func in file_data.get('functions', []):
                func_entity = {
                    'id': f"{repo_id}:func:{file_path}:{func['name']}",
                    'repo_id': repo_id,
                    'file_path': file_path,
                    'entity_type': 'function',
                    'name': func['name'],
                    'code': func['code'],
                    'language': file_data['language'],
                    'start_line': func['start_line'],
                    'end_line': func['end_line'],
                }
                func_entity = self.embedder.embed_code_entity(func_entity)
                entities_to_index.append(func_entity)

            # Index class-level
            for cls in file_data.get('classes', []):
                cls_entity = {
                    'id': f"{repo_id}:class:{file_path}:{cls['name']}",
                    'repo_id': repo_id,
                    'file_path': file_path,
                    'entity_type': 'class',
                    'name': cls['name'],
                    'code': '',
                    'language': file_data['language'],
                    'start_line': cls['start_line'],
                    'end_line': cls['end_line'],
                }
                cls_entity = self.embedder.embed_code_entity(cls_entity)
                entities_to_index.append(cls_entity)

        # Step 5: Upsert to vector store
        print(f"Indexing {len(entities_to_index)} entities...")
        self.vector_store.upsert(entities_to_index)

        # Persist metadata for this repo so we can restore after restart
        try:
            self.save_metadata(repo_id)
        except Exception as e:
            print(f"Warning: failed to save index metadata for {repo_id}: {e}")

        # Step 6: Store metadata (returned to callers if needed)
        result = {
            'status': 'completed',
            'entities_indexed': len(entities_to_index),
            'files_processed': len(parsed_data['files']),
            'dependency_graph': dep_graph,
            'git_analyzer': git_analyzer,
        }

        return result