# src/codecontext/indexing/incremental.py

from typing import List, Dict, Optional
from ..core.parser import CodeParser
from ..core.embedder import Embedder
from ..storage.vector_store import VectorStore

class IncrementalIndexer:
    """Handle incremental updates to the index"""
    
    def __init__(self, parser: CodeParser, embedder: Embedder, vector_store: VectorStore):
        self.parser = parser
        self.embedder = embedder
        self.vector_store = vector_store
    
    async def reindex_files(
        self,
        repo_id: str,
        repo_path: str,
        changed_files: List[str]
    ) -> Dict:
        """
        Re-index only specific files that changed
        
        Much faster than full re-index for incremental updates
        """
        
        updated_entities = []
        
        for file_path in changed_files:
            # Delete old entities for this file
            self.vector_store.delete_by_file(repo_id, file_path)
            
            # Parse and re-index
            full_path = f"{repo_path}/{file_path}"
            
            try:
                parsed = self.parser.parse_file(full_path, repo_path)
                
                if not parsed:
                    continue
                
                # Generate embeddings for file and entities
                file_entity = {
                    'id': f"{repo_id}:file:{file_path}",
                    'repo_id': repo_id,
                    'file_path': file_path,
                    'entity_type': 'file',
                    'name': file_path.split('/')[-1],
                    'code': '',
                    'language': parsed['language'],
                    'start_line': 0,
                    'end_line': parsed['lines_of_code'],
                }
                
                file_text = f"File: {file_path}\n" + "\n".join(parsed.get('imports', []))
                
                if hasattr(self.embedder, 'embed_code_entity'):
                    file_entity = self.embedder.embed_code_entity(file_entity)
                else:
                    # Async embedder
                    file_entity = await self.embedder.embed_code_entity(file_entity)
                
                updated_entities.append(file_entity)
                
                # Index functions
                for func in parsed.get('functions', []):
                    func_entity = {
                        'id': f"{repo_id}:func:{file_path}:{func['name']}",
                        'repo_id': repo_id,
                        'file_path': file_path,
                        'entity_type': 'function',
                        'name': func['name'],
                        'code': func['code'],
                        'language': parsed['language'],
                        'start_line': func['start_line'],
                        'end_line': func['end_line'],
                    }
                    
                    if hasattr(self.embedder, 'embed_code_entity'):
                        func_entity = self.embedder.embed_code_entity(func_entity)
                    else:
                        func_entity = await self.embedder.embed_code_entity(func_entity)
                    
                    updated_entities.append(func_entity)
                
                # Index classes
                for cls in parsed.get('classes', []):
                    cls_entity = {
                        'id': f"{repo_id}:class:{file_path}:{cls['name']}",
                        'repo_id': repo_id,
                        'file_path': file_path,
                        'entity_type': 'class',
                        'name': cls['name'],
                        'code': '',
                        'language': parsed['language'],
                        'start_line': cls['start_line'],
                        'end_line': cls['end_line'],
                    }
                    
                    if hasattr(self.embedder, 'embed_code_entity'):
                        cls_entity = self.embedder.embed_code_entity(cls_entity)
                    else:
                        cls_entity = await self.embedder.embed_code_entity(cls_entity)
                    
                    updated_entities.append(cls_entity)
            
            except Exception as e:
                print(f"Error re-indexing {file_path}: {e}")
                continue
        
        # Upsert all updated entities
        if updated_entities:
            self.vector_store.upsert(updated_entities)
        
        return {
            'files_updated': len(changed_files),
            'entities_updated': len(updated_entities)
        }