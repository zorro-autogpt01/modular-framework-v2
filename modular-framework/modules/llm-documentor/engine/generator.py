import os
import json
from typing import List, Dict, Any
import aiohttp

from templates import get_template

DEFAULT_LLM_GATEWAY = os.getenv('LLM_GATEWAY_URL', 'http://llm-gateway:3010/api')


class DocGenerator:
    """Generate documentation using an LLM gateway.

    Compatible with the original behavior; will use DEFAULT_LLM_GATEWAY if not passed.
    """

    def __init__(self, chunks: List[Dict[str, Any]], model_key: str, llm_gateway_url: str | None = None):
        self.chunks = chunks
        self.model_key = model_key
        self.llm_gateway_url = (llm_gateway_url or DEFAULT_LLM_GATEWAY).rstrip('/')

    async def generate(self, pack, job_id: str) -> Dict[str, str]:
        template = get_template(pack.template)
        relevant_chunks = self._filter_chunks_for_pack(pack)
        docs: Dict[str, str] = {}

        if pack.name == 'api':
            api_chunks = [c for c in relevant_chunks if c['type'] == 'api_spec']
            for chunk in api_chunks:
                doc = await self._call_llm(template, chunk)
                endpoint_group = chunk['path'].split('/')[-1].replace('.yaml', '').replace('.json', '')
                docs[f"api/{endpoint_group}.md"] = doc

        elif pack.name in ('super-detailed', 'detailed'):
            source_chunks = [c for c in relevant_chunks if c['type'] == 'source']
            components: Dict[str, List[Dict]] = {}
            for chunk in source_chunks:
                component = self._extract_component_name(chunk['path'])
                components.setdefault(component, []).append(chunk)
            for component, comp_chunks in components.items():
                context = self._merge_chunks(comp_chunks)
                doc = await self._call_llm(template, context)
                docs[f"components/{component}.md"] = doc
        else:
            context = self._merge_chunks(relevant_chunks)
            doc = await self._call_llm(template, context)
            docs[pack.output_path] = doc

        return docs

    def _filter_chunks_for_pack(self, pack) -> List[Dict]:
        name = pack.name
        if name == 'api':
            return [c for c in self.chunks if c.get('type') in ('api_spec', 'source') and 'api' in c.get('path', '').lower()]
        if name == 'db':
            return [c for c in self.chunks if c.get('type') == 'schema']
        if name in ('super-detailed', 'detailed'):
            return [c for c in self.chunks if c.get('type') == 'source']
        return self.chunks

    def _merge_chunks(self, chunks: List[Dict]) -> str:
        parts = []
        for chunk in chunks[:10]:
            t = chunk.get('type')
            if t == 'source':
                parts.append(f"=== {chunk['path']} ===\nLanguage: {chunk.get('language')}\n{chunk.get('content')[:2000]}\n")
            elif t == 'api_spec':
                parts.append(f"=== API Spec: {chunk['path']} ===\n{chunk.get('content')[:2000]}\n")
            elif t == 'schema':
                parts.append(f"=== Schema: {chunk['path']} ===\n{chunk.get('content')[:2000]}\n")
            elif t == 'structure':
                parts.append(f"=== Repository Structure ===\n{chunk.get('content')[:1000]}\n")
        return '\n'.join(parts)

    def _extract_component_name(self, path: str) -> str:
        parts = path.split('/')
        if 'modules' in parts:
            idx = parts.index('modules')
            if idx + 1 < len(parts):
                return parts[idx + 1]
        if 'src' in parts:
            idx = parts.index('src')
            if idx + 1 < len(parts):
                return parts[idx + 1]
        return parts[-2] if len(parts) > 1 else 'main'

    async def _call_llm(self, template: str, context: Any) -> str:
        if isinstance(context, dict):
            context_str = json.dumps(context, indent=2)[:8000]
        else:
            context_str = str(context)[:8000]
        prompt = template.format(context=context_str)
        messages = [
            {"role": "system", "content": "You are a technical documentation expert. Generate comprehensive, accurate documentation based on the provided code context."},
            {"role": "user", "content": prompt}
        ]
        payload = {"modelKey": self.model_key, "messages": messages, "temperature": 0.3, "max_tokens": 4000, "stream": False}

        async with aiohttp.ClientSession() as session:
            async with session.post(f"{self.llm_gateway_url}/v1/chat", json=payload) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return f"# Documentation Generation Failed\n\nError: {error_text}"
                result = await resp.json()
                return result.get('content', '# No content generated')
