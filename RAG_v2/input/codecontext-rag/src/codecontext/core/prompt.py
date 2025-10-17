from typing import List, Dict, Any, Optional, Tuple
from ..integrations.llm_gateway import LLMGatewayClient

def approx_token_count(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(text) / 4))

class PromptAssembler:
    def __init__(self, llm_client: Optional[LLMGatewayClient] = None):
        self.llm_client = llm_client or LLMGatewayClient()

    async def count_messages_tokens(self, messages: List[Dict[str, str]], model: Optional[str]) -> int:
        try:
            result = await self.llm_client.count_tokens(messages=messages, model=model)
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
        text = "\n".join(m.get("content", "") for m in messages)
        return approx_token_count(text)

    def chunk_to_block(self, c: Dict[str, Any]) -> str:
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
        max_tokens: int,
        header_blocks: Optional[List[str]] = None
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """
        Greedily add:
        - system prompt
        - task intro
        - optional header blocks (hierarchical summaries)
        - chunk blocks (base then neighbor)
        """
        sys = system_prompt or (
            "You are a senior code assistant. Use only the provided minimal code context. "
            "Prefer small, precise changes and patch-style diffs. Respect layering and existing APIs."
        )
        messages: List[Dict[str, Any]] = [{"role": "system", "content": sys}]
        intro = (
            "Task:\n"
            f"{query}\n\n"
            "You will be given summaries and code snippets. Use them to complete the task. "
            "If info is insufficient, specify exact files/functions needed."
        )
        messages.append({"role": "user", "content": intro})

        total_tokens = await self.count_messages_tokens(messages, model)
        budget = max_tokens

        def try_add_block(block_text: str) -> bool:
            nonlocal total_tokens
            est = approx_token_count(block_text) + total_tokens
            if est > budget:
                return False
            total_tokens += approx_token_count(block_text)
            return True

        # Header summaries first
        if header_blocks:
            for hb in header_blocks:
                block_msg = {"role": "user", "content": f"[Summary]\n{hb}"}
                if not try_add_block(block_msg["content"]):
                    break
                messages.append(block_msg)

        # Add chunks greedily
        def add_chunks(chunks: List[Dict[str, Any]]):
            nonlocal messages
            for c in chunks:
                block = self.chunk_to_block(c)
                if not try_add_block(block):
                    continue
                messages.append({"role": "user", "content": block})
                if total_tokens >= budget:
                    break

        add_chunks(base_chunks)
        if total_tokens < budget and neighbor_chunks:
            add_chunks(neighbor_chunks)

        final_tokens = await self.count_messages_tokens(messages, model)
        usage = {
            "budget": budget,
            "estimated_tokens": final_tokens,
            "temperature": temperature,
            "model": model or "default",
            "chunks_included": sum(1 for m in messages if m.get("content", "").startswith("File: "))
        }
        return messages, usage