# src/codecontext/core/graph.py
import networkx as nx
from typing import Dict, List, Set, Optional
import re

class DependencyGraph:
    def __init__(self):
        self.graph = nx.DiGraph()
        self.repo_root = None
    
    def build_from_parsed_files(self, parsed_files: List[Dict], repo_root: str):
        """Build dependency graph from parsed file data"""
        self.repo_root = repo_root
        
        # Add all files as nodes first
        for file_data in parsed_files:
            self.add_file(file_data['file_path'])
        
        # Add edges based on imports
        for file_data in parsed_files:
            source_file = file_data['file_path']
            imports = file_data.get('imports', [])
            
            for imp in imports:
                target_file = self._resolve_import(imp, source_file, file_data['language'])
                if target_file and self.graph.has_node(target_file):
                    self.graph.add_edge(source_file, target_file)
    
    def add_file(self, file_path: str) -> None:
        """Add a file as a node in the graph"""
        self.graph.add_node(file_path, label=file_path.split('/')[-1])
    
    def dependencies_of(self, file_path: str, depth: int = 2, direction: str = "both") -> Dict:
        """Get dependencies of a file up to specified depth"""
        if not self.graph.has_node(file_path):
            return {"imports": [], "imported_by": []}
        
        result = {"imports": [], "imported_by": []}
        
        if direction in ("imports", "both"):
            # Files that this file imports (outgoing edges)
            imports = self._traverse_dependencies(file_path, depth, "out")
            result["imports"] = list(imports)
        
        if direction in ("imported_by", "both"):
            # Files that import this file (incoming edges)
            imported_by = self._traverse_dependencies(file_path, depth, "in")
            result["imported_by"] = list(imported_by)
        
        return result
    
    def _traverse_dependencies(self, start: str, depth: int, direction: str) -> Set[str]:
        """Traverse graph in specified direction up to depth"""
        visited = set()
        current_level = {start}
        
        for _ in range(depth):
            next_level = set()
            for node in current_level:
                if direction == "out":
                    neighbors = set(self.graph.successors(node))
                else:  # "in"
                    neighbors = set(self.graph.predecessors(node))
                
                new_neighbors = neighbors - visited - {start}
                next_level.update(new_neighbors)
                visited.update(new_neighbors)
            
            current_level = next_level
            if not current_level:
                break
        
        return visited
    
    def get_centrality_scores(self) -> Dict[str, float]:
        """Calculate centrality scores for all files"""
        if len(self.graph) == 0:
            return {}
        
        try:
            # PageRank centrality
            centrality = nx.pagerank(self.graph)
            return centrality
        except:
            # Fallback to degree centrality
            return nx.degree_centrality(self.graph)
    
    def find_circular_dependencies(self) -> List[List[str]]:
        """Find circular dependencies in the graph"""
        try:
            cycles = list(nx.simple_cycles(self.graph))
            return cycles
        except:
            return []
    
    def _resolve_import(self, import_stmt: str, source_file: str, language: str) -> Optional[str]:
        """Resolve import statement to actual file path"""
        if language == 'python':
            # Extract module name from import statement
            # Handle: import foo, from foo import bar, from foo.bar import baz
            match = re.search(r'from\s+([\w.]+)\s+import|import\s+([\w.]+)', import_stmt)
            if not match:
                return None
            
            module = match.group(1) or match.group(2)
            # Convert module path to file path
            # This is simplified - real implementation needs to handle __init__.py, etc.
            file_path = module.replace('.', '/') + '.py'
            
            # Check if it's a relative import
            if module.startswith('.'):
                # Resolve relative to source file
                source_dir = '/'.join(source_file.split('/')[:-1])
                file_path = f"{source_dir}/{file_path}"
            
            return file_path
        
        elif language == 'javascript':
            # Handle: import foo from './foo'
            match = re.search(r"from\s+['\"]([^'\"]+)['\"]", import_stmt)
            if not match:
                return None
            
            path = match.group(1)
            if path.startswith('.'):
                # Relative import
                source_dir = '/'.join(source_file.split('/')[:-1])
                file_path = f"{source_dir}/{path}"
                # Add extension if missing
                if not file_path.endswith(('.js', '.jsx', '.ts', '.tsx')):
                    file_path += '.js'
                return file_path
        
        return None