# app/analysis/fastapi_parser.py
"""Parse FastAPI routes from Python source code without running the app."""

import re
import ast
from typing import List, Dict, Optional
from loguru import logger


class FastAPIRouteParser:
    """Extract FastAPI endpoints from Python source code."""
    
    def __init__(self):
        self.routes = []
    
    def parse_file(self, content: str, file_path: str) -> List[Dict]:
        """Parse FastAPI routes from a single Python file."""
        routes = []
        
        try:
            tree = ast.parse(content)
        except SyntaxError as e:
            logger.warning(f"Could not parse {file_path}: {e}")
            return routes
        
        # Find all function definitions with decorators
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                route_info = self._extract_route_from_function(node, file_path)
                if route_info:
                    routes.append(route_info)
        
        return routes
    
    def _extract_route_from_function(self, func_node: ast.FunctionDef, file_path: str) -> Optional[Dict]:
        """Extract route information from a function with FastAPI decorators."""
        
        for decorator in func_node.decorator_list:
            route_info = self._parse_decorator(decorator, func_node, file_path)
            if route_info:
                return route_info
        
        return None
    
    def _parse_decorator(self, decorator, func_node: ast.FunctionDef, file_path: str) -> Optional[Dict]:
        """Parse a FastAPI route decorator."""
        
        # Handle @app.get(), @app.post(), etc.
        if isinstance(decorator, ast.Call):
            if isinstance(decorator.func, ast.Attribute):
                # Get HTTP method
                method = decorator.func.attr.upper()
                
                if method not in ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']:
                    return None
                
                # Get path (first argument)
                if decorator.args and isinstance(decorator.args[0], ast.Constant):
                    path = decorator.args[0].value
                else:
                    return None
                
                # Get tags from keywords
                tags = []
                summary = ''
                
                for keyword in decorator.keywords:
                    if keyword.arg == 'tags':
                        if isinstance(keyword.value, ast.List):
                            tags = [
                                elt.value for elt in keyword.value.elts 
                                if isinstance(elt, ast.Constant)
                            ]
                    elif keyword.arg == 'summary':
                        if isinstance(keyword.value, ast.Constant):
                            summary = keyword.value.value
                
                # Get docstring as description
                description = ast.get_docstring(func_node) or ''
                
                # Get function name
                operation_id = func_node.name
                
                return {
                    'method': method,
                    'path': path,
                    'operation_id': operation_id,
                    'summary': summary or description.split('\n')[0] if description else '',
                    'description': description,
                    'tags': tags or ['Other'],
                    'file': file_path,
                    'line': func_node.lineno
                }
        
        return None
    
    def parse_repository(self, file_list: List[str], get_content_func) -> List[Dict]:
        """Parse all Python files in a repository to find FastAPI routes."""
        
        all_routes = []
        
        # Filter to Python files that likely contain routes
        python_files = [
            f for f in file_list 
            if f.endswith('.py') and 
            any(keyword in f for keyword in ['main.py', 'route', 'api', 'endpoint', 'app.py'])
        ]
        
        logger.info(f"Scanning {len(python_files)} Python files for FastAPI routes...")
        
        for file_path in python_files:
            try:
                content = get_content_func(file_path)
                
                # Quick check if this file has FastAPI decorators
                if '@app.' not in content and '@router.' not in content:
                    continue
                
                routes = self.parse_file(content, file_path)
                all_routes.extend(routes)
                
                if routes:
                    logger.info(f"Found {len(routes)} routes in {file_path}")
                    
            except Exception as e:
                logger.warning(f"Error parsing {file_path}: {e}")
                continue
        
        logger.info(f"✅ Found {len(all_routes)} total FastAPI routes")
        return all_routes
    
    def routes_to_openapi(self, routes: List[Dict]) -> Dict:
        """Convert parsed routes to OpenAPI format."""
        
        paths = {}
        
        for route in routes:
            path = route['path']
            method = route['method'].lower()
            
            if path not in paths:
                paths[path] = {}
            
            paths[path][method] = {
                'summary': route['summary'],
                'description': route['description'],
                'operationId': route['operation_id'],
                'tags': route['tags'],
                'responses': {
                    '200': {
                        'description': 'Successful Response'
                    }
                }
            }
        
        openapi_spec = {
            'openapi': '3.0.0',
            'info': {
                'title': 'API',
                'version': '1.0.0',
                'description': 'Auto-generated from FastAPI code'
            },
            'paths': paths
        }
        
        return openapi_spec


def parse_fastapi_routes(file_list: List[str], get_content_func) -> Dict:
    """
    Parse FastAPI routes from Python files and return OpenAPI spec.
    
    Args:
        file_list: List of file paths in the repository
        get_content_func: Function to get file content by path
    
    Returns:
        OpenAPI specification dict
    """
    parser = FastAPIRouteParser()
    routes = parser.parse_repository(file_list, get_content_func)
    openapi_spec = parser.routes_to_openapi(routes)
    return openapi_spec