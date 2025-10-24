# 🆕 NEW FILE
from __future__ import annotations
import json
from pathlib import Path
from typing import Optional, Dict
import hashlib
from datetime import datetime
from loguru import logger

class CacheManager:
    """Manage analysis cache."""
    
    def __init__(self, cache_dir: str = ".analysis-cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
    
    def get_cache_path(self, owner: str, repo: str) -> Path:
        """Get cache directory for a repo."""
        return self.cache_dir / owner / repo
    
    def generate_cache_key(self, commit_sha: str, file_list: List[str]) -> str:
        """Generate cache key from repo state."""
        file_hash = hashlib.md5(
            json.dumps(sorted(file_list)).encode()
        ).hexdigest()
        return f"{commit_sha}-{file_hash}"
    
    async def is_cache_valid(self, owner: str, repo: str, cache_key: str) -> bool:
        """Check if cache is valid."""
        try:
            cache_path = self.get_cache_path(owner, repo)
            metadata_file = cache_path / "metadata.json"
            
            if not metadata_file.exists():
                return False
            
            with open(metadata_file, 'r') as f:
                metadata = json.load(f)
            
            return metadata.get('cache_key') == cache_key
        except Exception:
            return False
    
    async def save_analysis(self, owner: str, repo: str, data: Dict):
        """Save analysis results to cache."""
        cache_path = self.get_cache_path(owner, repo)
        cache_path.mkdir(parents=True, exist_ok=True)
        
        # Save dependencies
        with open(cache_path / "dependencies.json", 'w') as f:
            json.dump(data['dependencies'], f, indent=2)
        
        # Save tokens
        with open(cache_path / "tokens.json", 'w') as f:
            json.dump(data['tokens'], f, indent=2)
        
        # Save metadata
        with open(cache_path / "metadata.json", 'w') as f:
            json.dump({
                "cache_key": data['cache_key'],
                "analyzed_at": datetime.utcnow().isoformat(),
                "commit_sha": data['commit_sha'],
                "stats": data.get('stats', {})
            }, f, indent=2)
        
        logger.info(f"✅ Saved analysis cache for {owner}/{repo}")
    
    async def load_analysis(self, owner: str, repo: str) -> Optional[Dict]:
        """Load analysis from cache."""
        try:
            cache_path = self.get_cache_path(owner, repo)
            
            with open(cache_path / "dependencies.json", 'r') as f:
                dependencies = json.load(f)
            
            with open(cache_path / "tokens.json", 'r') as f:
                tokens = json.load(f)
            
            with open(cache_path / "metadata.json", 'r') as f:
                metadata = json.load(f)
            
            return {
                "dependencies": dependencies,
                "tokens": tokens,
                "metadata": metadata
            }
        except Exception as e:
            logger.warning(f"Failed to load cache: {e}")
            return None