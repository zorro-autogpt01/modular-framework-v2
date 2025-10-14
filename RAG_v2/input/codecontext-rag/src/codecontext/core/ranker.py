
from typing import List, Dict, Optional
import math

class RankingEngine:
    def __init__(
        self,
        semantic_weight: float = 0.4,
        dependency_weight: float = 0.3,
        history_weight: float = 0.2,
        recency_weight: float = 0.1
    ):
        """Initialize ranking engine with weights"""
        self.weights = {
            'semantic': semantic_weight,
            'dependency': dependency_weight,
            'history': history_weight,
            'recency': recency_weight
        }
        
        # Normalize weights to sum to 1.0
        total = sum(self.weights.values())
        self.weights = {k: v/total for k, v in self.weights.items()}
    
    def rank(
        self,
        candidates: List[Dict],
        centrality_scores: Optional[Dict[str, float]] = None,
        comodification_scores: Optional[Dict[str, float]] = None,
        recency_scores: Optional[Dict[str, float]] = None
    ) -> List[Dict]:
        """Rank candidates by combining multiple signals"""
        centrality_scores = centrality_scores or {}
        comodification_scores = comodification_scores or {}
        recency_scores = recency_scores or {}

        # Normalize centrality so that max centrality maps to 1.0
        max_centrality = max(centrality_scores.values()) if centrality_scores else 0.0
        def norm_centrality(fp: str) -> float:
            if not max_centrality:
                return 0.0
            return (centrality_scores.get(fp, 0.0) / max_centrality)

        for candidate in candidates:
            file_path = candidate.get('file_path')
            if not file_path:
                # Skip malformed
                candidate['confidence'] = 0
                candidate['reasons'] = []
                candidate['scores'] = {'semantic': 0, 'dependency': 0, 'history': 0, 'recency': 0}
                continue
            
            # 1. Semantic similarity score (from vector search)
            # Convert distance to similarity (assuming cosine distance in [0,1])
            semantic_score = candidate.get('_distance', 0.5)
            semantic_score = 1.0 - float(semantic_score)
            semantic_score = max(0.0, min(1.0, semantic_score))
            
            # 2. Dependency centrality score (normalized)
            dependency_score = norm_centrality(file_path)
            
            # 3. Co-modification/history score (assume already 0..1 if provided)
            history_score = float(comodification_scores.get(file_path, 0.5))
            history_score = max(0.0, min(1.0, history_score))
            
            # 4. Recency score (0..1)
            recency_score = float(recency_scores.get(file_path, 0.5))
            recency_score = max(0.0, min(1.0, recency_score))
            
            # Combined confidence score (0-100)
            confidence = (
                self.weights['semantic'] * semantic_score +
                self.weights['dependency'] * dependency_score +
                self.weights['history'] * history_score +
                self.weights['recency'] * recency_score
            ) * 100
            
            # Generate reasons
            reasons = []
            if semantic_score > 0.6:
                reasons.append({
                    'type': 'semantic',
                    'score': round(semantic_score, 3),
                    'explanation': self._explain_semantic(candidate, semantic_score)
                })
            
            if dependency_score > 0.4:  # lower threshold due to normalization
                reasons.append({
                    'type': 'dependency',
                    'score': round(dependency_score, 3),
                    'explanation': f"Central in dependency graph (normalized centrality: {dependency_score:.2f})"
                })
            
            if history_score > 0.6:
                reasons.append({
                    'type': 'history',
                    'score': round(history_score, 3),
                    'explanation': "Frequently modified with related changes"
                })
            
            if recency_score > 0.7:
                reasons.append({
                    'type': 'recency',
                    'score': round(recency_score, 3),
                    'explanation': f"Recently modified (score: {recency_score:.2f})"
                })
            
            candidate['confidence'] = int(round(confidence))
            candidate['reasons'] = reasons
            candidate['scores'] = {
                'semantic': semantic_score,
                'dependency': dependency_score,
                'history': history_score,
                'recency': recency_score
            }
        
        # Sort by confidence
        ranked = sorted(candidates, key=lambda x: x.get('confidence', 0), reverse=True)
        return ranked
    
    def _explain_semantic(self, candidate: Dict, score: float) -> str:
        """Generate human-readable explanation for semantic match"""
        entity_type = candidate.get('entity_type', 'code')
        name = candidate.get('name', 'unknown')
        
        if score > 0.8:
            return f"Highly relevant {entity_type} '{name}' with similar functionality"
        elif score > 0.6:
            return f"Related {entity_type} '{name}' with matching concepts"
        else:
            return f"Potentially relevant {entity_type} '{name}'"