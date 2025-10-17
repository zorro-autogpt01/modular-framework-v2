import json
import os
from typing import Dict

class LTRStore:
    """
    Very simple per-repo learning-to-rank weight store.
    Adjusts ranking weights slightly based on feedback and repo signals.
    """
    def __init__(self, base_dir: str = "./data/ltr"):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)

    def _path(self, repo_id: str) -> str:
        return os.path.join(self.base_dir, f"{repo_id}.json")

    def load(self, repo_id: str) -> Dict[str, float]:
        p = self._path(repo_id)
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return {}
        return {}

    def save(self, repo_id: str, weights: Dict[str, float]) -> None:
        p = self._path(repo_id)
        try:
            with open(p, "w", encoding="utf-8") as f:
                json.dump(weights, f, indent=2)
        except Exception as e:
            print(f"LTRStore: failed to save {repo_id}: {e}")

    def update_with_feedback(self, repo_id: str, positives, negatives, centrality_scores, recency_scores):
        """
        Naive update: increase dependency weight if positive files are central, increase recency if recent, etc.
        """
        w = self.load(repo_id) or {"semantic": 0.4, "dependency": 0.3, "history": 0.2, "recency": 0.1}
        def avg(vals):
            vals = [v for v in vals if isinstance(v, (int, float))]
            return sum(vals)/len(vals) if vals else 0.0

        pos_cent = avg([centrality_scores.get(fp, 0.0) for fp in (positives or [])])
        pos_rec = avg([recency_scores.get(fp, 0.0) for fp in (positives or [])])
        neg_cent = avg([centrality_scores.get(fp, 0.0) for fp in (negatives or [])])
        neg_rec = avg([recency_scores.get(fp, 0.0) for fp in (negatives or [])])

        # Small nudges
        w["dependency"] = max(0.05, min(0.8, w.get("dependency", 0.3) + 0.05*(pos_cent - neg_cent)))
        w["recency"]    = max(0.05, min(0.8, w.get("recency", 0.1) + 0.05*(pos_rec - neg_rec)))
        # Renormalize
        total = w["semantic"] + w["dependency"] + w["history"] + w["recency"]
        for k in list(w.keys()):
            w[k] = w[k]/total
        self.save(repo_id, w)
        return w