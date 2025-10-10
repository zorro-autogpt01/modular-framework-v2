from __future__ import annotations
import base64
from typing import Dict, Any, List, Optional, Tuple
import requests
from urllib.parse import urlparse

class GHClient:
    def __init__(self, token: Optional[str] = None, base_url: str = "https://api.github.com"):
        self.token = token or None
        self.base_url = base_url.rstrip("/")

    def _h(self):
        h = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    @staticmethod
    def parse_repo(url: str) -> Tuple[str, str]:
        """
        Supports:
          - https://github.com/owner/repo(.git)
          - https://ghe.company.tld/org/repo(.git)
          - git@github.com:owner/repo(.git)
        Returns (owner, repo) or raises ValueError.
        """
        if not url or not isinstance(url, str):
            raise ValueError("repo_url is required")
        u = url.strip()
        # SSH style: git@host:owner/repo.git
        if "@" in u and ":" in u and not u.startswith("http"):
            try:
                path = u.split(":", 1)[1]
                parts = [p for p in path.split("/") if p]
                if len(parts) < 2:
                    raise ValueError
                owner, repo = parts[-2], parts[-1].removesuffix(".git")
                return owner, repo
            except Exception as e:
                raise ValueError(f"Invalid SSH repo URL: {url}") from e
        # HTTP(S) style
        try:
            parsed = urlparse(u)
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) < 2:
                raise ValueError
            owner, repo = parts[-2], parts[-1].removesuffix(".git")
            return owner, repo
        except Exception as e:
            raise ValueError(f"Invalid repo URL: {url}") from e

    # ----- simple endpoints -----
    def get_branches(self, owner: str, repo: str, per_page: int = 100, max_pages: int = 20) -> List[str]:
        """List branches with pagination to avoid truncation on large repos."""
        names: List[str] = []
        seen = set()
        for page in range(1, max_pages + 1):
            r = requests.get(
                f"{self.base_url}/repos/{owner}/{repo}/branches",
                headers=self._h(),
                params={"per_page": per_page, "page": page},
                timeout=30,
            )
            if r.status_code == 404:
                # Return clean 404 error
                r.raise_for_status()
            r.raise_for_status()
            batch = r.json() or []
            for b in batch:
                n = b.get("name")
                if n and n not in seen:
                    seen.add(n)
                    names.append(n)
            if len(batch) < per_page:
                break
        return names

    def get_branch_sha(self, owner: str, repo: str, branch: str) -> str:
        r = requests.get(f"{self.base_url}/repos/{owner}/{repo}/branches/{branch}", headers=self._h(), timeout=20)
        if r.status_code == 404:
            r.raise_for_status()
        r.raise_for_status()
        return r.json()["commit"]["sha"]

    def get_tree(self, owner: str, repo: str, branch: str, recursive: bool = True) -> Dict[str, Any]:
        sha = self.get_branch_sha(owner, repo, branch)
        url = f"{self.base_url}/repos/{owner}/{repo}/git/trees/{sha}"
        if recursive:
            url += "?recursive=1"
        r = requests.get(url, headers=self._h(), timeout=60)
        r.raise_for_status()
        return r.json()

    def get_file(self, owner: str, repo: str, path: str, ref: Optional[str] = None) -> Dict[str, Any]:
        params = {"ref": ref} if ref else None
        r = requests.get(f"{self.base_url}/repos/{owner}/{repo}/contents/{path}", headers=self._h(), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        content_b64 = data.get("content") or ""
        if content_b64:
            # GitHub base64 can include newlines; handle safely
            try:
                decoded = base64.b64decode(content_b64.encode("utf-8")).decode("utf-8", errors="ignore")
            except Exception:
                decoded = ""
        else:
            decoded = ""
        return {**data, "decoded_content": decoded}

    def put_file(self, owner: str, repo: str, path: str, message: str, content: str, branch: Optional[str], sha: Optional[str]) -> Dict[str, Any]:
        payload = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("utf-8"),
        }
        if branch: payload["branch"] = branch
        if sha: payload["sha"] = sha
        r = requests.put(f"{self.base_url}/repos/{owner}/{repo}/contents/{path}", headers=self._h(), json=payload, timeout=60)
        r.raise_for_status()
        return r.json()

    def delete_file(self, owner: str, repo: str, path: str, message: str, sha: str, branch: Optional[str]) -> Dict[str, Any]:
        payload = {"message": message, "sha": sha}
        if branch: payload["branch"] = branch
        r = requests.delete(f"{self.base_url}/repos/{owner}/{repo}/contents/{path}", headers=self._h(), json=payload, timeout=30)
        r.raise_for_status()
        return r.json()

    def create_branch(self, owner: str, repo: str, new_branch: str, from_branch: str) -> Dict[str, Any]:
        base_sha = self.get_branch_sha(owner, repo, from_branch)
        payload = {"ref": f"refs/heads/{new_branch}", "sha": base_sha}
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/refs", headers=self._h(), json=payload, timeout=30)
        r.raise_for_status()
        return r.json()

    # Pull requests
    def create_pull_request(self, owner: str, repo: str, title: str, head: str, base: str, body: Optional[str] = None, draft: bool = False) -> Dict[str, Any]:
        payload = {"title": title, "head": head, "base": base}
        if body: payload["body"] = body
        if draft: payload["draft"] = True
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/pulls", headers=self._h(), json=payload, timeout=60)
        r.raise_for_status()
        return r.json()

    # ----- batch commit (single commit for many files) -----
    def get_commit_and_tree(self, owner: str, repo: str, branch: str) -> tuple[str, str]:
        ref = requests.get(f"{self.base_url}/repos/{owner}/{repo}/git/ref/heads/{branch}", headers=self._h(), timeout=30)
        ref.raise_for_status()
        commit_sha = ref.json()["object"]["sha"]
        commit = requests.get(f"{self.base_url}/repos/{owner}/{repo}/git/commits/{commit_sha}", headers=self._h(), timeout=30)
        commit.raise_for_status()
        tree_sha = commit.json()["tree"]["sha"]
        return commit_sha, tree_sha

    def create_blob(self, owner: str, repo: str, content: str, encoding: str = "utf-8") -> str:
        payload = {"content": content, "encoding": encoding}
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/blobs", headers=self._h(), json=payload, timeout=30)
        r.raise_for_status()
        return r.json()["sha"]

    def create_tree(self, owner: str, repo: str, base_tree: str, entries: List[Dict[str, Any]]) -> str:
        payload = {"base_tree": base_tree, "tree": entries}
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/trees", headers=self._h(), json=payload, timeout=30)
        r.raise_for_status()
        return r.json()["sha"]

    def create_commit(self, owner: str, repo: str, message: str, tree_sha: str, parents: List[str]) -> str:
        payload = {"message": message, "tree": tree_sha, "parents": parents}
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/commits", headers=self._h(), json=payload, timeout=30)
        r.raise_for_status()
        return r.json()["sha"]

    def update_ref(self, owner: str, repo: str, branch: str, new_sha: str) -> Dict[str, Any]:
        payload = {"sha": new_sha, "force": False}
        r = requests.patch(f"{self.base_url}/repos/{owner}/{repo}/git/refs/heads/{branch}", headers=self._h(), json=payload, timeout=30)
        r.raise_for_status()
        return r.json()

    def compare_commits(self, owner: str, repo: str, base: str, head: str) -> Dict[str, Any]:
        r = requests.get(
            f"{self.base_url}/repos/{owner}/{repo}/compare/{base}...{head}",
            headers=self._h(), timeout=60
        )
        r.raise_for_status()
        return r.json()

    def list_commits(self, owner: str, repo: str, sha: Optional[str] = None,
                     path: Optional[str] = None, per_page: int = 100) -> List[Dict[str, Any]]:
        params = {"sha": sha, "path": path, "per_page": per_page}
        params = {k: v for k, v in params.items() if v is not None}
        r = requests.get(
            f"{self.base_url}/repos/{owner}/{repo}/commits",
            headers=self._h(), params=params, timeout=60
        )
        r.raise_for_status()
        return r.json()

    def batch_commit(self, owner: str, repo: str, branch: str, message: str, changes: List[Dict[str, str]]) -> Dict[str, Any]:
        """
        changes: [{ "path": "dir/file.txt", "content": "string", "mode": "100644" }]
        """
        commit_sha, base_tree = self.get_commit_and_tree(owner, repo, branch)
        tree_entries = []
        for ch in changes:
            blob_sha = self.create_blob(owner, repo, ch["content"], "utf-8")
            tree_entries.append({
                "path": ch["path"],
                "mode": ch.get("mode", "100644"),
                "type": "blob",
                "sha": blob_sha
            })
        new_tree = self.create_tree(owner, repo, base_tree, tree_entries)
        new_commit = self.create_commit(owner, repo, message, new_tree, [commit_sha])
        self.update_ref(owner, repo, branch, new_commit)
        return {"commit_sha": new_commit}
