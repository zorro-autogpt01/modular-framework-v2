from __future__ import annotations
import os, json, base64
from pathlib import Path
from typing import Optional, Dict, Any
from loguru import logger

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
CONFIG_PATH = DATA_DIR / "config.json"

# Optional encryption
_FERNET = None
_KEY_SRC = "GH_TOKEN_KEY"  # base64 urlsafe 32 bytes (Fernet key)
try:
    from cryptography.fernet import Fernet, InvalidToken
    _k = os.getenv(_KEY_SRC)
    if _k:
        _FERNET = Fernet(_k.encode("utf-8"))
except Exception as e:
    logger.warning(f"Fernet not available: {e}")

def _ensure_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

def load_config() -> Dict[str, Any]:
    _ensure_dir()
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            return {}
        # decrypt token if present
        tok_enc = cfg.get("token_enc")
        if tok_enc and _FERNET:
            try:
                tok = _FERNET.decrypt(base64.b64decode(tok_enc)).decode("utf-8")
                cfg["token"] = tok
            except Exception as e:
                logger.error(f"Failed to decrypt token: {e}")
        elif "token_plain" in cfg:
            cfg["token"] = cfg["token_plain"]
        return cfg
    return {}

def save_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_dir()
    out = dict(cfg)
    tok = out.pop("token", None)
    if tok:
        if _FERNET:
            ct = _FERNET.encrypt(tok.encode("utf-8"))
            out["token_enc"] = base64.b64encode(ct).decode("utf-8")
            out.pop("token_plain", None)
        else:
            # fallback (no key provided) – store plaintext
            out["token_plain"] = tok
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    # return hydrated (includes token in-memory)
    if tok:
        out["token"] = tok
    return out
