# src/codecontext/indexing/indexer.py
from typing import List, Dict, Optional, Set
import uuid
from ..core.parser import CodeParser
from ..core.embedder import Embedder
from ..core.graph import DependencyGraph
from ..storage.vector_store import VectorStore
from ..git.analyzer import GitAnalyzer



# src/codecontext/indexing/indexer.py

async def index_github_hub(
    self,
    repo_id: str,
    conn_id: str,
    branch: str = None,
    options: Optional[Dict] = None
) -> Dict:
    """Index repository directly from GitHub Hub"""
    
    options = options or {}
    
    print(f"Indexing from GitHub Hub: conn={conn_id}, branch={branch}")
    
    # Create GitHub source
    source = GitHubRepositorySource(conn_id=conn_id, branch=branch)
    
    try:
        # Parse repository
        parsed_data = await source.parse_repository()
        
        # Rest of indexing is the same
        dep_graph = DependencyGraph()
        dep_graph.build_from_parsed_files(parsed_data['files'], "")
        
        # Git analysis not available for GitHub Hub sources
        git_analyzer = None
        
        # Generate embeddings and store
        entities_to_index = []
        for file_data in parsed_data['files']:
            # ... same as before ...
            pass
        
        self.vector_store.upsert(entities_to_index)
        
        return {
            'status': 'completed',
            'entities_indexed': len(entities_to_index),
            'files_processed': len(parsed_data['files']),
            'dependency_graph': dep_graph,
        }
    
    finally:
        await source.close()

class Indexer:
    def __init__(
        self,
        vector_store: VectorStore,
        parser: CodeParser,
        embedder: Embedder
    ):
        self.vector_store = vector_store
        self.parser = parser
        self.embedder = embedder
    
    async def incremental_index(
        self,
        repo_id: str,
        changed_files: List[str]
    ) -> Dict:
        """
        Perform incremental re-index of specific files
        
        Used by webhooks when files change
        """
        
        # Get repository info
        from ..storage.inmemory import InMemoryRepositoryStore
        
        # You'll need to pass repo_store to indexer or get it from app state
        # For now, assuming we have it
        repo = self.repo_store.get(repo_id)
        
        if not repo:
            raise ValueError(f"Repository {repo_id} not found")
        
        repo_path = repo.get('source_path') or f"./repositories/{repo_id}"
        
        # Use incremental indexer
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
        
        # Update repository metadata
        repo['last_indexed_at'] = utc_now_iso()
        
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
        
        # Step 3: Git analysis (if enabled)
        git_analyzer = None
        if options.get('analyze_git_history', True):
            print("Analyzing git history...")
            try:
                git_analyzer = GitAnalyzer(repo_path)
            except:
                print("Git analysis skipped (not a git repo)")
        
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
            
            # Generate embedding for file (use imports + file structure)
            file_text = f"File: {file_path}\n" + "\n".join(file_data.get('imports', []))
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
        
        # Step 6: Store metadata
        result = {
            'status': 'completed',
            'entities_indexed': len(entities_to_index),
            'files_processed': len(parsed_data['files']),
            'dependency_graph': dep_graph,
            'git_analyzer': git_analyzer,
        }
        
        return result