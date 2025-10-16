import json
import time
from typing import Any, Optional

try:
    import redis  # type: ignore
    HAS_REDIS = True
except Exception:
    HAS_REDIS = False


class BaseCache:
    def get(self, key: str) -> Optional[Any]:
        raise NotImplementedError

    def set(self, key: str, value: Any, ttl: int = 3600) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        return

    def ping(self) -> bool:
        return False


class InMemoryCache(BaseCache):
    def __init__(self):
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Optional[Any]:
        now = time.time()
        item = self._store.get(key)
        if not item:
            return None
        expires, value = item
        if expires and expires < now:
            # expired
            try:
                del self._store[key]
            except Exception:
                pass
            return None
        return value

    def set(self, key: str, value: Any, ttl: int = 3600) -> None:
        expires = time.time() + max(1, ttl)
        self._store[key] = (expires, value)

    def ping(self) -> bool:
        return True  # in-memory always "ok"


class RedisCache(BaseCache):
    def __init__(self, url: str):
        self._url = url
        self._client = redis.Redis.from_url(url, decode_responses=True)

    def get(self, key: str) -> Optional[Any]:
        raw = self._client.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return raw

    def set(self, key: str, value: Any, ttl: int = 3600) -> None:
        try:
            raw = json.dumps(value)
        except Exception:
            raw = str(value)
        self._client.setex(key, ttl, raw)

    def ping(self) -> bool:
        try:
            return bool(self._client.ping())
        except Exception:
            return False

    async def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass


def get_cache(redis_url: str) -> BaseCache:
    if HAS_REDIS:
        try:
            cache = RedisCache(redis_url)
            if cache.ping():
                return cache
        except Exception:
            pass
    # fallback
    return InMemoryCache()