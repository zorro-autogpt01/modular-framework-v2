from typing import List, Dict
import threading

try:
    from sentence_transformers import CrossEncoder
except Exception:
    CrossEncoder = None  # type: ignore

from ..config import settings

class LocalReranker:
    """
    Lightweight cross-encoder reranker. If model load fails, it becomes a no-op.
    """
    _lock = threading.Lock()
    _model = None
    _loaded_model_name = None

    @classmethod
    def _ensure_model(cls):
        if not settings.reranker_enabled:
            return
        if CrossEncoder is None:
            return
        with cls._lock:
            if cls._model is not None and cls._loaded_model_name == settings.reranker_model:
                return
            try:
                cls._model = CrossEncoder(settings.reranker_model)
                cls._loaded_model_name = settings.reranker_model
            except Exception as e:
                print(f"LocalReranker: failed to load model {settings.reranker_model}: {e}")
                cls._model = None
                cls._loaded_model_name = None

    @classmethod
    def available(cls) -> bool:
        cls._ensure_model()
        return cls._model is not None and settings.reranker_enabled

    @classmethod
    def rerank(cls, query: str, candidates: List[Dict], text_builder=None, top_k: int = None) -> List[Dict]:
        """
        candidates: list of records (with code/name/file_path). Returns re-ordered list with 'rerank_score'.
        text_builder(record) -> str to pass as text.
        """
        if not candidates:
            return []
        cls._ensure_model()
        if cls._model is None:
            # No-op
            return candidates
        tb = text_builder or (lambda c: " ".join([c.get("name") or "", c.get("file_path") or "", (c.get("code") or c.get("snippet") or "")[:512]]))
        pairs = [(query, tb(c)) for c in candidates]
        try:
            scores = cls._model.predict(pairs, convert_to_numpy=True)
        except Exception as e:
            print(f"LocalReranker: predict failed: {e}")
            return candidates
        for c, s in zip(candidates, scores):
            c["_ce"] = float(s)
        candidates = sorted(candidates, key=lambda x: x.get("_ce", 0.0), reverse=True)
        if top_k:
            candidates = candidates[:top_k]
        return candidates