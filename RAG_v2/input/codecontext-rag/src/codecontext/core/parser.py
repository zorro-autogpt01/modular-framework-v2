# src/codecontext/core/parser.py
import os
from pathlib import Path
from typing import List, Dict, Optional
import tree_sitter_python
import tree_sitter_javascript
import tree_sitter_java
from tree_sitter import Language, Parser, Node

class CodeParser:
    def __init__(self):
        # Load language grammars
        self.languages = {
            'python': Language(tree_sitter_python.language()),
            'javascript': Language(tree_sitter_javascript.language()),
            'java': Language(tree_sitter_java.language()),
        }
        self.parsers = {
            lang: Parser(lang_obj) 
            for lang, lang_obj in self.languages.items()
        }
        
    def parse_repository(self, repo_path: str) -> Dict:
        """Parse entire repository and extract code entities"""
        result = {
            'files': [],
            'total_files': 0,
            'total_functions': 0,
            'total_classes': 0,
            'language_stats': {}
        }
        
        for file_path in self._find_source_files(repo_path):
            file_data = self.parse_file(file_path, repo_path)
            if file_data:
                result['files'].append(file_data)
                result['total_files'] += 1
                result['total_functions'] += len(file_data['functions'])
                result['total_classes'] += len(file_data['classes'])
        
        return result
    
    def parse_file(self, file_path: str, repo_root: str) -> Optional[Dict]:
        """Parse single file and extract entities"""
        language = self._detect_language(file_path)
        if not language or language not in self.parsers:
            return None
            
        try:
            with open(file_path, 'rb') as f:
                source_code = f.read()
            
            tree = self.parsers[language].parse(source_code)
            
            relative_path = str(Path(file_path).relative_to(repo_root))
            
            return {
                'file_path': relative_path,
                'language': language,
                'functions': self._extract_functions(tree.root_node, source_code),
                'classes': self._extract_classes(tree.root_node, source_code),
                'imports': self._extract_imports(tree.root_node, source_code, language),
                'lines_of_code': len(source_code.decode('utf-8').splitlines()),
            }
        except Exception as e:
            print(f"Error parsing {file_path}: {e}")
            return None
    
    def _extract_functions(self, node: Node, source: bytes) -> List[Dict]:
        """Extract function definitions from AST"""
        functions = []
        
        if node.type == 'function_definition':  # Python
            name_node = node.child_by_field_name('name')
            if name_node:
                functions.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8'),
                })
        
        for child in node.children:
            functions.extend(self._extract_functions(child, source))
        
        return functions
    
    def _extract_classes(self, node: Node, source: bytes) -> List[Dict]:
        """Extract class definitions from AST"""
        classes = []
        
        if node.type == 'class_definition':  # Python
            name_node = node.child_by_field_name('name')
            if name_node:
                classes.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                })
        
        for child in node.children:
            classes.extend(self._extract_classes(child, source))
        
        return classes
    
    def _extract_imports(self, node: Node, source: bytes, language: str) -> List[str]:
        """Extract import statements"""
        imports = []
        
        if language == 'python':
            if node.type in ('import_statement', 'import_from_statement'):
                imports.append(source[node.start_byte:node.end_byte].decode('utf-8'))
        
        for child in node.children:
            imports.extend(self._extract_imports(child, source, language))
        
        return imports
    
    def _detect_language(self, file_path: str) -> Optional[str]:
        """Detect programming language from file extension"""
        ext_map = {
            '.py': 'python',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'javascript',
            '.tsx': 'javascript',
            '.java': 'java',
        }
        ext = Path(file_path).suffix
        return ext_map.get(ext)
    
    def _find_source_files(self, repo_path: str) -> List[str]:
        """Find all source code files in repository"""
        extensions = {'.py', '.js', '.jsx', '.ts', '.tsx', '.java'}
        exclude_dirs = {'node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build'}
        
        files = []
        for root, dirs, filenames in os.walk(repo_path):
            # Remove excluded directories
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            
            for filename in filenames:
                if Path(filename).suffix in extensions:
                    files.append(os.path.join(root, filename))
        
        return files