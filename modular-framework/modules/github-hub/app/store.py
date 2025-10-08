# app/store.py
from __future__ import annotations
import os, json, base64
from pathlib import Path
from typing import Optional, Dict, Any, List
from loguru import logger

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
CONFIG_PATH = DATA_DIR / "config.json"          # legacy single-conn (will migrate)
CONN_PATH   = DATA_DIR / "connections.json"     # new multi-conn store

# Optional encryption (same env var as today)
_FERNET = None
_KEY_SRC = "GH_TOKEN_KEY"  # base64 urlsafe 32 bytes (Fernet key)
try:
    from cryptography.fernet import Fernet
    _k = os.getenv(_KEY_SRC)
    if _k: _FERNET = Fernet(_k.encode("utf-8"))
except Exception as e:
    logger.warning(f"Fernet not available: {e}")

def _ensure_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

def _enc(tok: str) -> Dict[str,str]:
    if not tok: return {}
    if _FERNET:
        ct = _FERNET.encrypt(tok.encode("utf-8"))
        return {"token_enc": base64.b64encode(ct).decode("utf-8")}
    return {"token_plain": tok}

def _dec(obj: Dict[str, Any]) -> Optional[str]:
    if obj.get("token_enc") and _FERNET:
        try:
            return _FERNET.decrypt(base64.b64decode(obj["token_enc"])).decode("utf-8")
        except Exception as e:
            logger.error(f"Failed to decrypt token: {e}")
    if "token_plain" in obj:
        return obj["token_plain"]
    return None

# -------- Multi-connection store --------

def _empty_store():
    return {"default_id": None, "connections": []}

def load_all() -> Dict[str, Any]:
    """Return {"default_id": str|None, "connections":[{...}]} (tokens NOT hydrated)."""
    _ensure_dir()
    if CONN_PATH.exists():
        try:
            with open(CONN_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return _empty_store()
    # migrate legacy config.json into first connection
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            return _empty_store()
        conn = {
            "id": "default",
            "repo_url": old.get("repo_url"),
            "default_branch": old.get("default_branch") or "main",
            "base_url": old.get("base_url") or "https://api.github.com",
            "branches": old.get("branches") or [],
        }
        if "token_enc" in old: conn["token_enc"] = old["token_enc"]
        if "token_plain" in old: conn["token_plain"] = old["token_plain"]
        store = {"default_id": "default", "connections": [conn]}
        save_all(store)
        try: CONFIG_PATH.unlink(missing_ok=True)
        except Exception: pass
        return store
    return _empty_store()

def save_all(store: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_dir()
    with open(CONN_PATH, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2)
    return store

def list_connections(redact: bool = True) -> List[Dict[str, Any]]:
    st = load_all()
    conns = []
    for c in st.get("connections", []):
        c2 = {k: v for k, v in c.items() if k not in ("token",)}
        if redact:
            c2.pop("token_enc", None)
            c2.pop("token_plain", None)
        conns.append(c2)
    return conns

def get_connection(conn_id: Optional[str]) -> Optional[Dict[str, Any]]:
    st = load_all()
    cid = conn_id or st.get("default_id")
    if not cid: return None
    for c in st.get("connections", []):
        if c.get("id") == cid:
            # hydrate token in-memory
            tok = _dec(c) or None
            return {**c, "token": tok}
    return None

def upsert_connection(data: Dict[str, Any]) -> Dict[str, Any]:
    """data may include: id, repo_url, base_url, default_branch, token"""
    st = load_all()
    if not data.get("id"): raise ValueError("id required")
    conn = next((c for c in st["connections"] if c["id"] == data["id"]), None)
    if not conn:
        conn = {"id": data["id"]}
        st["connections"].append(conn)

    # updatable fields
    for k in ("repo_url", "base_url", "default_branch", "branches", "name"):
        if k in data and data[k] is not None:
            conn[k] = data[k]

    # token handling (encrypt on disk)
    if "token" in data and data["token"]:
        conn.pop("token_enc", None); conn.pop("token_plain", None)
        conn.update(_enc(data["token"]))

    if not st.get("default_id"): st["default_id"] = conn["id"]
    save_all(st)
    # return hydrated
    tok = _dec(conn) or None
    return {**conn, "token": tok}

def delete_connection(conn_id: str) -> None:
    st = load_all()
    st["connections"] = [c for c in st.get("connections", []) if c.get("id") != conn_id]
    if st.get("default_id") == conn_id:
        st["default_id"] = st["connections"][0]["id"] if st["connections"] else None
    save_all(st)

def set_default(conn_id: str) -> None:
    st = load_all()
    if not any(c.get("id") == conn_id for c in st.get("connections", [])):
        raise ValueError("connection not found")
    st["default_id"] = conn_id
    save_all(st)
