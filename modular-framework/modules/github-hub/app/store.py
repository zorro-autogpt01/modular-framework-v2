from __future__ import annotations
import os, json, base64
from pathlib import Path
from typing import Optional, Dict, Any, List
from loguru import logger
from datetime import datetime
import uuid

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
CONFIG_PATH = DATA_DIR / "config.json"
CONN_PATH   = DATA_DIR / "connections.json"

_FERNET = None
_KEY_SRC = "GH_TOKEN_KEY"
try:
    from cryptography.fernet import Fernet
    _k = os.getenv(_KEY_SRC)
    if _k: _FERNET = Fernet(_k.encode("utf-8"))
except Exception as e:
    logger.warning(f"Fernet not available: {e}")

def _ensure_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

def _enc(value: str, key_name: str = "token") -> Dict[str,str]:
    if not value: return {}
    if _FERNET:
        ct = _FERNET.encrypt(value.encode("utf-8"))
        return {f"{key_name}_enc": base64.b64encode(ct).decode("utf-8")}
    return {f"{key_name}_plain": value}

def _dec(obj: Dict[str, Any], key_name: str = "token") -> Optional[str]:
    enc_key = f"{key_name}_enc"
    plain_key = f"{key_name}_plain"
    if obj.get(enc_key) and _FERNET:
        try:
            return _FERNET.decrypt(base64.b64decode(obj[enc_key])).decode("utf-8")
        except Exception as e:
            logger.error(f"Failed to decrypt {key_name}: {e}")
    if plain_key in obj:
        return obj[plain_key]
    return None

def _empty_store():
    return {"default_id": None, "connections": [], "subscriptions": []}

def load_all() -> Dict[str, Any]:
    _ensure_dir()
    if CONN_PATH.exists():
        try:
            with open(CONN_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if "subscriptions" not in data:
                    data["subscriptions"] = []
                return data
        except Exception:
            return _empty_store()
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
            "seen": {},
        }
        if "token_enc" in old: conn["token_enc"] = old["token_enc"]
        if "token_plain" in old: conn["token_plain"] = old["token_plain"]
        store = {"default_id": "default", "connections": [conn], "subscriptions": []}
        save_all(store)
        try: CONFIG_PATH.unlink(missing_ok=True)
        except Exception: pass
        return store
    return _empty_store()

def save_all(store: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_dir()
    if "subscriptions" not in store:
        store["subscriptions"] = []
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
            tok = _dec(c, "token") or None
            if "seen" not in c:
                c["seen"] = {}
            return {**c, "token": tok}
    return None

def upsert_connection(data: Dict[str, Any]) -> Dict[str, Any]:
    st = load_all()
    if not data.get("id"): raise ValueError("id required")
    conn = next((c for c in st["connections"] if c["id"] == data["id"]), None)
    if not conn:
        conn = {"id": data["id"], "seen": {}}
        st["connections"].append(conn)

    for k in ("repo_url", "base_url", "default_branch", "branches", "name",
              "poll_interval_sec", "watch_branches", "seen"):
        if k in data and data[k] is not None:
            conn[k] = data[k]

    if "seen" not in conn:
        conn["seen"] = {}

    if "token" in data and data["token"]:
        conn.pop("token_enc", None); conn.pop("token_plain", None)
        conn.update(_enc(data["token"], "token"))

    if not st.get("default_id"): st["default_id"] = conn["id"]
    save_all(st)
    tok = _dec(conn, "token") or None
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

# -------- Subscription management --------

def list_subscriptions(redact: bool = True) -> List[Dict[str, Any]]:
    st = load_all()
    subs = []
    for s in st.get("subscriptions", []):
        s2 = {k: v for k, v in s.items()}
        if redact:
            had_secret = ("secret_enc" in s) or ("secret_plain" in s)
            s2.pop("secret_enc", None)
            s2.pop("secret_plain", None)
            if had_secret:
                s2["secret"] = "[REDACTED]"
        subs.append(s2)
    return subs

def get_subscription(sub_id: str) -> Optional[Dict[str, Any]]:
    st = load_all()
    for s in st.get("subscriptions", []):
        if s.get("id") == sub_id:
            secret = _dec(s, "secret") or None
            return {**s, "secret": secret}
    return None

def upsert_subscription(data: Dict[str, Any]) -> Dict[str, Any]:
    st = load_all()
    if not data.get("id"):
        data["id"] = str(uuid.uuid4())
    sub_id = data["id"]
    subs = st.get("subscriptions", [])
    sub = next((s for s in subs if s["id"] == sub_id), None)

    if not sub:
        sub = {"id": sub_id, "created_at": datetime.utcnow().isoformat(), "active": True, "events": ["repo.push"]}
        subs.append(sub)

    sub["updated_at"] = datetime.utcnow().isoformat()
    for k in ("url", "events", "conn_id", "branches", "active"):
        if k in data and data[k] is not None:
            sub[k] = data[k]

    if "secret" in data and data["secret"]:
        sub.pop("secret_enc", None)
        sub.pop("secret_plain", None)
        sub.update(_enc(data["secret"], "secret"))

    save_all(st)
    secret = _dec(sub, "secret") or None
    return {**sub, "secret": secret}

def delete_subscription(sub_id: str) -> None:
    st = load_all()
    st["subscriptions"] = [s for s in st.get("subscriptions", []) if s.get("id") != sub_id]
    save_all(st)

def record_delivery(sub_id: str, timestamp: Optional[str] = None) -> None:
    st = load_all()
    for s in st.get("subscriptions", []):
        if s.get("id") == sub_id:
            s["last_delivery_at"] = timestamp or datetime.utcnow().isoformat()
            break
    save_all(st)

def update_seen_sha(conn_id: str, branch: str, sha: str) -> None:
    st = load_all()
    for c in st.get("connections", []):
        if c.get("id") == conn_id:
            if "seen" not in c:
                c["seen"] = {}
            c["seen"][branch] = sha
            save_all(st)
            break

def get_seen_sha(conn_id: str, branch: str) -> Optional[str]:
    conn = get_connection(conn_id)
    if not conn:
        return None
    return conn.get("seen", {}).get(branch)
