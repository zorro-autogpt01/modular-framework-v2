# orchestrator_llm.py
import requests
import json
import sseclient
import os
from typing import Dict, List, Optional, Iterator
from pathlib import Path

class LLMGatewayClient:
    """Client for LLM Gateway module with dynamic model selection."""
    
    def __init__(
        self, 
        base_url: str = "http://localhost:8000",
        model_id: Optional[int] = None,
        model_key: Optional[str] = None,
        model_name: Optional[str] = None
    ):
        """
        Initialize client with dynamic model selection.
        
        Args:
            base_url: Gateway base URL
            model_id: Model ID (from models table)
            model_key: Model key (e.g., "openai:gpt-4o-mini")
            model_name: Model name (e.g., "claude-sonnet-4.5-20250929")
        
        Priority: model_id > model_key > model_name
        If none provided, will prompt user to select on first use.
        """
        self.base_url = base_url.rstrip("/")
        self._model_id = model_id
        self._model_key = model_key
        self._model_name = model_name
        self._model_cache = None  # Cache the selected model details
    
    def list_models(self) -> List[Dict]:
        """List all available models from gateway."""
        url = f"{self.base_url}/api/models"
        response = requests.get(url)
        response.raise_for_status()
        result = response.json()
        return result.get("items", [])
    
    def get_model_by_key(self, key: str) -> Optional[Dict]:
        """Get model details by key."""
        url = f"{self.base_url}/api/models/by-key/{key}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            result = response.json()
            return result.get("model")
        except requests.HTTPError as e:
            if e.response.status_code == 404:
                return None
            raise
    
    def get_model(self, model_id: int) -> Optional[Dict]:
        """Get model details by ID."""
        url = f"{self.base_url}/api/models/{model_id}"
        try:
            response = requests.get(url)
            response.raise_for_status()
            result = response.json()
            return result.get("model")
        except requests.HTTPError as e:
            if e.response.status_code == 404:
                return None
            raise
    
    def _resolve_model(self) -> Dict:
        """
        Resolve which model to use.
        Returns model details dict.
        """
        if self._model_cache:
            return self._model_cache
        
        # Priority 1: model_id
        if self._model_id:
            model = self.get_model(self._model_id)
            if not model:
                raise ValueError(f"Model ID {self._model_id} not found in gateway")
            self._model_cache = model
            return model
        
        # Priority 2: model_key
        if self._model_key:
            model = self.get_model_by_key(self._model_key)
            if not model:
                raise ValueError(f"Model key '{self._model_key}' not found in gateway")
            self._model_cache = model
            return model
        
        # Priority 3: model_name
        if self._model_name:
            models = self.list_models()
            matches = [m for m in models if m['model_name'] == self._model_name]
            if not matches:
                raise ValueError(f"Model name '{self._model_name}' not found in gateway")
            self._model_cache = matches[0]
            return matches[0]
        
        # No model specified - prompt user
        raise ValueError(
            "No model specified. Use --list-models to see available models, "
            "then specify via --model-id, --model-key, or --model-name"
        )
    
    def get_model_identifier(self) -> Dict[str, any]:
        """
        Get the identifier to use in chat requests.
        Returns dict with appropriate key for the chat API.
        """
        model = self._resolve_model()
        
        # Use the most specific identifier available
        if model.get('id'):
            return {"modelId": model['id']}
        elif model.get('key'):
            return {"modelKey": model['key']}
        else:
            return {"model": model['model_name']}
    
    def chat(
        self, 
        messages: List[Dict],
        temperature: float = 0.7,
        max_tokens: int = 4096,
        stream: bool = False,
        conversation_id: Optional[str] = None,
        metadata: Optional[Dict] = None
    ) -> Dict | Iterator[str]:
        """
        Send chat request to gateway using configured model.
        """
        model_id = self.get_model_identifier()
        
        payload = {
            **model_id,  # Unpack modelId/modelKey/model
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
            "conversation_id": conversation_id,
            "metadata": metadata or {}
        }
        
        url = f"{self.base_url}/api/v1/chat"
        
        if stream:
            return self._stream_chat(url, payload)
        else:
            return self._blocking_chat(url, payload)
    
    def _blocking_chat(self, url: str, payload: Dict) -> Dict:
        """Non-streaming chat request."""
        response = requests.post(url, json=payload)
        response.raise_for_status()
        return response.json()
    
    def _stream_chat(self, url: str, payload: Dict) -> Iterator[str]:
        """Streaming chat request (SSE)."""
        response = requests.post(url, json=payload, stream=True)
        response.raise_for_status()
        
        client = sseclient.SSEClient(response)
        for event in client.events():
            if event.event == "delta":
                data = json.loads(event.data)
                yield data.get("content", "")
            elif event.event == "done":
                break
            elif event.event == "error":
                raise Exception(f"Stream error: {event.data}")
    
    def dry_run(self, messages: List[Dict]) -> Dict:
        """Estimate cost without calling LLM."""
        model_id = self.get_model_identifier()
        
        payload = {
            **model_id,
            "messages": messages,
            "dry_run": True
        }
        
        url = f"{self.base_url}/api/v1/chat?dry_run=1"
        response = requests.post(url, json=payload)
        response.raise_for_status()
        return response.json()
    
    def count_tokens(self, messages: List[Dict]) -> int:
        """Count tokens for messages."""
        model = self._resolve_model()
        
        payload = {
            "model": model['model_name'],
            "messages": messages
        }
        
        url = f"{self.base_url}/api/tokens"
        response = requests.post(url, json=payload)
        response.raise_for_status()
        
        result = response.json()
        return result.get("message_tokens") or result.get("total_tokens", 0)
    
    def print_model_info(self):
        """Print information about the currently selected model."""
        model = self._resolve_model()
        print(f"\n🤖 Using Model:")
        print(f"   Name: {model['model_name']}")
        print(f"   Display: {model.get('display_name', 'N/A')}")
        print(f"   Provider: {model.get('provider_name', 'N/A')}")
        print(f"   ID: {model['id']}")
        if model.get('key'):
            print(f"   Key: {model['key']}")
        
        # Cost info
        input_cost = float(model.get('input_cost_per_million', 0))
        output_cost = float(model.get('output_cost_per_million', 0))
        currency = model.get('currency', 'USD')
        
        if input_cost > 0 or output_cost > 0:
            print(f"   Cost: ${input_cost:.2f} / ${output_cost:.2f} per 1M tokens ({currency})")


class OrchestratorLLM:
    """
    LLM-powered orchestrator that translates user intent into code extraction targets.
    Uses LLM Gateway for all model interactions.
    """
    
    def __init__(self, gateway_url: str = "http://localhost:8000"):
        self.gateway = LLMGatewayClient(gateway_url)
        self.conversation_id = None  # Track conversation for follow-ups
    
    def parse_intent(self, user_query: str, profile: Dict) -> Dict:
        """
        Parse user query into extraction plan using LLM.
        
        Args:
            user_query: Natural language query from user
            profile: Merged profile.json from both analyzers
        
        Returns:
            {
              "intent": "feature_request" | "bug_fix" | "understanding" | "performance",
              "targets": ["route or function names"],
              "hints": ["keywords to search"],
              "context_lines": 8-20,
              "reasoning": "explanation"
            }
        """
        
        # Build context from profile
        routes = list(profile['services'][0]['routes_index_hint'].keys())[:30]
        frameworks = profile['services'][0]['frameworks']
        languages = profile['languages']
        
        prompt = f"""You are a code analysis assistant helping extract relevant code for a user query.

Repository Profile:
- Languages: {', '.join(languages)}
- Frameworks: {', '.join(frameworks)}
- Available HTTP routes (sample):
{json.dumps(routes, indent=2)}

User Query: "{user_query}"

Task: Determine what code to extract to help with this query.

Output valid JSON only (no markdown, no explanation):
{{
  "intent": "feature_request" | "bug_fix" | "understanding" | "performance",
  "targets": ["array of route paths or function names"],
  "hints": ["array of keywords to search for in code"],
  "context_lines": 8-20,
  "reasoning": "brief explanation of choices"
}}

Examples:
- Query: "Add rate limiting to user creation"
  → targets: ["POST /api/users", "middleware/"], hints: ["rate_limit", "throttle", "redis"]
- Query: "How does authentication work?"
  → targets: ["POST /api/auth/login", "/api/auth/"], hints: ["auth", "token", "session"]
- Query: "Fix slow user search"
  → targets: ["GET /api/users/search"], hints: ["query", "database", "index", "performance"]

Now output JSON for the user's query."""

        messages = [{"role": "user", "content": prompt}]
        
        # Use gateway to get response
        response = self.gateway.chat(
            messages=messages,
            temperature=0.3,  # Lower for structured output
            max_tokens=1024,
            conversation_id=self.conversation_id,
            metadata={"task": "intent_parsing", "query": user_query}
        )
        
        # Extract JSON from response
        content = response.get("content", "")
        return self._extract_json(content)
    
    def expand_targets(
        self, 
        initial_targets: List[str], 
        profile: Dict
    ) -> List[str]:
        """
        Expand initial targets with related code using profile metadata.
        
        Args:
            initial_targets: Routes/functions from parse_intent
            profile: Merged profile.json
        
        Returns:
            Expanded list of targets
        """
        
        # Use endpoint_first_callees from profile
        callees_py = profile['services'][0].get('python', {}).get('endpoint_first_callees', {})
        callees_js = profile['services'][0].get('javascript', {}).get('endpoint_first_callees', {})
        
        expanded = set(initial_targets)
        
        # Add first-hop dependencies
        for target in initial_targets:
            # Check Python callees
            for key, callees in callees_py.items():
                if target in key:
                    expanded.update(callees)
            
            # Check JS callees
            for key, callees in callees_js.items():
                if target in key:
                    expanded.update(callees)
        
        # Ask LLM for semantic expansion
        routes = profile['services'][0]['routes_index_hint']
        prompt = f"""Given these initial extraction targets:
{json.dumps(initial_targets, indent=2)}

And these available routes in the codebase:
{json.dumps(list(routes.keys())[:50], indent=2)}

Should we include any additional routes for better context?

Output JSON array of additional route paths to include (max 5):
["route1", "route2", ...]

Only include routes that are directly related to the initial targets.
If no additional routes needed, return empty array: []"""

        messages = [{"role": "user", "content": prompt}]
        response = self.gateway.chat(
            messages=messages,
            temperature=0.4,
            max_tokens=512,
            conversation_id=self.conversation_id,
            metadata={"task": "target_expansion"}
        )
        
        additional = self._extract_json(response.get("content", ""))
        if isinstance(additional, list):
            expanded.update(additional)
        
        return sorted(list(expanded))
    
    def review_extraction(
        self, 
        user_query: str,
        extraction_summary: Dict
    ) -> Dict:
        """
        Review extracted code for completeness.
        
        Args:
            user_query: Original user query
            extraction_summary: {
                "files": ["list of files extracted"],
                "snippets": 10,
                "total_lines": 500
            }
        
        Returns:
            {
              "sufficient": True/False,
              "missing": ["what's missing"],
              "suggestions": ["what to add"]
            }
        """
        
        prompt = f"""User asked: "{user_query}"

We extracted this code:
- Files: {len(extraction_summary['files'])}
- Snippets: {extraction_summary['snippets']}
- Total lines: {extraction_summary['total_lines']}

Files extracted:
{json.dumps(extraction_summary['files'], indent=2)}

Is this sufficient to answer the user's query?

Output JSON:
{{
  "sufficient": true/false,
  "missing": ["what's missing if insufficient"],
  "suggestions": ["additional targets to extract"]
}}"""

        messages = [{"role": "user", "content": prompt}]
        response = self.gateway.chat(
            messages=messages,
            temperature=0.4,
            max_tokens=512,
            conversation_id=self.conversation_id,
            metadata={"task": "extraction_review"}
        )
        
        return self._extract_json(response.get("content", ""))
    
    def suggest_next_steps(
        self,
        user_query: str,
        extraction_path: str
    ) -> str:
        """
        Suggest what the user should do with the extracted code.
        
        Returns natural language suggestions.
        """
        
        prompt = f"""User asked: "{user_query}"

We've extracted relevant code to: {extraction_path}

What should the user do next? Provide 3-5 concrete next steps.

Output plain text (not JSON), keep it brief."""

        messages = [{"role": "user", "content": prompt}]
        response = self.gateway.chat(
            messages=messages,
            temperature=0.7,
            max_tokens=512,
            conversation_id=self.conversation_id,
            metadata={"task": "next_steps"}
        )
        
        return response.get("content", "")
    
    def _extract_json(self, text: str) -> Dict | List:
        """Extract JSON from LLM response, handling markdown wrappers."""
        import re
        
        # Try direct parse
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        
        # Try extracting from markdown code block
        match = re.search(r'```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass
        
        # Try finding first { or [
        for start_char in ['{', '[']:
            start = text.find(start_char)
            if start != -1:
                try:
                    return json.loads(text[start:])
                except json.JSONDecodeError:
                    pass
        
        raise ValueError(f"Failed to extract JSON from: {text[:200]}...")