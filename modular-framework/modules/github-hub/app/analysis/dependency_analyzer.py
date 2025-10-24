# 🆕 NEW FILE
from __future__ import annotations
import re
from pathlib import Path
from typing import Dict, List, Set, Optional
from loguru import logger

class DependencyAnalyzer:
    """Analyze file dependencies across multiple languages."""
    
    def __init__(self, file_list: List[str]):
        self.file_list = file_list
        self.dependencies: Dict[str, List[str]] = {}
        self.reverse_deps: Dict[str, List[str]] = {}
        self.errors: List[Dict] = []

    def analyze_file(self, path: str, content: str) -> List[str]:
        """Extract imports/dependencies from a file based on extension."""
        ext = Path(path).suffix
        
        try:
            if ext in ['.js', '.jsx', '.ts', '.tsx']:
                return self._analyze_js_ts(content)
            elif ext == '.py':
                return self._analyze_python(content)
            elif ext == '.go':
                return self._analyze_go(content)
            else:
                return []
        except Exception as e:
            self.errors.append({"file": path, "error": str(e)})
            return []

    def _analyze_js_ts(self, content: str) -> List[str]:
        """Extract JavaScript/TypeScript imports."""
        imports = set()
        
        # import X from 'module'
        for match in re.finditer(r"import\s+.*?\s+from\s+['\"]([^'\"]+)['\"]", content):
            imports.add(match.group(1))
        
        # import('module')
        for match in re.finditer(r"import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", content):
            imports.add(match.group(1))
        
        # require('module')
        for match in re.finditer(r"require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", content):
            imports.add(match.group(1))
        
        # export from
        for match in re.finditer(r"export\s+.*?\s+from\s+['\"]([^'\"]+)['\"]", content):
            imports.add(match.group(1))
        
        return list(imports)

    def _analyze_python(self, content: str) -> List[str]:
        """Extract Python imports."""
        imports = set()
        
        # import module
        for match in re.finditer(r"^import\s+([\w.]+)", content, re.MULTILINE):
            imports.add(match.group(1))
        
        # from module import ...
        for match in re.finditer(r"^from\s+([\w.]+)\s+import", content, re.MULTILINE):
            imports.add(match.group(1))
        
        return list(imports)

    def _analyze_go(self, content: str) -> List[str]:
        """Extract Go imports."""
        imports = set()
        
        # Single import
        for match in re.finditer(r'^import\s+"([^"]+)"', content, re.MULTILINE):
            imports.add(match.group(1))
        
        # Import block
        in_block = False
        for line in content.split('\n'):
            line = line.strip()
            if line == 'import (':
                in_block = True
                continue
            if in_block:
                if line == ')':
                    in_block = False
                    continue
                match = re.match(r'"([^"]+)"', line)
                if match:
                    imports.add(match.group(1))
        
        return list(imports)

    def resolve_import(self, from_file: str, import_path: str) -> Optional[str]:
        """Resolve relative imports to actual file paths."""
        # Skip external packages
        if not import_path.startswith('.') and not import_path.startswith('/'):
            return None
        
        from_dir = str(Path(from_file).parent)
        resolved = Path(from_dir) / import_path
        
        # Try different extensions
        extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.go']
        
        for ext in extensions:
            candidate = str(resolved) + ext
            if candidate in self.file_list:
                return candidate
        
        # Try index files
        for ext in extensions:
            index_file = str(resolved / f'index{ext}')
            if index_file in self.file_list:
                return index_file
        
        return None

    def analyze_all(self, get_content_func) -> Dict:
        """Analyze all files and build dependency graph."""
        logger.info(f"Analyzing {len(self.file_list)} files...")
        
        analyzed_count = 0
        for file_path in self.file_list:
            ext = Path(file_path).suffix
            if ext not in ['.js', '.jsx', '.ts', '.tsx', '.py', '.go']:
                continue
            
            try:
                content = get_content_func(file_path)
                imports = self.analyze_file(file_path, content)
                
                resolved = []
                for imp in imports:
                    resolved_path = self.resolve_import(file_path, imp)
                    if resolved_path:
                        resolved.append(resolved_path)
                
                self.dependencies[file_path] = resolved
                analyzed_count += 1
                
                # Build reverse dependencies
                for dep in resolved:
                    if dep not in self.reverse_deps:
                        self.reverse_deps[dep] = []
                    self.reverse_deps[dep].append(file_path)
                
            except Exception as e:
                self.errors.append({"file": file_path, "error": str(e)})
        
        logger.info(f"✅ Analyzed {analyzed_count} files")
        
        return {
            "dependencies": self.dependencies,
            "reverse_dependencies": self.reverse_deps,
            "errors": self.errors,
            "stats": {
                "total_files": len(self.dependencies),
                "total_dependencies": sum(len(deps) for deps in self.dependencies.values()),
                "files_with_deps": sum(1 for deps in self.dependencies.values() if deps),
            }
        }

    def find_circular_dependencies(self) -> List[List[str]]:
        """Find circular dependency chains."""
        circles = []
        visited = set()
        rec_stack = []

        def dfs(file: str):
            if file in rec_stack:
                circle_start = rec_stack.index(file)
                circles.append(rec_stack[circle_start:] + [file])
                return
            if file in visited:
                return
            
            visited.add(file)
            rec_stack.append(file)
            
            for dep in self.dependencies.get(file, []):
                dfs(dep)
            
            rec_stack.pop()

        for file in self.dependencies.keys():
            dfs(file)
        
        return circles