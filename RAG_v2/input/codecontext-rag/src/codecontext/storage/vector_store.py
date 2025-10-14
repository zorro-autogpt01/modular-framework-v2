import lancedb
from typing import List, Dict, Optional
import pyarrow as pa
import pandas as pd


class VectorStore:
    def __init__(self, path: str = "./data/lancedb"):
        """Initialize LanceDB connection"""
        self.db = lancedb.connect(path)
        self._init_tables()

    def _init_tables(self):
        """Create tables if they don't exist"""
        if "code_entities" not in self.db.table_names():
            # Schema supports chunk entities
            schema = pa.schema([
                pa.field("id", pa.string()),
                pa.field("repo_id", pa.string()),
                pa.field("file_path", pa.string()),
                pa.field("entity_type", pa.string()),  # function, class, file, chunk
                pa.field("name", pa.string()),
                pa.field("code", pa.string()),
                pa.field("language", pa.string()),
                pa.field("start_line", pa.int32()),
                pa.field("end_line", pa.int32()),
                pa.field("chunk_id", pa.string()),     # optional, for chunks
                pa.field("embedding", pa.list_(pa.float32())),  # variable-length vector
            ])
            self.db.create_table("code_entities", schema=schema)

    def upsert(self, entities: List[Dict]):
        """Upsert entities to vector store"""
        if not entities:
            return

        # Validate consistent embedding length across batch
        first = next((e for e in entities if isinstance(e.get("embedding"), list)), None)
        if not first:
            print("No valid entities to upsert")
            return
        first_dim = len(first["embedding"])

        valid_entities: List[Dict] = []
        for entity in entities:
            embedding = entity.get('embedding')
            if not embedding or not isinstance(embedding, list):
                print(f"Warning: Skipping entity {entity.get('id')} - no embedding")
                continue
            if len(embedding) != first_dim:
                print(f"Warning: Skipping entity {entity.get('id')} - wrong dimension: {len(embedding)} vs {first_dim}")
                continue
            # Ensure required minimal fields exist
            entity.setdefault('name', entity.get('name') or '')
            entity.setdefault('code', entity.get('code') or '')
            entity.setdefault('chunk_id', entity.get('chunk_id') or '')
            valid_entities.append(entity)

        if not valid_entities:
            print("No valid entities to upsert")
            return

        df = pd.DataFrame(valid_entities)

        table_name = "code_entities"
        try:
            table = self.db.open_table(table_name)
            # Align columns to the existing table schema if necessary
            try:
                table_cols = set(table.schema.names)
                df_cols = list(col for col in df.columns if col in table_cols)
                df = df[df_cols]
                table.add(df)
            except Exception as e:
                print(f"VectorStore.upsert add failed, attempting create: {e}")
                self.db.create_table(table_name, df)
        except Exception:
            # Create table with inferred schema from data frame
            self.db.create_table(table_name, df)

    def search(
        self,
        embedding: List[float],
        k: int = 10,
        filters: Optional[Dict] = None
    ) -> List[Dict]:
        """Semantic search for similar code entities"""
        table = self.db.open_table("code_entities")

        query = table.search(embedding).limit(k)

        if filters:
            if 'repo_id' in filters:
                query = query.where(f"repo_id = '{filters['repo_id']}'")
            if 'language' in filters:
                query = query.where(f"language = '{filters['language']}'")
            if 'entity_type' in filters:
                query = query.where(f"entity_type = '{filters['entity_type']}'")
            if 'file_path' in filters:
                query = query.where(f"file_path = '{filters['file_path']}'")

        results = query.to_list()
        return results

    def get_by_file(self, repo_id: str, file_path: str) -> List[Dict]:
        """Get all entities in a specific file (non-vector filter)"""
        table = self.db.open_table("code_entities")
        try:
            df = table.to_pandas()
            if df.empty:
                return []
            filtered = df[(df["repo_id"] == repo_id) & (df["file_path"] == file_path)]
            return filtered.to_dict(orient="records")
        except Exception as e:
            print(f"VectorStore.get_by_file error: {e}")
            return []

    def delete_repository(self, repo_id: str) -> None:
        """Delete all entities for a repository"""
        table = self.db.open_table("code_entities")
        table.delete(f"repo_id = '{repo_id}'")

    def delete_by_file(self, repo_id: str, file_path: str) -> None:
        """Delete all entities for a specific file"""
        table = self.db.open_table("code_entities")
        table.delete(f"repo_id = '{repo_id}' AND file_path = '{file_path}'")

    def count_entities(self, repo_id: str) -> int:
        """Count total entities for a repository"""
        table = self.db.open_table("code_entities")
        try:
            df = table.to_pandas()
            if df.empty:
                return 0
            return int((df["repo_id"] == repo_id).sum())
        except Exception as e:
            print(f"VectorStore.count_entities error: {e}")
            return 0