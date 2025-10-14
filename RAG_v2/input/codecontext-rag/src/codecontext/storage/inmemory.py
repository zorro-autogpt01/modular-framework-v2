from __future__ import annotations
from typing import Dict, List, Optional
import secrets
from datetime import datetime, timezone
import time
import threading
import json
from pathlib import Path
import os
from json import JSONDecodeError


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class InMemoryRepositoryStore:
    def __init__(self, persist_path: str = "./data/repos.json") -> None:
        self._repos: Dict[str, dict] = {}
        self._persist_path = Path(persist_path)
        self._load()

    def _load(self):
        """Load repositories from disk"""
        if self._persist_path.exists():
            try:
                with open(self._persist_path, 'r') as f:
                    self._repos = json.load(f)
            except Exception as e:
                print(f"Failed to load repos: {e}")
                # Backup the corrupted file
                try:
                    bad = self._persist_path.with_suffix(self._persist_path.suffix + ".bad")
                    os.replace(self._persist_path, bad)
                    print(f"Backed up corrupted repos file to: {bad}")
                except Exception:
                    pass
                self._repos = {}
    
    def _save(self):
        """Save repositories to disk (atomic)"""
        try:
            _atomic_write_json(self._persist_path, self._repos)
        except Exception as e:
            print(f"Failed to save repos: {e}")

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
        self._save()
        return item
    
    def add(self, repo_data: dict) -> dict:
        """Add a repository directly from a dict"""
        repo_id = repo_data.get("id")
        if not repo_id:
            raise ValueError("Repository must have an 'id'")
        
        if repo_id in self._repos:
            raise ValueError(f"Repository {repo_id} already exists")
        
        item = {
            **repo_data,
            "created_at": repo_data.get("created_at") or _now()
        }
        self._repos[repo_id] = item
        self._save()
        return item
    
    def update(self, repo_id: str, updates: dict) -> Optional[dict]:
        """Update a repository"""
        if repo_id not in self._repos:
            return None
        
        self._repos[repo_id].update(updates)
        self._repos[repo_id]["updated_at"] = _now()
        self._save()
        return self._repos[repo_id]
    
    def exists(self, repo_id: str) -> bool:
        """Check if repository exists"""
        return repo_id in self._repos

    def list(self, status_filter: str = "all") -> List[dict]:
        items = list(self._repos.values())
        if status_filter == "all":
            return items
        return [r for r in items if r.get("status") == status_filter]

    def get(self, repo_id: str) -> Optional[dict]:
        return self._repos.get(repo_id)

    def delete(self, repo_id: str) -> bool:
        result = self._repos.pop(repo_id, None) is not None
        if result:
            self._save()
        return result


class InMemoryJobStore:
    def __init__(self, repo_store: InMemoryRepositoryStore, persist_path: str = "./data/jobs.json") -> None:
        self._jobs: Dict[str, dict] = {}
        self._repo_job: Dict[str, str] = {}
        self._repo_store = repo_store
        self._persist_path = Path(persist_path)
        self._load()

    def _load(self):
        """Load jobs from disk"""
        if self._persist_path.exists():
            try:
                with open(self._persist_path, 'r') as f:
                    data = json.load(f)
                    self._jobs = data.get("jobs", {})
                    self._repo_job = data.get("repo_job", {})
            except Exception as e:
                print(f"Failed to load jobs: {e}")
                # Backup corrupted file
                try:
                    bad = self._persist_path.with_suffix(self._persist_path.suffix + ".bad")
                    os.replace(self._persist_path, bad)
                    print(f"Backed up corrupted jobs file to: {bad}")
                except Exception:
                    pass
                self._jobs = {}
                self._repo_job = {}
    
    def _save(self):
        """Save jobs to disk (atomic)"""
        try:
            data = {
                "jobs": self._jobs,
                "repo_job": self._repo_job
            }
            _atomic_write_json(self._persist_path, data)
        except Exception as e:
            print(f"Failed to save jobs: {e}")

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
            "result": None,
        }
        self._jobs[job_id] = job
        self._repo_job[repo_id] = job_id
        self._save()
        return job
    
    def update_job(self, job_id: str, updates: dict) -> Optional[dict]:
        """Update a job"""
        if job_id not in self._jobs:
            return None
        
        self._jobs[job_id].update(updates)
        self._save()
        return self._jobs[job_id]
    
    def get_job(self, job_id: str) -> Optional[dict]:
        """Get a job by ID"""
        return self._jobs.get(job_id)

    def simulate(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if not job:
            return
        job["status"] = "running"
        job["started_at"] = _now()
        self._save()
        
        def _run():
            for i in range(1, 101):
                time.sleep(0.02)
                job["progress"] = {"current": i, "total": 100, "percentage": float(i)}
                if i % 10 == 0:
                    self._save()
            job["status"] = "completed"
            job["completed_at"] = _now()
            self._save()
        
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

