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

            if language == 'python':
                functions = self._extract_functions_py(tree.root_node, source_code)
                classes = self._extract_classes_py(tree.root_node, source_code)
                imports = self._extract_imports_py(tree.root_node, source_code)
            elif language == 'javascript':
                functions = self._extract_functions_js(tree.root_node, source_code)
                classes = self._extract_classes_js(tree.root_node, source_code)
                imports = self._extract_imports_js(tree.root_node, source_code)
            elif language == 'java':
                functions = self._extract_functions_java(tree.root_node, source_code)
                classes = self._extract_classes_java(tree.root_node, source_code)
                imports = self._extract_imports_java(tree.root_node, source_code)
            else:
                functions, classes, imports = [], [], []

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

    # ---------------- Python extractors ----------------

    def _extract_functions_py(self, node: Node, source: bytes) -> List[Dict]:
        functions: List[Dict] = []
        if node.type == 'function_definition':
            name_node = node.child_by_field_name('name')
            if name_node:
                functions.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
                })
        for child in node.children:
            functions.extend(self._extract_functions_py(child, source))
        return functions

    def _extract_classes_py(self, node: Node, source: bytes) -> List[Dict]:
        classes: List[Dict] = []
        if node.type == 'class_definition':
            name_node = node.child_by_field_name('name')
            if name_node:
                classes.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
                })
        for child in node.children:
            classes.extend(self._extract_classes_py(child, source))
        return classes

    def _extract_imports_py(self, node: Node, source: bytes) -> List[str]:
        imports: List[str] = []
        if node.type in ('import_statement', 'import_from_statement'):
            imports.append(source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'))
        for child in node.children:
            imports.extend(self._extract_imports_py(child, source))
        return imports

    # ---------------- JavaScript/TypeScript extractors ----------------

    def _extract_functions_js(self, node: Node, source: bytes) -> List[Dict]:
        """
        Extract function-like constructs:
        - function_declaration
        - method_definition (class methods)
        - lexical_declaration const foo = () => {}
        """
        out: List[Dict] = []
        t = node.type

        def add(name_node: Optional[Node], start: int, end: int):
            if not name_node:
                # Try to infer for anonymous arrows; skip if unknown
                return
            name = source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace')
            out.append({
                'name': name,
                'start_line': start,
                'end_line': end,
                'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
            })

        if t == 'function_declaration':
            name_node = node.child_by_field_name('name')
            add(name_node, node.start_point[0], node.end_point[0])

        if t == 'method_definition':
            # method_definition: has 'name' field or 'property_identifier'
            name_node = node.child_by_field_name('name')
            if not name_node:
                # fallback: first child with identifier-like
                for ch in node.children:
                    if ch.type in ('property_identifier', 'identifier'):
                        name_node = ch
                        break
            add(name_node, node.start_point[0], node.end_point[0])

        # const foo = () => {} or const foo = function() {}
        if t == 'lexical_declaration':
            # Look for variable_declarator with identifier and initializer an arrow_function or function
            for ch in node.children:
                if ch.type == 'variable_declarator':
                    id_node = ch.child_by_field_name('name')
                    init = ch.child_by_field_name('value')
                    if init and init.type in ('arrow_function', 'function'):
                        if id_node:
                            out.append({
                                'name': source[id_node.start_byte:id_node.end_byte].decode('utf-8', errors='replace'),
                                'start_line': ch.start_point[0],
                                'end_line': ch.end_point[0],
                                'code': source[ch.start_byte:ch.end_byte].decode('utf-8', errors='replace'),
                            })

        for c in node.children:
            out.extend(self._extract_functions_js(c, source))
        return out

    def _extract_classes_js(self, node: Node, source: bytes) -> List[Dict]:
        out: List[Dict] = []
        if node.type == 'class_declaration':
            name_node = node.child_by_field_name('name')
            if name_node:
                out.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
                })
        for c in node.children:
            out.extend(self._extract_classes_js(c, source))
        return out

    def _extract_imports_js(self, node: Node, source: bytes) -> List[str]:
        out: List[str] = []
        # tree-sitter-javascript uses 'import_statement'
        if node.type == 'import_statement':
            out.append(source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'))
        for c in node.children:
            out.extend(self._extract_imports_js(c, source))
        return out

    # ---------------- Java extractors ----------------

    def _extract_functions_java(self, node: Node, source: bytes) -> List[Dict]:
        out: List[Dict] = []
        if node.type in ('method_declaration', 'constructor_declaration'):
            # Name under 'name' field (identifier)
            name_node = node.child_by_field_name('name')
            if name_node:
                out.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
                })
        for c in node.children:
            out.extend(self._extract_functions_java(c, source))
        return out

    def _extract_classes_java(self, node: Node, source: bytes) -> List[Dict]:
        out: List[Dict] = []
        if node.type == 'class_declaration':
            name_node = node.child_by_field_name('name')
            if name_node:
                out.append({
                    'name': source[name_node.start_byte:name_node.end_byte].decode('utf-8', errors='replace'),
                    'start_line': node.start_point[0],
                    'end_line': node.end_point[0],
                    'code': source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'),
                })
        for c in node.children:
            out.extend(self._extract_classes_java(c, source))
        return out

    def _extract_imports_java(self, node: Node, source: bytes) -> List[str]:
        out: List[str] = []
        if node.type == 'import_declaration':
            out.append(source[node.start_byte:node.end_byte].decode('utf-8', errors='replace'))
        for c in node.children:
            out.extend(self._extract_imports_java(c, source))
        return out

    # ---------------- Chunking ----------------

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
        - Python/JS/Java: function/class-based chunks from AST + fixed-size chunks for residual ranges.
        - Other languages: fixed-size chunks.
        Lines are zero-based as elsewhere in the app.
        """
        chunks: List[Dict] = []
        total = len(lines)

        if language in ('python', 'javascript', 'java'):
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
            # Non-target languages: fixed-size chunks across the file
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