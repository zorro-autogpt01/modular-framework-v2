from datetime import datetime, timezone

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
