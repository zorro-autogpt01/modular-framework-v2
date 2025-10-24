# app/analysis/endpoint_mapper.py
from __future__ import annotations
import yaml
import json
import re
from typing import Dict, List, Optional, Callable
from pathlib import Path
from loguru import logger

class EndpointMapper:
    """Map OpenAPI endpoints to actual code files."""
    
    def __init__(self, openapi_content: str, repo_files: List[str]):
        self.repo_files = repo_files
        self.spec = self.parse_openapi(openapi_content)
        self.endpoints = []
        
    def parse_openapi(self, content: str) -> Dict:
        """Parse OpenAPI specification from YAML or JSON."""
        try:
            # Try YAML first
            return yaml.safe_load(content)
        except Exception:
            try:
                # Try JSON
                return json.loads(content)
            except Exception as e:
                logger.error(f"Failed to parse OpenAPI spec: {e}")
                return {}
    
    def extract_endpoints(self) -> List[Dict]:
        """Extract all endpoints from OpenAPI spec."""
        endpoints = []
        
        paths = self.spec.get('paths', {})
        
        for path, methods in paths.items():
            for method, details in methods.items():
                if method.upper() in ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']:
                    endpoints.append({
                        'method': method.upper(),
                        'path': path,
                        'operation_id': details.get('operationId', ''),
                        'summary': details.get('summary', ''),
                        'description': details.get('description', ''),
                        'tags': details.get('tags', ['Other']),
                        'parameters': details.get('parameters', []),
                        'request_body': details.get('requestBody'),
                        'responses': details.get('responses', {})
                    })
        
        self.endpoints = endpoints
        logger.info(f"Extracted {len(endpoints)} endpoints from OpenAPI spec")
        return endpoints
    
    def find_handler_file(self, method: str, path: str, 
                          get_content_func: Callable) -> Optional[Dict]:
        """Find the file that handles this endpoint."""
        
        # Extract path without parameters for better matching
        clean_path = re.sub(r'\{[^}]+\}', '', path).strip('/')
        path_parts = [p for p in clean_path.split('/') if p]
        
        # Patterns to search for
        patterns = [
            # FastAPI: @app.post("/users/login") or @router.post("/login")
            rf'@(?:app|router)\.{method.lower()}\s*\(\s*["\'].*?{re.escape(path)}.*?["\']',
            rf'@(?:app|router)\.{method.lower()}\s*\(\s*["\'][^"\']*?{path_parts[-1] if path_parts else ""}[^"\']*?["\']',
            
            # Flask: @app.route("/users/login", methods=["POST"])
            rf'@(?:app|bp)\.route\s*\(\s*["\'].*?{re.escape(path)}.*?["\'].*?{method}',
            
            # Express: app.post('/users/login', handler)
            rf'app\.{method.lower()}\s*\(\s*["\'].*?{re.escape(path)}.*?["\']',
            
            # Django/DRF: path('users/login/', LoginView.as_view())
            rf'path\s*\(\s*["\'].*?{clean_path}.*?["\']',
            
            # Generic function name patterns (as fallback)
            rf'def\s+{method.lower()}_{path_parts[-1] if path_parts else ""}',
            rf'async\s+def\s+{method.lower()}_{path_parts[-1] if path_parts else ""}',
        ]
        
        # Prioritize certain file patterns
        route_keywords = ['route', 'api', 'endpoint', 'handler', 'controller', 'view', 'resource']
        
        # First pass: check files with route keywords
        prioritized_files = [f for f in self.repo_files 
                           if any(kw in f.lower() for kw in route_keywords)]
        
        for file_path in prioritized_files:
            try:
                content = get_content_func(file_path)
                
                for pattern in patterns:
                    matches = list(re.finditer(pattern, content, re.IGNORECASE | re.MULTILINE))
                    if matches:
                        logger.info(f"Found handler for {method} {path} in {file_path}")
                        return {
                            'file': file_path,
                            'content': content,
                            'match_position': matches[0].start()
                        }
            except Exception as e:
                logger.debug(f"Error checking {file_path}: {e}")
                continue
        
        # Second pass: check all remaining files
        remaining_files = [f for f in self.repo_files if f not in prioritized_files]
        
        for file_path in remaining_files:
            # Skip obvious non-route files
            if any(x in file_path.lower() for x in ['test', 'migration', 'model', '.md', '.json', '.yaml']):
                continue
                
            try:
                content = get_content_func(file_path)
                
                for pattern in patterns[:3]:  # Only try main patterns
                    if re.search(pattern, content, re.IGNORECASE | re.MULTILINE):
                        logger.info(f"Found handler for {method} {path} in {file_path}")
                        return {
                            'file': file_path,
                            'content': content
                        }
            except Exception:
                continue
        
        logger.warning(f"Handler not found for {method} {path}")
        return None
    
    def extract_function_snippet(self, content: str, endpoint_path: str, 
                                 start_pos: int = 0) -> Optional[str]:
        """Extract the handler function as a snippet."""
        
        lines = content.split('\n')
        
        # Find the decorator and function
        snippet_lines = []
        found_decorator = False
        in_function = False
        indent_level = 0
        decorator_lines = []
        
        for i, line in enumerate(lines):
            # Look for decorator
            if '@' in line and any(kw in line.lower() for kw in ['app.', 'router.', 'route']):
                found_decorator = True
                decorator_lines = [line]
                
                # Check if this is the right endpoint
                if endpoint_path.split('/')[-1] in line or re.search(r'["\'].*?' + re.escape(endpoint_path), line):
                    # Get next lines until we find the function
                    for j in range(i + 1, min(i + 20, len(lines))):
                        current = lines[j].strip()
                        
                        # Continue collecting decorators
                        if current.startswith('@'):
                            decorator_lines.append(lines[j])
                            continue
                        
                        # Found function definition
                        if current.startswith('def ') or current.startswith('async def '):
                            in_function = True
                            indent_level = len(lines[j]) - len(lines[j].lstrip())
                            snippet_lines = decorator_lines + [lines[j]]
                            
                            # Collect function body
                            for k in range(j + 1, len(lines)):
                                current_line = lines[k]
                                
                                # Check if we've left the function
                                if current_line.strip():
                                    line_indent = len(current_line) - len(current_line.lstrip())
                                    if line_indent <= indent_level:
                                        # We've exited the function
                                        break
                                
                                snippet_lines.append(current_line)
                                
                                # Limit snippet to reasonable size
                                if len(snippet_lines) > 80:
                                    snippet_lines.append('    # ... (function continues)')
                                    break
                            
                            return '\n'.join(snippet_lines)
                        
                        # If we hit another function without finding ours, reset
                        if current.startswith('def ') or current.startswith('class '):
                            break
        
        return None
    
    def get_related_imports(self, content: str) -> List[str]:
        """Extract import statements from file content."""
        imports = []
        
        # Python imports
        import_patterns = [
            r'^from\s+([\w.]+)\s+import',
            r'^import\s+([\w.]+)',
        ]
        
        for line in content.split('\n'):
            line = line.strip()
            for pattern in import_patterns:
                match = re.match(pattern, line)
                if match:
                    imports.append(match.group(1))
        
        return imports
    
    def map_endpoint_to_code(self, endpoint: Dict, dependency_graph: Dict,
                            get_content_func: Callable, 
                            get_tokens_func: Optional[Callable] = None) -> Dict:
        """Map a single endpoint to all its relevant code."""
        
        method = endpoint['method']
        path = endpoint['path']
        
        # Find handler
        handler_info = self.find_handler_file(method, path, get_content_func)
        
        if not handler_info:
            return {
                'endpoint': f"{method} {path}",
                'method': method,
                'path': path,
                'summary': endpoint.get('summary', ''),
                'tags': endpoint.get('tags', []),
                'error': 'Handler not found',
                'files': []
            }
        
        handler_file = handler_info['file']
        handler_content = handler_info['content']
        
        # Extract function snippet
        snippet = self.extract_function_snippet(
            handler_content, 
            path,
            handler_info.get('match_position', 0)
        )
        
        # Get dependencies
        direct_deps = dependency_graph.get(handler_file, [])
        
        # Build file list
        files = []
        
        # Handler file
        handler_tokens = get_tokens_func(handler_content) if get_tokens_func else len(handler_content) // 4
        
        files.append({
            'path': handler_file,
            'role': 'handler',
            'snippet': snippet or (handler_content[:500] + '\n# ...'),
            'full_content': handler_content,
            'tokens': handler_tokens,
            'lines': handler_content.count('\n') + 1,
            'imports': self.get_related_imports(handler_content)
        })
        
        # Add dependency files
        seen_files = {handler_file}
        
        for dep_file in direct_deps[:15]:  # Limit dependencies
            if dep_file in seen_files:
                continue
            
            try:
                dep_content = get_content_func(dep_file)
                dep_tokens = get_tokens_func(dep_content) if get_tokens_func else len(dep_content) // 4
                
                # Determine role
                role = self.classify_file_role(dep_file)
                
                # Create smart snippet based on role
                snippet = self.create_smart_snippet(dep_content, role)
                
                files.append({
                    'path': dep_file,
                    'role': role,
                    'snippet': snippet,
                    'full_content': dep_content,
                    'tokens': dep_tokens,
                    'lines': dep_content.count('\n') + 1,
                    'imports': self.get_related_imports(dep_content)[:5]  # Top 5 imports
                })
                
                seen_files.add(dep_file)
                
            except Exception as e:
                logger.debug(f"Could not load dependency {dep_file}: {e}")
                continue
        
        # Calculate totals
        total_tokens = sum(f['tokens'] for f in files)
        total_lines = sum(f['lines'] for f in files)
        
        return {
            'endpoint': f"{method} {path}",
            'method': method,
            'path': path,
            'summary': endpoint.get('summary', ''),
            'description': endpoint.get('description', ''),
            'tags': endpoint.get('tags', ['Other']),
            'operation_id': endpoint.get('operation_id', ''),
            'handler_file': handler_file,
            'files': files,
            'stats': {
                'total_files': len(files),
                'total_tokens': total_tokens,
                'total_lines': total_lines
            }
        }
    
    def classify_file_role(self, file_path: str) -> str:
        """Classify file role based on path and name."""
        path_lower = file_path.lower()
        
        if 'service' in path_lower:
            return 'service'
        elif 'model' in path_lower or 'schema' in path_lower:
            return 'model'
        elif 'util' in path_lower or 'helper' in path_lower:
            return 'utility'
        elif 'db' in path_lower or 'database' in path_lower or 'query' in path_lower:
            return 'database'
        elif 'auth' in path_lower and 'route' not in path_lower:
            return 'auth'
        elif 'middleware' in path_lower:
            return 'middleware'
        elif 'config' in path_lower:
            return 'config'
        elif 'test' in path_lower:
            return 'test'
        else:
            return 'dependency'
    
    def create_smart_snippet(self, content: str, role: str, max_lines: int = 30) -> str:
        """Create intelligent snippet based on file role."""
        lines = content.split('\n')
        
        if role == 'model':
            # For models, show class definitions
            snippet_lines = []
            for i, line in enumerate(lines):
                if line.strip().startswith('class ') or snippet_lines:
                    snippet_lines.append(line)
                    if len(snippet_lines) >= max_lines:
                        snippet_lines.append('    # ...')
                        break
            return '\n'.join(snippet_lines) if snippet_lines else '\n'.join(lines[:max_lines])
        
        elif role in ['service', 'utility']:
            # For services, show function signatures
            snippet_lines = []
            for line in lines:
                # Include imports, function defs, and class defs
                if (line.strip().startswith(('import ', 'from ', 'def ', 'async def ', 'class ')) or
                    (snippet_lines and len(snippet_lines) < max_lines)):
                    snippet_lines.append(line)
            return '\n'.join(snippet_lines[:max_lines]) + ('\n    # ...' if len(snippet_lines) > max_lines else '')
        
        else:
            # Default: first N lines
            return '\n'.join(lines[:max_lines]) + ('\n# ...' if len(lines) > max_lines else '')
    
    def map_all_endpoints(self, dependency_graph: Dict, 
                         get_content_func: Callable,
                         get_tokens_func: Optional[Callable] = None) -> List[Dict]:
        """Map all endpoints to their code."""
        
        if not self.endpoints:
            self.extract_endpoints()
        
        mappings = []
        
        for i, endpoint in enumerate(self.endpoints):
            logger.info(f"Mapping endpoint {i+1}/{len(self.endpoints)}: {endpoint['method']} {endpoint['path']}")
            
            mapping = self.map_endpoint_to_code(
                endpoint,
                dependency_graph,
                get_content_func,
                get_tokens_func
            )
            
            mappings.append(mapping)
        
        logger.info(f"✅ Mapped {len(mappings)} endpoints")
        return mappings