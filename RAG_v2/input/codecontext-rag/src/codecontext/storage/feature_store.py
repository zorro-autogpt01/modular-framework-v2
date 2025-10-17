# src/codecontext/storage/feature_store.py
import json
import sqlite3
from pathlib import Path
from typing import List, Dict, Optional
from datetime import datetime
import threading

from ..features.extractor import Feature

class FeatureStore:
    """
    Storage for product features and enhancement suggestions
    
    Uses SQLite for simplicity and portability
    """
    
    def __init__(self, db_path: str = "./data/features.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._init_db()
    
    def _get_conn(self):
        """Thread-safe connection getter"""
        if not hasattr(self._local, 'conn'):
            self._local.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn
    
    def _init_db(self):
        """Initialize database schema"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        # Features table (extracted from code)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS features (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                category TEXT,
                code_files TEXT,  -- JSON array
                api_endpoints TEXT,  -- JSON array
                ui_components TEXT,  -- JSON array
                maturity TEXT,
                confidence REAL,
                embedding BLOB,  -- Serialized vector
                created_at TEXT,
                updated_at TEXT,
                UNIQUE(repo_id, name)
            )
        """)
        
        # Feature suggestions table (from PM/Marketer)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS feature_suggestions (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                rationale TEXT,
                market_evidence TEXT,  -- JSON
                priority TEXT,  -- critical, high, medium, low
                effort_estimate TEXT,  -- small, medium, large, xl
                dependencies TEXT,  -- JSON array of feature IDs
                status TEXT,  -- proposed, approved, in_progress, completed, rejected
                proposed_by TEXT,  -- Agent name or user
                embedding BLOB,
                created_at TEXT,
                updated_at TEXT
            )
        """)
        
        # Conversation threads (multi-agent discussions)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS feature_conversations (
                id TEXT PRIMARY KEY,
                feature_suggestion_id TEXT,
                repo_id TEXT,
                agent_role TEXT,
                message TEXT,
                reasoning TEXT,  -- Internal agent reasoning
                metadata TEXT,  -- JSON
                created_at TEXT,
                FOREIGN KEY (feature_suggestion_id) REFERENCES feature_suggestions(id)
            )
        """)
        
        # Agent analysis results
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS agent_analyses (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                agent_role TEXT NOT NULL,
                analysis_type TEXT,  -- feature_assessment, market_analysis, etc.
                summary TEXT,
                details TEXT,  -- JSON
                created_at TEXT
            )
        """)
        
        # Create indexes
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_features_repo ON features(repo_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_suggestions_repo ON feature_suggestions(repo_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_suggestions_status ON feature_suggestions(status)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_conversations_suggestion ON feature_conversations(feature_suggestion_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_analyses_repo ON agent_analyses(repo_id)")
        
        conn.commit()
    
    # Features CRUD
    
    def save_features(self, features: List[Feature]) -> int:
        """Save extracted features (upsert)"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        now = datetime.utcnow().isoformat() + "Z"
        saved = 0
        
        for feature in features:
            try:
                # Serialize embedding
                embedding_blob = None
                if feature.embedding:
                    import pickle
                    embedding_blob = pickle.dumps(feature.embedding)
                
                cursor.execute("""
                    INSERT INTO features (
                        id, repo_id, name, description, category,
                        code_files, api_endpoints, ui_components,
                        maturity, confidence, embedding, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        description=excluded.description,
                        code_files=excluded.code_files,
                        api_endpoints=excluded.api_endpoints,
                        ui_components=excluded.ui_components,
                        maturity=excluded.maturity,
                        confidence=excluded.confidence,
                        embedding=excluded.embedding,
                        updated_at=excluded.updated_at
                """, (
                    feature.id,
                    feature.repo_id,
                    feature.name,
                    feature.description,
                    feature.category,
                    json.dumps(feature.code_files),
                    json.dumps(feature.api_endpoints),
                    json.dumps(feature.ui_components),
                    feature.maturity,
                    feature.confidence,
                    embedding_blob,
                    now,
                    now
                ))
                saved += 1
            except Exception as e:
                print(f"Error saving feature {feature.id}: {e}")
        
        conn.commit()
        return saved
    
    def get_features(
        self,
        repo_id: str,
        category: Optional[str] = None,
        min_confidence: float = 0.0
    ) -> List[Dict]:
        """Get features for a repository"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        query = "SELECT * FROM features WHERE repo_id = ? AND confidence >= ?"
        params = [repo_id, min_confidence]
        
        if category:
            query += " AND category = ?"
            params.append(category)
        
        query += " ORDER BY confidence DESC, name ASC"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        
        return [self._row_to_feature_dict(row) for row in rows]
    
    def get_feature(self, feature_id: str) -> Optional[Dict]:
        """Get single feature by ID"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM features WHERE id = ?", (feature_id,))
        row = cursor.fetchone()
        
        return self._row_to_feature_dict(row) if row else None
    
    def delete_features_by_repo(self, repo_id: str) -> int:
        """Delete all features for a repository"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        cursor.execute("DELETE FROM features WHERE repo_id = ?", (repo_id,))
        deleted = cursor.rowcount
        conn.commit()
        
        return deleted
    
    # Suggestions CRUD
    
    def save_suggestion(self, suggestion: Dict) -> str:
        """Save a feature suggestion"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        now = datetime.utcnow().isoformat() + "Z"
        suggestion_id = suggestion.get('id', f"sug_{now.replace(':', '').replace('-', '')}")
        
        # Serialize embedding if present
        embedding_blob = None
        if 'embedding' in suggestion and suggestion['embedding']:
            import pickle
            embedding_blob = pickle.dumps(suggestion['embedding'])
        
        cursor.execute("""
            INSERT INTO feature_suggestions (
                id, repo_id, title, description, rationale,
                market_evidence, priority, effort_estimate,
                dependencies, status, proposed_by, embedding,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                description=excluded.description,
                rationale=excluded.rationale,
                market_evidence=excluded.market_evidence,
                priority=excluded.priority,
                effort_estimate=excluded.effort_estimate,
                dependencies=excluded.dependencies,
                status=excluded.status,
                embedding=excluded.embedding,
                updated_at=excluded.updated_at
        """, (
            suggestion_id,
            suggestion['repo_id'],
            suggestion['title'],
            suggestion.get('description', ''),
            suggestion.get('rationale', ''),
            json.dumps(suggestion.get('market_evidence', {})),
            suggestion.get('priority', 'medium'),
            suggestion.get('effort_estimate', 'medium'),
            json.dumps(suggestion.get('dependencies', [])),
            suggestion.get('status', 'proposed'),
            suggestion.get('proposed_by', 'PM Agent'),
            embedding_blob,
            now,
            now
        ))
        
        conn.commit()
        return suggestion_id
    
    def get_suggestions(
        self,
        repo_id: str,
        status: Optional[str] = None,
        priority: Optional[str] = None
    ) -> List[Dict]:
        """Get feature suggestions"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        query = "SELECT * FROM feature_suggestions WHERE repo_id = ?"
        params = [repo_id]
        
        if status:
            query += " AND status = ?"
            params.append(status)
        
        if priority:
            query += " AND priority = ?"
            params.append(priority)
        
        query += " ORDER BY created_at DESC"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        
        return [self._row_to_suggestion_dict(row) for row in rows]
    
    def update_suggestion_status(
        self,
        suggestion_id: str,
        status: str
    ) -> bool:
        """Update suggestion status"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        now = datetime.utcnow().isoformat() + "Z"
        cursor.execute("""
            UPDATE feature_suggestions 
            SET status = ?, updated_at = ?
            WHERE id = ?
        """, (status, now, suggestion_id))
        
        conn.commit()
        return cursor.rowcount > 0
    
    # Conversations
    
    def save_conversation_message(
        self,
        feature_suggestion_id: str,
        repo_id: str,
        agent_role: str,
        message: str,
        reasoning: Optional[str] = None,
        metadata: Optional[Dict] = None
    ) -> str:
        """Save a conversation message"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        now = datetime.utcnow().isoformat() + "Z"
        msg_id = f"msg_{now.replace(':', '').replace('-', '')}"
        
        cursor.execute("""
            INSERT INTO feature_conversations (
                id, feature_suggestion_id, repo_id, agent_role,
                message, reasoning, metadata, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            msg_id,
            feature_suggestion_id,
            repo_id,
            agent_role,
            message,
            reasoning or '',
            json.dumps(metadata or {}),
            now
        ))
        
        conn.commit()
        return msg_id
    
    def get_conversation(
        self,
        feature_suggestion_id: str
    ) -> List[Dict]:
        """Get conversation history for a suggestion"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT * FROM feature_conversations
            WHERE feature_suggestion_id = ?
            ORDER BY created_at ASC
        """, (feature_suggestion_id,))
        
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    
    # Agent analyses
    
    def save_analysis(
        self,
        repo_id: str,
        agent_role: str,
        analysis_type: str,
        summary: str,
        details: Dict
    ) -> str:
        """Save an agent analysis"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        now = datetime.utcnow().isoformat() + "Z"
        analysis_id = f"analysis_{now.replace(':', '').replace('-', '')}"
        
        cursor.execute("""
            INSERT INTO agent_analyses (
                id, repo_id, agent_role, analysis_type,
                summary, details, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            analysis_id,
            repo_id,
            agent_role,
            analysis_type,
            summary,
            json.dumps(details),
            now
        ))
        
        conn.commit()
        return analysis_id
    
    def get_analyses(
        self,
        repo_id: str,
        agent_role: Optional[str] = None
    ) -> List[Dict]:
        """Get agent analyses"""
        conn = self._get_conn()
        cursor = conn.cursor()
        
        query = "SELECT * FROM agent_analyses WHERE repo_id = ?"
        params = [repo_id]
        
        if agent_role:
            query += " AND agent_role = ?"
            params.append(agent_role)
        
        query += " ORDER BY created_at DESC"
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        
        return [dict(row) for row in rows]
    
    # Helper methods
    
    def _row_to_feature_dict(self, row) -> Dict:
        """Convert DB row to feature dict"""
        feature = dict(row)
        
        # Deserialize JSON fields
        feature['code_files'] = json.loads(feature['code_files']) if feature['code_files'] else []
        feature['api_endpoints'] = json.loads(feature['api_endpoints']) if feature['api_endpoints'] else []
        feature['ui_components'] = json.loads(feature['ui_components']) if feature['ui_components'] else []
        
        # Deserialize embedding
        if feature['embedding']:
            import pickle
            feature['embedding'] = pickle.loads(feature['embedding'])
        
        return feature
    
    def _row_to_suggestion_dict(self, row) -> Dict:
        """Convert DB row to suggestion dict"""
        suggestion = dict(row)
        
        # Deserialize JSON fields
        suggestion['market_evidence'] = json.loads(suggestion['market_evidence']) if suggestion['market_evidence'] else {}
        suggestion['dependencies'] = json.loads(suggestion['dependencies']) if suggestion['dependencies'] else []
        
        # Deserialize embedding
        if suggestion['embedding']:
            import pickle
            suggestion['embedding'] = pickle.loads(suggestion['embedding'])
        
        return suggestion