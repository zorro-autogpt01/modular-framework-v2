# src/codecontext/storage/vector_store.py
import lancedb
from typing import List, Dict, Optional
import pyarrow as pa

class VectorStore:
    def __init__(self, path: str = "./data/lancedb"):
        """Initialize LanceDB connection"""
        self.db = lancedb.connect(path)
        self._init_tables()
    
    def _init_tables(self):
        """Create tables if they don't exist"""
        # Table for code entities (functions, classes)
        if "code_entities" not in self.db.table_names():
            schema = pa.schema([
                pa.field("id", pa.string()),
                pa.field("repo_id", pa.string()),
                pa.field("file_path", pa.string()),
                pa.field("entity_type", pa.string()),  # function, class, file
                pa.field("name", pa.string()),
                pa.field("code", pa.string()),
                pa.field("language", pa.string()),
                pa.field("start_line", pa.int32()),
                pa.field("end_line", pa.int32()),
                pa.field("embedding", pa.list_(pa.float32(), 768)),  # Adjust dimension
            ])
            self.db.create_table("code_entities", schema=schema)
    
    def upsert(self, items: List[Dict]) -> None:
        """Insert or update code entities"""
        if not items:
            return
        
        table = self.db.open_table("code_entities")
        table.add(items)
    
    def search(
        self, 
        embedding: List[float], 
        k: int = 10, 
        filters: Optional[Dict] = None
    ) -> List[Dict]:
        """Semantic search for similar code entities"""
        table = self.db.open_table("code_entities")
        
        query = table.search(embedding).limit(k)
        
        # Apply filters if provided
        if filters:
            if 'repo_id' in filters:
                query = query.where(f"repo_id = '{filters['repo_id']}'")
            if 'language' in filters:
                query = query.where(f"language = '{filters['language']}'")
            if 'entity_type' in filters:
                query = query.where(f"entity_type = '{filters['entity_type']}'")
        
        results = query.to_list()
        return results
    
    def get_by_file(self, repo_id: str, file_path: str) -> List[Dict]:
        """Get all entities in a specific file"""
        table = self.db.open_table("code_entities")
        results = table.search() \
            .where(f"repo_id = '{repo_id}' AND file_path = '{file_path}'") \
            .to_list()
        return results
    
    def delete_repo(self, repo_id: str) -> None:
        """Delete all entities for a repository"""
        table = self.db.open_table("code_entities")
        table.delete(f"repo_id = '{repo_id}'")


    def delete_by_file(self, repo_id: str, file_path: str) -> None:
        """Delete all entities for a specific file"""
        table = self.db.open_table("code_entities")
        table.delete(f"repo_id = '{repo_id}' AND file_path = '{file_path}'")

    def delete_by_repo(self, repo_id: str) -> None:
        """Delete all entities for a repository (already exists, just confirming)"""
        table = self.db.open_table("code_entities")
        table.delete(f"repo_id = '{repo_id}'")

    def get_by_file(self, repo_id: str, file_path: str) -> List[Dict]:
        """Get all entities in a specific file (already exists, confirmed)"""
        table = self.db.open_table("code_entities")
        results = table.search() \
            .where(f"repo_id = '{repo_id}' AND file_path = '{file_path}'") \
            .to_list()
        return results

    def count_entities(self, repo_id: str) -> int:
        """Count total entities for a repository"""
        table = self.db.open_table("code_entities")
        results = table.search() \
            .where(f"repo_id = '{repo_id}'") \
            .to_list()
        return len(results)