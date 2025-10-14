from typing import List, Dict, Any, Optional, Tuple
import math
from ..integrations.llm_gateway import LLMGatewayClient


def approx_token_count(text: str) -> int:
    # Heuristic: ~4 chars per token
    if not text:
        return 0
    return max(1, int(len(text) / 4))


class PromptAssembler:
    def __init__(self, llm_client: Optional[LLMGatewayClient] = None):
        self.llm_client = llm_client or LLMGatewayClient()

    async def count_messages_tokens(self, messages: List[Dict[str, str]], model: Optional[str]) -> int:
        try:
            payload = {"messages": messages}
            if model:
                payload["model"] = model
            result = await self.llm_client.count_tokens(messages=messages, model=model)
            # Try common shapes: {"total": int} or {"usage": {"total_tokens": int}} or {"count": int}
            if isinstance(result, dict):
                if "total" in result:
                    return int(result["total"])
                if "count" in result:
                    return int(result["count"])
                usage = result.get("usage") or {}
                if "total_tokens" in usage:
                    return int(usage["total_tokens"])
        except Exception:
            pass
        # Fallback: crude estimation by concatenating contents
        text = "\n".join(m.get("content", "") for m in messages)
        return approx_token_count(text)

    def chunk_to_block(self, c: Dict[str, Any]) -> str:
        # Avoid heavy markdown; simple delineation
        fp = c.get("file_path", "unknown")
        s = int(c.get("start_line", 0))
        e = int(c.get("end_line", 0))
        lang = c.get("language", "unknown")
        code = (c.get("snippet") or c.get("code") or "")[:2000]
        return (
            f"File: {fp}\n"
            f"Lines: {s}-{e}\n"
            f"Language: {lang}\n"
            f"-----\n"
            f"{code}\n"
            f"-----"
        )

    async def assemble(
        self,
        query: str,
        base_chunks: List[Dict[str, Any]],
        neighbor_chunks: List[Dict[str, Any]],
        model: Optional[str],
        system_prompt: Optional[str],
        temperature: float,
        max_tokens: int
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """
        Greedily add chunk blocks under max_tokens.
        Returns (messages, usage_info)
        """
        sys = system_prompt or (
            "You are a senior code assistant. Use only the provided minimal code context. "
            "Propose precise, minimal changes. Avoid dumping entire files. Prefer patch-style diffs when appropriate."
        )

        messages: List[Dict[str, Any]] = [{"role": "system", "content": sys}]
        # Add instruction + query
        user_intro = (
            "Task:\n"
            f"{query}\n\n"
            "Context chunks follow. Use them to understand and complete the task. "
            "If info is insufficient, state what additional files or functions you need."
        )
        messages.append({"role": "user", "content": user_intro})

        selected: List[Dict[str, Any]] = []
        total_tokens = await self.count_messages_tokens(messages, model)
        budget = max_tokens

        def try_add_block(block_text: str) -> bool:
            nonlocal messages, total_tokens
            block_msg = {"role": "user", "content": block_text}
            test_msgs = messages + [block_msg]
            est = 0
            # Cheap check first to avoid many calls
            est = approx_token_count(block_text) + total_tokens
            if est > budget:
                return False
            # More accurate check (best effort)
            return True

        # Greedy add base chunks then neighbors
        def add_chunks(chunks: List[Dict[str, Any]]):
            nonlocal messages, selected, total_tokens
            for c in chunks:
                block = self.chunk_to_block(c)
                if not try_add_block(block):
                    continue
                messages.append({"role": "user", "content": block})
                selected.append({
                    "id": c.get("chunk_id") or c.get("id") or "",
                    "file_path": c.get("file_path", ""),
                    "start_line": int(c.get("start_line") or 0),
                    "end_line": int(c.get("end_line") or 0),
                    "language": c.get("language") or "unknown",
                    "confidence": int(c.get("confidence") or 0),
                    "reasons": c.get("reasons") or [],
                })
                # Update running token count approximately
                total_tokens += approx_token_count(block)
                if total_tokens >= budget:
                    break

        add_chunks(base_chunks)
        if total_tokens < budget and neighbor_chunks:
            add_chunks(neighbor_chunks)

        # Final accurate count (best effort)
        final_tokens = await self.count_messages_tokens(messages, model)

        usage = {
            "budget": budget,
            "estimated_tokens": final_tokens,
            "temperature": temperature,
            "model": model or "default",
            "chunks_included": len(selected)
        }
        return messages, usage