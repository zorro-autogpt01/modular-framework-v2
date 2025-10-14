# src/codecontext/storage/vector_store.py
import lancedb
from typing import List, Dict, Optional
import pandas as pd

class VectorStore:
    def __init__(self, path: str = "./data/lancedb"):
        """Initialize LanceDB connection"""
        self.db = lancedb.connect(path)
        # Let schema be inferred dynamically from data
    
    def upsert(self, entities: List[Dict]):
        """Upsert entities to vector store"""
        if not entities:
            return
        
        # Validate all embeddings have the same dimension
        first_dim = len(entities[0].get('embedding', []))
        
        valid_entities = []
        for entity in entities:
            embedding = entity.get('embedding')
            
            if not embedding or not isinstance(embedding, list):
                print(f"Warning: Skipping entity {entity.get('id')} - no embedding")
                continue
            
            if len(embedding) != first_dim:
                print(f"Warning: Skipping entity {entity.get('id')} - wrong dimension: {len(embedding)} vs {first_dim}")
                continue
            
            valid_entities.append(entity)
        
        if not valid_entities:
            print("No valid entities to upsert")
            return
        
        print(f"Upserting {len(valid_entities)} entities with {first_dim}-dim embeddings")
        
        # Convert to DataFrame
        df = pd.DataFrame(valid_entities)
        
        table_name = "code_entities"
        
        try:
            # Try to open existing table
            table = self.db.open_table(table_name)
            
            # Check schema compatibility
            existing_schema = table.schema
            if 'embedding' in existing_schema.names:
                # Verify dimension matches
                try:
                    table.add(df)
                except Exception as e:
                    if "FixedSizeListType" in str(e) or "dimension" in str(e).lower():
                        print(f"Schema mismatch detected. Dropping and recreating table...")
                        self.db.drop_table(table_name)
                        table = self.db.create_table(table_name, df)
                    else:
                        raise
            else:
                table.add(df)
                
        except Exception as e:
            # Table doesn't exist - create it
            # LanceDB will infer schema from DataFrame (including correct embedding dimension!)
            print(f"Creating new table with inferred schema...")
            table = self.db.create_table(table_name, df)
    
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
    
    def delete_repository(self, repo_id: str) -> None:
        """Delete all entities for a repository"""
        try:
            table = self.db.open_table("code_entities")
            table.delete(f"repo_id = '{repo_id}'")
        except Exception as e:
            print(f"Warning: Failed to delete repo {repo_id}: {e}")
    
    def delete_by_file(self, repo_id: str, file_path: str) -> None:
        """Delete all entities for a specific file"""
        try:
            table = self.db.open_table("code_entities")
            table.delete(f"repo_id = '{repo_id}' AND file_path = '{file_path}'")
        except Exception as e:
            print(f"Warning: Failed to delete file {file_path}: {e}")
    
    def count_entities(self, repo_id: str) -> int:
        """Count total entities for a repository"""
        try:
            table = self.db.open_table("code_entities")
            results = table.search() \
                .where(f"repo_id = '{repo_id}'") \
                .to_list()
            return len(results)
        except Exception:
            return 0