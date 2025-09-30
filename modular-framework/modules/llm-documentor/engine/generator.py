# engine/generator.py
import os
import json
from typing import List, Dict, Any, Optional
import aiohttp
from loguru import logger

DEFAULT_LLM_GATEWAY = os.getenv('LLM_GATEWAY_URL', 'http://llm-gateway:3010/api').rstrip('/')


class DocGenerator:
    """Generate documentation using an LLM gateway (compatible with app.py model_ref/options)."""

    def __init__(self, chunks: List[Dict[str, Any]], model_ref: Dict[str, Any], options: Optional[Dict[str, Any]] = None,
                 llm_gateway_url: Optional[str] = None):
        self.chunks = chunks
        self.model_ref = model_ref or {}
        self.options = options or {}
        self.llm_gateway_url = (llm_gateway_url or DEFAULT_LLM_GATEWAY).rstrip('/')

        # defaults
        self.temperature = self.options.get('temperature', 0.3)
        self.max_tokens = self.options.get('max_tokens', 4000)
        self.reasoning = bool(self.options.get('reasoning', False))
        self.prompt_limit = int(self.options.get('prompt_limit', 8000))

    async def generate(self, pack, job_id: str, extra_prompt: Optional[str] = None, template_override: Optional[str] = None) -> Dict[str, str]:
        template = self._load_template(template_override or pack.template)
        relevant_chunks = self._filter_chunks_for_pack(pack)
        docs: Dict[str, str] = {}

        if pack.name == 'api':
            api_chunks = [c for c in relevant_chunks if c.get('type') == 'api_spec']
            for chunk in api_chunks:
                context = self._format_context([chunk])
                prompt = self._build_prompt(template, context, extra_prompt)
                text = await self._call_llm(prompt)
                endpoint_group = chunk['path'].split('/')[-1].replace('.yaml', '').replace('.yml', '').replace('.json', '')
                docs[f"api/{endpoint_group}.md"] = text

        elif pack.name in ('super-detailed', 'detailed'):
            source_chunks = [c for c in relevant_chunks if c.get('type') == 'source']
            components: Dict[str, List[Dict[str, Any]]] = {}
            for ch in source_chunks:
                comp = self._extract_component_name(ch.get('path', 'main'))
                components.setdefault(comp, []).append(ch)
            for comp, comp_chunks in components.items():
                context = self._format_context(comp_chunks)
                prompt = self._build_prompt(template, context, extra_prompt)
                text = await self._call_llm(prompt)
                docs[f"components/{comp}.md"] = text
        else:
            context = self._format_context(relevant_chunks)
            prompt = self._build_prompt(template, context, extra_prompt)
            text = await self._call_llm(prompt)
            docs[pack.output_path] = text

        return docs

    # ---------------- template / selection ----------------

    def _load_template(self, template_name: str) -> str:
        # Same defaults as before; can be overridden by /api/templates
        templates = {
            "super_detailed.md": """You are a senior engineer documenting production systems. Only state facts grounded in the provided context.

Context:
{context}

Task: Produce super-detailed documentation for this module including:
- Purpose and responsibilities
- Public API (functions/classes) with signatures
- Preconditions, invariants, edge cases
- Error handling (exceptions, codes)
- Performance considerations and complexity
- Security and privacy considerations
- Dependencies (internal/external)
- How to test and extend

Cite sources as file:line where applicable.""",

            "high_level.md": """Create a high-level system overview based on the provided codebase:

Context:
{context}

Include:
- Problem statement and users
- Architecture overview (describe components)
- Data flow at 10,000 ft
- Security model
- Key design decisions

Format as clean Markdown suitable for stakeholders.""",

            "api_reference.md": """Generate API reference documentation from the provided specification:

Context:
{context}

For each endpoint include:
- Path, method, authentication
- Request model (fields, types, validation)
- Response models (success/error)
- Examples (curl and SDK)
- Rate limits and pagination

Format as developer-friendly Markdown.""",

            "db_schema.md": """Document the database schema from the provided SQL:

Context:
{context}

Include:
- Tables with purpose and key columns
- Relationships and foreign keys
- Indexes and their rationale
- Data retention policies
- Common query patterns

Add an ERD diagram in Mermaid format."""
        }
        return templates.get(template_name, templates["high_level.md"])

    def _filter_chunks_for_pack(self, pack) -> List[Dict[str, Any]]:
        n = pack.name
        if n == 'api':
            return [c for c in self.chunks if c.get('type') in ('api_spec', 'source') and 'api' in c.get('path', '').lower()]
        if n == 'db':
            return [c for c in self.chunks if c.get('type') == 'schema']
        if n in ('super-detailed', 'detailed'):
            return [c for c in self.chunks if c.get('type') == 'source']
        return self.chunks

    def _format_context(self, chunks: List[Dict[str, Any]]) -> str:
        parts: List[str] = []
        budget = max(1000, self.prompt_limit)  # soft cap; we’ll trim again before sending

        for ch in chunks[:25]:  # avoid insane fan-in
            t = ch.get('type')
            if t == 'source':
                s = f"=== {ch.get('path','')} ===\nLanguage: {ch.get('language')}\n{(ch.get('content') or '')[:2000]}\n"
            elif t == 'api_spec':
                s = f"=== API Spec: {ch.get('path','')} ===\n{(ch.get('content') or '')[:2000]}\n"
            elif t == 'schema':
                s = f"=== Schema: {ch.get('path','')} ===\n{(ch.get('content') or '')[:2000]}\n"
            elif t == 'structure':
                s = f"=== Repository Structure ===\n{(ch.get('content') or '')[:1000]}\n"
            else:
                s = json.dumps(ch)[:1000]
            parts.append(s)
            if sum(len(p) for p in parts) > budget:
                break
        return "\n".join(parts)

    def _build_prompt(self, template: str, context: str, extra_prompt: Optional[str]) -> str:
        core = template.format(context=context[: self.prompt_limit])
        if extra_prompt:
            return core + "\n\n---\nAdditional guidance:\n" + str(extra_prompt)[:2000]
        return core

    def _extract_component_name(self, path: str) -> str:
        parts = (path or '').split('/')
        if 'modules' in parts:
            i = parts.index('modules')
            if i + 1 < len(parts): return parts[i + 1]
        if 'src' in parts:
            i = parts.index('src')
            if i + 1 < len(parts): return parts[i + 1]
        return parts[-2] if len(parts) > 1 else 'main'

    # ---------------- LLM call ----------------

    async def _call_llm(self, prompt: str) -> str:
        """Call the gateway; handle both chat-completions and Responses pass-through."""
        messages = [
            {"role": "system", "content": "You are a technical documentation expert. Generate comprehensive, accurate documentation based on the provided code context."},
            {"role": "user", "content": prompt}
        ]

        payload: Dict[str, Any] = {
            # pass through every way to address a model — the gateway will resolve precedence
            **({ "modelId": self.model_ref.get("model_id") } if self.model_ref.get("model_id") else {}),
            **({ "modelKey": self.model_ref.get("model_key") } if self.model_ref.get("model_key") else {}),
            **({ "model": self.model_ref.get("model_name") } if self.model_ref.get("model_name") else {}),
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "reasoning": self.reasoning,
            "stream": False
        }

        url = f"{self.llm_gateway_url}/v1/chat"
        logger.debug(f"LLM POST {url} using { {k: payload[k] for k in ('modelId','modelKey','model') if k in payload} }")

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=120) as resp:
                txt = await resp.text()
                if resp.status != 200:
                    logger.error(f"Gateway error {resp.status}: {txt[:400]}")
                    return f"# Documentation Generation Failed\n\nGateway {resp.status}: {txt[:1000]}"

                # Try JSON first; if not JSON, return raw text
                try:
                    data = json.loads(txt)
                except Exception:
                    logger.warning("Gateway returned non-JSON body; using raw text head.")
                    return txt.strip() or "# No content generated"

                # Friendly extraction (handles {content}, Responses, Anthropic-like, etc.)
                content = self._pick_text_from_gateway(data).strip()
                if content:
                    return content

                # As a last resort show a short debug tail to make the issue visible in the file
                preview = json.dumps(data)[:800]
                logger.warning("LLM returned empty content; writing diagnostic note.")
                return "# No content generated\n\n> The LLM gateway returned no text. Payload head:\n\n```json\n" + preview + "\n```"

    def _pick_text_from_gateway(self, data: Any) -> str:
        """Mimics the gateway's own pick logic but works on both {content} and {raw} envelopes."""
        if not data:
            return ""

        # If gateway returned { content: "..." }
        if isinstance(data, dict) and isinstance(data.get("content"), str) and data["content"]:
            return data["content"]

        # Sometimes your gateway returns { content, raw }; prefer raw if it has structure
        payload = data.get("raw") if isinstance(data, dict) and "raw" in data else data

        # OpenAI Responses shapes
        # 1) data.output[].message.content[].output_text.text
        try:
            out = payload.get("output")
            if isinstance(out, list):
                msg = next((p for p in out if p and p.get("type") == "message"), None)
                parts = msg.get("content") if isinstance(msg, dict) else None
                if isinstance(parts, list):
                    ot = next((p for p in parts if p and p.get("type") == "output_text" and isinstance(p.get("text"), str)), None)
                    if ot and ot.get("text"):
                        return ot["text"]
                    # fallbacks: content[].text or content[].content
                    if isinstance(parts[0], dict):
                        if isinstance(parts[0].get("text"), str):
                            return parts[0]["text"]
                        if isinstance(parts[0].get("content"), str):
                            return parts[0]["content"]
        except Exception:
            pass

        # 2) Flat fields sometimes used by providers
        for key in ("text", "message", "content"):
            val = payload.get(key) if isinstance(payload, dict) else None
            if isinstance(val, str) and val:
                return val

        # 3) OpenAI chat-completions
        try:
            choices = payload.get("choices")
            if isinstance(choices, list) and choices:
                msg = choices[0].get("message") or {}
                if isinstance(msg.get("content"), str):
                    return msg["content"]
        except Exception:
            pass

        return ""
