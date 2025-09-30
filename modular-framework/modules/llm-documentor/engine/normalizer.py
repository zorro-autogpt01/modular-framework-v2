# modular-framework/modules/llm-documentor/engine/normalizer.py
import os
import json
from typing import List, Dict, Any, Optional, Tuple


def _get_default_encoding_name() -> str:
    """
    Default tokenizer encoding name. You can override via:
      export LLM_TOKEN_ENCODING=o200k_base   (or cl100k_base, etc.)
    """
    return os.getenv("LLM_TOKEN_ENCODING", "cl100k_base")


def _estimate_tokens(text: str, encoding_name: Optional[str] = None) -> int:
    """
    Estimate token count for a text. Uses tiktoken if available; otherwise
    falls back to ~4 chars per token heuristic.
    """
    if not text:
        return 0
    try:
        import tiktoken  # type: ignore
        enc = tiktoken.get_encoding(encoding_name or _get_default_encoding_name())
        return len(enc.encode(text))
    except Exception:
        # Fallback: coarse heuristic (safe conservative rounding up)
        # 1 token ≈ 3–4 chars → use 4 to stay under budget.
        return max(1, (len(text) + 3) // 4)


class ChunkNormalizer:
    """
    Normalize and chunk artifacts for LLM consumption.

    Token-aware, mini-model friendly defaults:
      - per-chunk target ≈ 600 tokens (configurable)
      - split files when > 2,000 tokens (configurable)
      - preserve logical boundaries (def/class/function/export)
    """

    def __init__(
        self,
        artifacts: Dict[str, Any],
        *,
        per_chunk_tokens: int = None,
        split_threshold_tokens: int = None,
        encoding_name: Optional[str] = None,
        max_chunks_per_file: int = 50,
    ):
        """
        :param artifacts: extractor output
        :param per_chunk_tokens: target tokens per chunk (default 600)
        :param split_threshold_tokens: split file if tokens exceed this (default 3 * per_chunk_tokens, i.e. 1800)
        :param encoding_name: tokenizer encoding (default from env or cl100k_base)
        :param max_chunks_per_file: safety cap
        """
        self.artifacts = artifacts
        self.encoding_name = encoding_name or _get_default_encoding_name()
        self.per_chunk_tokens = per_chunk_tokens or 600
        self.split_threshold_tokens = split_threshold_tokens or (self.per_chunk_tokens * 3)
        self.max_chunks_per_file = max_chunks_per_file

    def normalize(self) -> List[Dict[str, Any]]:
        chunks: List[Dict[str, Any]] = []

        # Structure overview (as a single lightweight chunk)
        structure_text = self._format_structure(self.artifacts["structure"])
        chunks.append({
            "type": "structure",
            "content": structure_text,
            "metadata": {
                "repo": self.artifacts["meta"]["repo"],
                "branch": self.artifacts["meta"]["branch"],
                "tokens": _estimate_tokens(structure_text, self.encoding_name),
            },
        })

        # API specs (already compact; keep as-is)
        for path, spec in self.artifacts.get("api_specs", {}).items():
            content = json.dumps(spec, indent=2)
            chunks.append({
                "type": "api_spec",
                "path": path,
                "content": content,
                "metadata": {
                    "version": spec.get("version"),
                    "tokens": _estimate_tokens(content, self.encoding_name),
                },
            })

        # Source files (token-aware chunking)
        for path, file_info in self.artifacts.get("files", {}).items():
            content = file_info.get("content", "") or ""
            language = file_info.get("language")
            symbols = file_info.get("symbols")
            total_tok = _estimate_tokens(content, self.encoding_name)

            if total_tok > self.split_threshold_tokens:
                parts = self._smart_chunk_tokens(
                    content,
                    language=language,
                    max_chunk_tokens=self.per_chunk_tokens,
                )
                for i, sub in enumerate(parts[: self.max_chunks_per_file]):
                    chunks.append({
                        "type": "source",
                        "path": path,
                        "part": i + 1,
                        "content": sub,
                        "language": language,
                        "symbols": symbols,
                        "metadata": {
                            "tokens": _estimate_tokens(sub, self.encoding_name),
                            "total_file_tokens": total_tok,
                            "chunk_index": i + 1,
                            "chunks_in_file": min(len(parts), self.max_chunks_per_file),
                        },
                    })
            else:
                chunks.append({
                    "type": "source",
                    "path": path,
                    "content": content,
                    "language": language,
                    "symbols": symbols,
                    "metadata": {
                        "tokens": total_tok,
                    },
                })

        # DB schemas (usually small/medium; no chunking by default)
        for path, content in self.artifacts.get("schemas", {}).items():
            content = content or ""
            chunks.append({
                "type": "schema",
                "path": path,
                "content": content,
                "metadata": {
                    "tokens": _estimate_tokens(content, self.encoding_name),
                },
            })

        return chunks

    def _format_structure(self, node: Dict, indent: int = 0) -> str:
        lines: List[str] = []
        for name, child in (node.get("children", {}) or {}).items():
            prefix = "  " * indent
            if child["type"] == "file":
                lines.append(f"{prefix}📄 {name}")
            else:
                lines.append(f"{prefix}📁 {name}")
                lines.append(self._format_structure(child, indent + 1))
        return "\n".join(lines)

    # ---------- token-aware chunking ----------

    @staticmethod
    def _is_boundary(line: str, language: Optional[str]) -> bool:
        s = line.strip()
        if language == "python":
            return s.startswith(("def ", "class "))
        if language in ("javascript", "typescript"):
            return s.startswith(("function ", "class ", "export "))
        # extend for other langs as needed
        return False

    def _smart_chunk_tokens(
        self,
        content: str,
        language: Optional[str],
        max_chunk_tokens: int = 600,
        min_boundary_ratio: float = 0.5,
    ) -> List[str]:
        """
        Split content into chunks with a token budget, preferring to cut
        at logical boundaries when we're past a fraction of the budget.

        :param content: file text
        :param language: language hint
        :param max_chunk_tokens: target token cap per chunk
        :param min_boundary_ratio: if a boundary is found and current chunk
                                   already exceeds this *budget*, start a new chunk
        """
        lines = content.split("\n")
        chunks: List[str] = []
        cur: List[str] = []
        cur_tok = 0
        boundary_trigger = max(1, int(max_chunk_tokens * min_boundary_ratio))

        for line in lines:
            # If we meet a logical boundary and the current chunk is "substantial", cut here.
            if self._is_boundary(line, language) and cur_tok >= boundary_trigger:
                if cur:
                    chunks.append("\n".join(cur))
                cur, cur_tok = [], 0

            # Add the line
            cur.append(line)
            cur_tok += _estimate_tokens(line + "\n", self.encoding_name)

            # Hard cap on the chunk
            if cur_tok >= max_chunk_tokens:
                chunks.append("\n".join(cur))
                cur, cur_tok = [], 0

        if cur:
            chunks.append("\n".join(cur))

        return chunks
