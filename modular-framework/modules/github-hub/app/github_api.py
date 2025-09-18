from __future__ import annotations
import base64, json
from typing import Dict, Any, List, Optional, Tuple
import requests
from loguru import logger

class GHClient:
    def __init__(self, token: str, base_url: str = "https://api.github.com"):
        self.token = token
        self.base_url = base_url.rstrip("/")

    def _h(self):
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    @staticmethod
    def parse_repo(url: str) -> Tuple[str, str]:
        # supports https://github.com/owner/repo(.git)
        parts = url.strip().rstrip("/").split("/")
        owner, repo = parts[-2], parts[-1].removesuffix(".git")
        return owner, repo

    # ----- simple endpoints -----
    def get_branches(self, owner: str, repo: str) -> List[str]:
        r = requests.get(f"{self.base_url}/repos/{owner}/{repo}/branches", headers=self._h(), timeout=20)
        r.raise_for_status()
        return [b["name"] for b in r.json()]

    def get_branch_sha(self, owner: str, repo: str, branch: str) -> str:
        r = requests.get(f"{self.base_url}/repos/{owner}/{repo}/branches/{branch}", headers=self._h(), timeout=20)
        r.raise_for_status()
        return r.json()["commit"]["sha"]

    def get_tree(self, owner: str, repo: str, branch: str, recursive: bool = True) -> Dict[str, Any]:
        sha = self.get_branch_sha(owner, repo, branch)
        url = f"{self.base_url}/repos/{owner}/{repo}/git/trees/{sha}"
        if recursive:
            url += "?recursive=1"
        r = requests.get(url, headers=self._h(), timeout=30)
        r.raise_for_status()
        return r.json()

    def get_file(self, owner: str, repo: str, path: str, ref: Optional[str] = None) -> Dict[str, Any]:
        params = {"ref": ref} if ref else None
        r = requests.get(f"{self.base_url}/repos/{owner}/{repo}/contents/{path}", headers=self._h(), params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        content_b64 = data.get("content") or ""
        decoded = base64.b64decode(content_b64.encode("utf-8")).decode("utf-8", errors="ignore") if content_b64 else ""
        return {**data, "decoded_content": decoded}

    def put_file(self, owner: str, repo: str, path: str, message: str, content: str, branch: Optional[str], sha: Optional[str]) -> Dict[str, Any]:
        payload = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("utf-8"),
        }
        if branch: payload["branch"] = branch
        if sha: payload["sha"] = sha
        r = requests.put(f"{self.base_url}/repos/{owner}/{repo}/contents/{path}", headers=self._h(), json=payload, timeout=30)
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
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/refs", headers=self._h(), json=payload, timeout=20)
        r.raise_for_status()
        return r.json()

    # ----- batch commit (single commit for many files) -----
    def get_commit_and_tree(self, owner: str, repo: str, branch: str) -> tuple[str, str]:
        ref = requests.get(f"{self.base_url}/repos/{owner}/{repo}/git/ref/heads/{branch}", headers=self._h(), timeout=20)
        ref.raise_for_status()
        commit_sha = ref.json()["object"]["sha"]
        commit = requests.get(f"{self.base_url}/repos/{owner}/{repo}/git/commits/{commit_sha}", headers=self._h(), timeout=20)
        commit.raise_for_status()
        tree_sha = commit.json()["tree"]["sha"]
        return commit_sha, tree_sha

    def create_blob(self, owner: str, repo: str, content: str, encoding: str = "utf-8") -> str:
        payload = {"content": content, "encoding": encoding}
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/blobs", headers=self._h(), json=payload, timeout=20)
        r.raise_for_status()
        return r.json()["sha"]

    def create_tree(self, owner: str, repo: str, base_tree: str, entries: List[Dict[str, Any]]) -> str:
        payload = {"base_tree": base_tree, "tree": entries}
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/trees", headers=self._h(), json=payload, timeout=20)
        r.raise_for_status()
        return r.json()["sha"]

    def create_commit(self, owner: str, repo: str, message: str, tree_sha: str, parents: List[str]) -> str:
        payload = {"message": message, "tree": tree_sha, "parents": parents}
        r = requests.post(f"{self.base_url}/repos/{owner}/{repo}/git/commits", headers=self._h(), json=payload, timeout=20)
        r.raise_for_status()
        return r.json()["sha"]

    def update_ref(self, owner: str, repo: str, branch: str, new_sha: str) -> Dict[str, Any]:
        payload = {"sha": new_sha, "force": False}
        r = requests.patch(f"{self.base_url}/repos/{owner}/{repo}/git/refs/heads/{branch}", headers=self._h(), json=payload, timeout=20)
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
