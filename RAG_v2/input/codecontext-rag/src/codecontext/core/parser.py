from pathlib import Path
from typing import List, Dict, Optional, Tuple
import os
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
        """Parse entire repository and extract code entities and chunks"""
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

                lang = file_data['language']
                result['language_stats'][lang] = result['language_stats'].get(lang, 0) + 1

        return result

    def parse_file(self, file_path: str, repo_root: str) -> Optional[Dict]:
        """Parse single file and extract entities + chunks"""
        language = self._detect_language(file_path)
        if not language or language not in self.parsers:
            return None

        try:
            with open(file_path, 'rb') as f:
                source_code = f.read()

            parser = self.parsers[language]
            tree = parser.parse(source_code)

            relative_path = str(Path(file_path).relative_to(repo_root))
            text = source_code.decode('utf-8', errors='replace')
            lines = text.splitlines()

            functions = self._extract_functions(tree.root_node, source_code)
            classes = self._extract_classes(tree.root_node, source_code)
            imports = self._extract_imports(tree.root_node, source_code, language)

            # Build chunks
            chunks = self._build_chunks(
                language=language,
                lines=lines,
                functions=functions,
                classes=classes
            )

            return {
                'file_path': relative_path,
                'language': language,
                'functions': functions,
                'classes': classes,
                'imports': imports,
                'lines_of_code': len(lines),
                'chunks': chunks
            }
        except Exception as e:
            print(f"Error parsing {file_path}: {e}")
            return None

    def _extract_functions(self, node: Node, source: bytes) -> List[Dict]:
        """Extract function definitions from AST (Python only currently)"""
        functions = []

        if node.type == 'function_definition':  # Python
            name_node = node.child_by_field_name('name')
            if name_node:
                functions.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
                })

        for child in node.children:
            functions.extend(self._extract_functions(child, source))

        return functions

    def _extract_classes(self, node: Node, source: bytes) -> List[Dict]:
        """Extract class definitions from AST (Python only currently)"""
        classes = []

        if node.type == 'class_definition':  # Python
            name_node = node.child_by_field_name('name')
            if name_node:
                classes.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
                })

        for child in node.children:
            classes.extend(self._extract_classes(child, source))

        return classes

    def _extract_imports(self, node: Node, source: bytes, language: str) -> List[str]:
        """Extract import statements (Python only currently)"""
        imports = []

        if language == 'python':
            if node.type in ('import_statement', 'import_from_statement'):
                imports.append(source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'))

        for child in node.children:
            imports.extend(self._extract_imports(child, source, language))

        return imports

    def _build_chunks(
        self,
        language: str,
        lines: List[str],
        functions: List[Dict],
        classes: List[Dict],
        window: int = 200,
        overlap: int = 40
    ) -> List[Dict]:
        """
        Build chunk list:
        - Python: function/class-based chunks from AST + fixed-size chunks for residual ranges.
        - Other languages: fixed-size chunks.
        Lines are zero-based as elsewhere in the app.
        """
        chunks: List[Dict] = []
        total = len(lines)

        if language == 'python':
            # Function/class chunks
            spans: List[Tuple[int, int, str, str]] = []  # (start, end, type, name)
            for fn in functions:
                spans.append((fn['start_line'], fn['end_line'], 'function', fn.get('name', '')))
            for cls in classes:
                spans.append((cls['start_line'], cls['end_line'], 'class', cls.get('name', '')))

            # Normalize and sort spans
            spans = [(max(0, s), min(total - 1, e), t, n) for (s, e, t, n) in spans]
            spans.sort(key=lambda x: (x[0], x[1]))

            # Merge overlaps if any
            merged: List[Tuple[int, int, List[Tuple[str, str]]]] = []
            for s, e, t, n in spans:
                if not merged:
                    merged.append((s, e, [(t, n)]))
                else:
                    ps, pe, meta = merged[-1]
                    if s <= pe + 1:
                        merged[-1] = (ps, max(pe, e), meta + [(t, n)])
                    else:
                        merged.append((s, e, [(t, n)]))

            covered_ranges: List[Tuple[int, int]] = []
            for s, e, meta in merged:
                code = "\n".join(lines[s:e + 1])
                chunks.append({
                    'start_line': s,
                    'end_line': e,
                    'code': code,
                    'kind': 'ast_region',
                    'entities': [{'type': t, 'name': n} for (t, n) in meta]
                })
                covered_ranges.append((s, e))

            # Residual ranges not covered by AST regions -> fixed chunks
            residuals: List[Tuple[int, int]] = self._invert_ranges(covered_ranges, 0, total - 1)
            for (rs, re) in residuals:
                for cs, ce in self._sliding_windows(rs, re, window, overlap):
                    code = "\n".join(lines[cs:ce + 1])
                    chunks.append({
                        'start_line': cs,
                        'end_line': ce,
                        'code': code,
                        'kind': 'fixed',
                        'entities': []
                    })
        else:
            # Non-Python: fixed-size chunks across the file
            for cs, ce in self._sliding_windows(0, max(0, total - 1), window, overlap):
                code = "\n".join(lines[cs:ce + 1])
                chunks.append({
                    'start_line': cs,
                    'end_line': ce,
                    'code': code,
                    'kind': 'fixed',
                    'entities': []
                })

        return chunks

    def _invert_ranges(self, ranges: List[Tuple[int, int]], start: int, end: int) -> List[Tuple[int, int]]:
        """Given sorted, non-overlapping ranges, return gaps between them over [start, end]."""
        if not ranges:
            return [(start, end)] if start <= end else []
        inv: List[Tuple[int, int]] = []
        cursor = start
        for s, e in ranges:
            if cursor < s:
                inv.append((cursor, s - 1))
            cursor = max(cursor, e + 1)
        if cursor <= end:
            inv.append((cursor, end))
        return inv

    def _sliding_windows(self, start: int, end: int, window: int, overlap: int) -> List[Tuple[int, int]]:
        """Generate [start, end]-bounded windows with the given size and overlap."""
        if start > end:
            return []
        ranges: List[Tuple[int, int]] = []
        step = max(1, window - overlap)
        i = start
        while i <= end:
            j = min(end, i + window - 1)
            ranges.append((i, j))
            if j == end:
                break
            i += step
        return ranges

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
