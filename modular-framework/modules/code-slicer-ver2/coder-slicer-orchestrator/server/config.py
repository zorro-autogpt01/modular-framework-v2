# modular-framework/modules/code-slicer-orchestrator/server/config.py
import os
import json
from pathlib import Path
from typing import Optional, Dict

class Config:
    """Configuration management."""
    
    def __init__(self, config_path: Optional[str] = None):
        self.config_path = Path(config_path) if config_path else (
            Path(os.getenv('DATA_DIR', '/app/data')) / 'config.json'
        )
        self._data = self._load()
    
    def _load(self) -> Dict:
        """Load config from file."""
        if self.config_path.exists():
            try:
                return json.loads(self.config_path.read_text())
            except Exception:
                pass
        return self._defaults()
    
    def _defaults(self) -> Dict:
        """Default configuration."""
        return {
            "gateway_url": os.getenv('LLM_GATEWAY_URL', 'http://llm-gateway:3010'),
            "default_model": None,
            "data_dir": os.getenv('DATA_DIR', '/app/data')
        }
    
    def save(self):
        """Save config to file."""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(json.dumps(self._data, indent=2))
    
    @property
    def gateway_url(self) -> str:
        return self._data.get('gateway_url', self._defaults()['gateway_url'])
    
    @gateway_url.setter
    def gateway_url(self, value: str):
        self._data['gateway_url'] = value
    
    @property
    def default_model(self) -> Optional[Dict]:
        return self._data.get('default_model')
    
    @default_model.setter
    def default_model(self, value: Optional[Dict]):
        self._data['default_model'] = value
    
    @property
    def data_dir(self) -> str:
        return self._data.get('data_dir', self._defaults()['data_dir'])
    
    def to_dict(self) -> Dict:
        return dict(self._data)