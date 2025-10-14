# src/codecontext/core/ranker.py
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
        
        for candidate in candidates:
            file_path = candidate['file_path']
            
            # 1. Semantic similarity score (from vector search)
            semantic_score = candidate.get('_distance', 0.0)
            # Convert distance to similarity (assuming cosine distance)
            semantic_score = 1.0 - semantic_score
            
            # 2. Dependency centrality score
            dependency_score = 0.5  # Default
            if centrality_scores and file_path in centrality_scores:
                dependency_score = centrality_scores[file_path]
            
            # 3. Co-modification/history score
            history_score = 0.5  # Default
            if comodification_scores and file_path in comodification_scores:
                history_score = comodification_scores[file_path]
            
            # 4. Recency score
            recency_score = 0.5  # Default
            if recency_scores and file_path in recency_scores:
                recency_score = recency_scores[file_path]
            
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
                    'score': semantic_score,
                    'explanation': self._explain_semantic(candidate, semantic_score)
                })
            
            if dependency_score > 0.6:
                reasons.append({
                    'type': 'dependency',
                    'score': dependency_score,
                    'explanation': f"Central in dependency graph (score: {dependency_score:.2f})"
                })
            
            if history_score > 0.6:
                reasons.append({
                    'type': 'history',
                    'score': history_score,
                    'explanation': f"Frequently modified with similar features"
                })
            
            if recency_score > 0.7:
                reasons.append({
                    'type': 'recency',
                    'score': recency_score,
                    'explanation': f"Recently modified (score: {recency_score:.2f})"
                })
            
            candidate['confidence'] = int(confidence)
            candidate['reasons'] = reasons
            candidate['scores'] = {
                'semantic': semantic_score,
                'dependency': dependency_score,
                'history': history_score,
                'recency': recency_score
            }
        
        # Sort by confidence
        ranked = sorted(candidates, key=lambda x: x['confidence'], reverse=True)
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