from __future__ import annotations
from typing import Dict, List, Optional
import secrets
from datetime import datetime, timezone
import time
import threading


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class InMemoryRepositoryStore:
    def __init__(self) -> None:
        self._repos: Dict[str, dict] = {}

    def create(self, body) -> dict:
        repo_id = f"repo_{secrets.token_hex(6)}"
        item = {
            "id": repo_id,
            "name": body.name,
            "source_type": body.source_type,
            "source_url": body.source_url,
            "branch": body.branch or "main",
            "status": "registered",
            "created_at": _now(),
            "last_indexed_at": None,
            "statistics": None,
        }
        self._repos[repo_id] = item
        return item

    def list(self, status_filter: str = "all") -> List[dict]:
        items = list(self._repos.values())
        if status_filter == "all":
            return items
        return [r for r in items if r.get("status") == status_filter]

    def get(self, repo_id: str) -> Optional[dict]:
        return self._repos.get(repo_id)

    def delete(self, repo_id: str) -> bool:
        return self._repos.pop(repo_id, None) is not None


class InMemoryJobStore:
    def __init__(self, repo_store: InMemoryRepositoryStore) -> None:
        self._jobs: Dict[str, dict] = {}
        self._repo_job: Dict[str, str] = {}
        self._repo_store = repo_store

    def enqueue(self, repo_id: str, mode: str, options: dict) -> dict:
        job_id = f"job_{secrets.token_hex(6)}"
        job = {
            "job_id": job_id,
            "repo_id": repo_id,
            "status": "queued",
            "progress": {"current": 0, "total": 100, "percentage": 0.0},
            "started_at": None,
            "completed_at": None,
            "error": None,
        }
        self._jobs[job_id] = job
        self._repo_job[repo_id] = job_id
        return job

    def simulate(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if not job:
            return
        job["status"] = "running"
        job["started_at"] = _now()
        # simulate work in a background thread w/o blocking
        def _run():
            for i in range(1, 101):
                time.sleep(0.02)
                job["progress"] = {"current": i, "total": 100, "percentage": float(i)}
            job["status"] = "completed"
            job["completed_at"] = _now()
        t = threading.Thread(target=_run, daemon=True)
        t.start()

    def status_for_repo(self, repo_id: str) -> Optional[dict]:
        job_id = self._repo_job.get(repo_id)
        if not job_id:
            return None
        j = self._jobs.get(job_id)
        if not j:
            return None
        return {
            "job_id": j["job_id"],
            "status": j["status"],
            "progress": j.get("progress"),
            "started_at": j.get("started_at"),
            "completed_at": j.get("completed_at"),
            "error": j.get("error"),
        }
