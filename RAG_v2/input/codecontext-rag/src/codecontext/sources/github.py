# src/codecontext/sources/github.py

from typing import List, Dict, Optional
from ..integrations.github_hub import GitHubHubClient
from ..core.parser import CodeParser

class GitHubRepositorySource:
    """Repository source that fetches from GitHub Hub"""
    
    def __init__(self, conn_id: str, branch: str = None):
        self.conn_id = conn_id
        self.branch = branch
        self.client = GitHubHubClient(conn_id=conn_id)
        self.parser = CodeParser()
    
    async def list_files(self, path: str = "") -> List[Dict]:
        """List all source files in repository"""
        tree = await self.client.get_tree(
            path=path,
            branch=self.branch,
            recursive=True
        )
        
        # Filter to source files only
        source_extensions = {'.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.go', '.rs'}
        source_files = []
        
        for item in tree.get("items", []):
            if item["type"] == "blob":  # File, not directory
                file_path = item["path"]
                if any(file_path.endswith(ext) for ext in source_extensions):
                    source_files.append(item)
        
        return source_files
    
    async def get_file_content(self, path: str) -> str:
        """Get decoded file content"""
        file_data = await self.client.get_file(path, branch=self.branch)
        return file_data.get("decoded_content", "")
    
    async def parse_repository(self) -> Dict:
        """Parse entire repository from GitHub"""
        files = await self.list_files()
        
        result = {
            'files': [],
            'total_files': 0,
            'total_functions': 0,
            'total_classes': 0,
            'language_stats': {}
        }
        
        for file_item in files:
            path = file_item["path"]
            
            try:
                # Get file content
                content = await self.get_file_content(path)
                
                # Detect language
                language = self.parser._detect_language(path)
                if not language:
                    continue
                
                # Parse using Tree-sitter
                # (We need to adapt parser to work with string content)
                parsed = self._parse_content(path, content, language)
                
                if parsed:
                    result['files'].append(parsed)
                    result['total_files'] += 1
                    result['total_functions'] += len(parsed.get('functions', []))
                    result['total_classes'] += len(parsed.get('classes', []))
                    
                    # Update language stats
                    result['language_stats'][language] = \
                        result['language_stats'].get(language, 0) + 1
            
            except Exception as e:
                print(f"Error parsing {path}: {e}")
                continue
        
        return result
    
    def _parse_content(self, path: str, content: str, language: str) -> Optional[Dict]:
        """Parse file content directly (without filesystem)"""
        # Use Tree-sitter to parse string content
        parser = self.parser.parsers.get(language)
        if not parser:
            return None
        
        try:
            tree = parser.parse(content.encode('utf-8'))
            source_bytes = content.encode('utf-8')
            
            return {
                'file_path': path,
                'language': language,
                'functions': self.parser._extract_functions(tree.root_node, source_bytes),
                'classes': self.parser._extract_classes(tree.root_node, source_bytes),
                'imports': self.parser._extract_imports(tree.root_node, source_bytes, language),
                'lines_of_code': len(content.splitlines()),
            }
        except Exception as e:
            print(f"Parse error for {path}: {e}")
            return None
    
    async def close(self):
        """Cleanup"""
        await self.client.close()