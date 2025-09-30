import os
import aiohttp
from fastapi import HTTPException

DEFAULT_GITHUB_HUB = os.getenv('GITHUB_HUB_URL', 'http://github-hub-module:3005/api')

async def fetch_repo_tree(repo_url: str, branch: str, base_url: str | None = None) -> dict:
    """Fetch repository tree from the GitHub Hub service.

    Note: kept signature compatible with the original app (repo_url arg is accepted
    to preserve call sites; the underlying hub API previously only used branch).
    """
    base = (base_url or DEFAULT_GITHUB_HUB).rstrip('/')
    params = {"branch": branch, "recursive": "true"}
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{base}/tree", params=params) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=resp.status, detail="Failed to fetch repo tree")
            return await resp.json()


async def fetch_file_content(path: str, branch: str, base_url: str | None = None) -> str:
    """Fetch a file's content from the GitHub Hub service.

    Returns decoded_content or empty string on non-200 like the original code.
    """
    base = (base_url or DEFAULT_GITHUB_HUB).rstrip('/')
    params = {"path": path, "branch": branch}
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{base}/file", params=params) as resp:
            if resp.status != 200:
                return ""
            data = await resp.json()
            return data.get("decoded_content", "")
