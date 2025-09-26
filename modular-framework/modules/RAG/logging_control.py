# modular-framework/modules/RAG/logging_control.py
from __future__ import annotations
import os, json, time, asyncio, uuid
from typing import Any, Dict, Optional
from dataclasses import dataclass, field

import httpx
from fastapi import APIRouter, Request
from starlette.middleware.base import BaseHTTPMiddleware

LEVELS = ["debug", "info", "warn", "error"]

def _now_iso():
    import datetime as _dt
    return _dt.datetime.utcnow().isoformat() + "Z"

def _level_allows(min_level: str, level: str) -> bool:
    mi = LEVELS.index((min_level or "info").lower())
    li = LEVELS.index((level or "info").lower())
    return li >= mi

def _redact_meta(obj: Any) -> Any:
    if not isinstance(obj, (dict, list)): return obj
    BAD = {"authorization","Authorization","apiKey","token","password","secret"}
    def walk(o):
        if isinstance(o, dict):
            for k,v in list(o.items()):
                if k in BAD: o[k] = "***REDACTED***"
                elif isinstance(v, (dict, list)): walk(v)
        elif isinstance(o, list):
            for i,v in enumerate(o):
                if isinstance(v, (dict, list)): walk(v)
    out = json.loads(json.dumps(obj))  # deep copy
    walk(out)
    return out

# ---------- Config ----------
@dataclass
class HecSink:
    enabled: bool = bool(os.getenv("SPLUNK_HEC_URL") and os.getenv("SPLUNK_HEC_TOKEN"))
    url: Optional[str] = os.getenv("SPLUNK_HEC_URL")
    token: Optional[str] = os.getenv("SPLUNK_HEC_TOKEN")
    source: str = os.getenv("SPLUNK_SOURCE", "rag")
    index: Optional[str] = os.getenv("SPLUNK_INDEX") or None
    timeout_ms: int = int(os.getenv("HEC_TIMEOUT_MS", "3000"))

@dataclass
class LogConfig:
    level: str = (os.getenv("LOG_LEVEL","info")).lower()
    console: bool = (os.getenv("LOG_TO_CONSOLE","true")).lower() == "true"
    buffer_max: int = int(os.getenv("LOG_MAX","1000"))
    sampling_rate: float = float(os.getenv("LOG_SAMPLING","1.0"))
    level_overrides: Dict[str,str] = field(default_factory=dict)  # {"llm":"debug", "http_access":"info"}
    fields: Dict[str,Any] = field(default_factory=lambda: {"service":"rag"})
    hec: HecSink = field(default_factory=HecSink)

    def validate(self):
        if self.level not in LEVELS:
            raise ValueError(f"invalid level {self.level}")
        if not (0 <= self.sampling_rate <= 1):
            raise ValueError("sampling_rate must be 0..1")
        if self.hec.enabled and (not self.hec.url or not self.hec.token):
            raise ValueError("hec.url and hec.token required when hec.enabled=true")
        return self

ACTIVE = LogConfig().validate()
BUFFER: list[Dict[str,Any]] = []
HTTPX: Optional[httpx.AsyncClient] = None

def _push_buffer(entry: Dict[str,Any]):
    BUFFER.append(entry)
    maxn = max(1, int(ACTIVE.buffer_max))
    while len(BUFFER) > maxn:
        BUFFER.pop(0)

def _category_min_level(category: Optional[str]) -> str:
    if category and category in ACTIVE.level_overrides:
        return ACTIVE.level_overrides[category]
    return ACTIVE.level

async def _send_hec(entry: Dict[str,Any]):
    if not ACTIVE.hec.enabled: return
    global HTTPX
    if HTTPX is None:
        HTTPX = httpx.AsyncClient(timeout=ACTIVE.hec.timeout_ms/1000)
    payload = {
        "event": {
            "level": entry["level"],
            "message": entry["msg"],
            "meta": entry.get("meta", {})
        },
        "time": int(time.time()),
        "host": ACTIVE.fields.get("host") or os.getenv("HOSTNAME") or "rag",
        "sourcetype": "_json",
        "source": ACTIVE.hec.source
    }
    if ACTIVE.hec.index: payload["index"] = ACTIVE.hec.index
    try:
        await HTTPX.post(
            ACTIVE.hec.url,
            headers={"Authorization": f"Splunk {ACTIVE.hec.token}", "Content-Type": "application/json"},
            json=payload
        )
    except Exception:
        # intentionally swallow to avoid hot-path failures
        pass

def _console_print(entry: Dict[str,Any]):
    if not ACTIVE.console: return
    line = f"[{entry['ts']}] [{entry['level'].upper()}] {entry['msg']} {json.dumps(entry.get('meta',{}), ensure_ascii=False)}"
    lvl = entry["level"]
    try:
        if lvl == "debug": print(line)
        elif lvl == "info": print(line)
        elif lvl == "warn": print(line)
        else: print(line)
    except Exception:
        pass

def log(level: str, msg: str, meta: Optional[Dict[str,Any]] = None, category: Optional[str]=None):
    # level gate + sampling
    if not _level_allows(_category_min_level(category), level): return
    if ACTIVE.sampling_rate < 1 and (uuid.uuid4().int % 10_000) / 10_000 > ACTIVE.sampling_rate: return

    entry = {
        "ts": _now_iso(),
        "level": level,
        "msg": msg if isinstance(msg,str) else json.dumps(msg, ensure_ascii=False),
        "meta": _redact_meta({**(meta or {}), **ACTIVE.fields})
    }
    _push_buffer(entry)

    # fan out; HEC async fire-and-forget
    _console_print(entry)
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(_send_hec(entry))
        else:
            asyncio.run(_send_hec(entry))
    except Exception:
        pass

def log_debug(msg, meta=None, category=None): log("debug", msg, meta, category)
def log_info (msg, meta=None, category=None): log("info",  msg, meta, category)
def log_warn (msg, meta=None, category=None): log("warn",  msg, meta, category)
def log_error(msg, meta=None, category=None): log("error", msg, meta, category)

# --------- FastAPI wiring (endpoints + middleware) ----------
router = APIRouter()

@router.get("/admin-api/logging")
async def get_logging():
    cfg = ACTIVE.__dict__.copy()
    cfg["hec"] = {**ACTIVE.hec.__dict__, "token": "***REDACTED***" if ACTIVE.hec.token else None}
    return {"effective": cfg}

@router.put("/admin-api/logging")
async def put_logging(patch: Dict[str,Any], dry_run: Optional[int] = 0):
    global ACTIVE
    # merge patch into ACTIVE
    def deepmerge(a,b):
        if not isinstance(a,dict) or not isinstance(b,dict): return b
        r = {**a}
        for k,v in b.items():
            r[k] = deepmerge(a.get(k), v)
        return r
    current = {
        "level": ACTIVE.level, "console": ACTIVE.console, "buffer_max": ACTIVE.buffer_max,
        "sampling_rate": ACTIVE.sampling_rate, "level_overrides": ACTIVE.level_overrides,
        "fields": ACTIVE.fields, "hec": ACTIVE.hec.__dict__
    }
    next_cfg = deepmerge(current, patch or {})
    try:
        new = LogConfig(
            level = next_cfg.get("level", ACTIVE.level),
            console = bool(next_cfg.get("console", ACTIVE.console)),
            buffer_max = int(next_cfg.get("buffer_max", ACTIVE.buffer_max)),
            sampling_rate = float(next_cfg.get("sampling_rate", ACTIVE.sampling_rate)),
            level_overrides = dict(next_cfg.get("level_overrides", ACTIVE.level_overrides)),
            fields = dict(next_cfg.get("fields", ACTIVE.fields)),
            hec = HecSink(**next_cfg.get("hec", ACTIVE.hec.__dict__)),
        ).validate()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    if str(dry_run) == "1":
        red = new.__dict__.copy(); red["hec"] = {**new.hec.__dict__, "token":"***REDACTED***" if new.hec.token else None}
        return {"ok": True, "dry_run": True, "next": red}
    ACTIVE = new
    red = ACTIVE.__dict__.copy(); red["hec"] = {**ACTIVE.hec.__dict__, "token":"***REDACTED***" if ACTIVE.hec.token else None}
    return {"ok": True, "effective": red}

@router.post("/admin-api/logging/test")
async def test_logging():
    log_info("logging_test", {"probe": True}, category="ops")
    return {"ok": True}

@router.post("/admin-api/logging/reload")
async def reload_from_env():
    global ACTIVE
    ACTIVE = LogConfig().validate()
    return {"ok": True}

@router.get("/admin-api/logs")
async def get_logs(limit: int = 200):
    l = max(1, min(2000, int(limit)))
    return {"items": BUFFER[-l:]}

@router.post("/admin-api/logs/clear")
async def clear_logs():
    BUFFER.clear()
    return {"ok": True}

class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = f"{int(time.time()*1000):x}-{uuid.uuid4().hex[:6]}"
        request.state.rid = rid
        # log lightweight access at end
        resp = await call_next(request)
        try:
            log_info("http_access", {
                "rid": rid,
                "path": request.url.path,
                "method": request.method,
                "status": resp.status_code,
                "ua": request.headers.get("user-agent",""),
                "ip": request.client.host if request.client else "unknown"
            }, category="http_access")
        except Exception:
            pass
        return resp

# ---- adapter that mimics your current logger.* API ----
from loguru import logger as _loguru

class AppLogger:
    def debug(self, msg): log_debug(str(msg)); _loguru.debug(msg)
    def info (self, msg): log_info (str(msg)); _loguru.info(msg)
    def warning(self, msg): log_warn(str(msg)); _loguru.warning(msg)
    def error(self, msg): log_error(str(msg)); _loguru.error(msg)
    # convenience with meta/category
    def event(self, level: str, msg: str, *, meta: Dict[str,Any]|None=None, category: str|None=None):
        level = level.lower()
        if level not in LEVELS: level = "info"
        log(level, msg, meta, category)
        getattr(_loguru, "info" if level=="info" else "debug" if level=="debug" else "warning" if level=="warn" else "error")(msg)

app_logger = AppLogger()
