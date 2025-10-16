from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from typing import List, Dict, Any, Optional, AsyncIterator
import uuid
import inspect as _inspect
import os
import tempfile
import shutil
import subprocess
import secrets
import re

from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import GeneratePatchRequest, PromptRequest, PromptOptions, ApplyPatchRequest
from ...api.schemas.response import PatchResponse, ApplyPatchResponse
from ...integrations.llm_gateway import LLMGatewayClient
from ...integrations.github_hub import GitHubHubClient
from ...core.prompt import PromptAssembler
from ...core.patch import validate_patch
from .prompts import _vector_top_chunks, _dependency_neighbor_chunks

from ...config import settings

router = APIRouter(prefix="/repositories", tags=["Patches"], dependencies=[Depends(authorize)])


def _patch_instruction(
    restrict_to_files: Optional[List[str]],
    force_unified_diff: bool
) -> str:
    allowed = ""
    if restrict_to_files:
        allowed = "You must only modify the following files (no others):\n" + "\n".join(f"- {fp}" for fp in restrict_to_files) + "\n\n"
    directive = (
        "Generate a unified diff patch in git format (--- a/..., +++ b/... with @@ hunks). "
        "Do not include any explanations, comments, or prose—only the diff.\n"
        "If the provided context is insufficient, ask precise clarifying questions instead of guessing code.\n"
    )
    if force_unified_diff:
        directive += "Output must be a valid unified diff. Do not wrap it in code fences.\n"
    return allowed + directive


async def _build_messages_if_needed(
    request: Request,
    repo_id: str,
    body: GeneratePatchRequest
) -> List[Dict[str, Any]]:
    if body.prompt_messages and len(body.prompt_messages) > 0:
        return [{"role": m.role, "content": m.content} for m in body.prompt_messages]

    if not body.query:
        raise HTTPException(status_code=400, detail="Either prompt_messages or query must be provided")

    options = body.options or PromptOptions()
    model = options.model or None
    max_chunks = options.max_chunks or 12
    per_file_neighbor_chunks = options.per_file_neighbor_chunks or 2
    include_dep = options.include_dependency_expansion if options.include_dependency_expansion is not None else True
    dep_depth = options.dependency_depth or 1
    dep_dir = options.dependency_direction or "both"
    neighbor_files_limit = options.neighbor_files_limit or 4
    retrieval_mode = (options.retrieval_mode or "vector").lower()
    call_graph_depth = options.call_graph_depth or 2
    languages = options.languages or (body.filters.languages if body.filters and body.filters.languages else None)
    slice_target = options.slice_target
    slice_direction = options.slice_direction or "forward"
    slice_depth = options.slice_depth or 2

    base_chunks, artifacts, _ = await _vector_top_chunks(
        request=request,
        repo_id=repo_id,
        query=body.query,
        max_chunks=max_chunks,
        languages=languages,
        retrieval_mode=retrieval_mode,
        call_graph_depth=call_graph_depth,
        slice_target=slice_target,
        slice_direction=slice_direction,
        slice_depth=slice_depth
    )

    neighbor_chunks: List[Dict[str, Any]] = []
    if include_dep and base_chunks:
        embedder = request.app.state.embedder
        if _inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
            q_emb = await embedder.embed_text(body.query)
        else:
            q_emb = embedder.embed_text(body.query)

        base_files = list({b.get("file_path") for b in base_chunks if b.get("file_path")})
        neighbor_chunks = await _dependency_neighbor_chunks(
            request=request,
            repo_id=repo_id,
            query_embedding=q_emb,
            base_files=base_files,
            depth=dep_depth,
            direction=dep_dir,
            neighbor_files_limit=neighbor_files_limit,
            per_file_neighbor_chunks=per_file_neighbor_chunks,
            languages=languages
        )

    assembler = PromptAssembler(LLMGatewayClient())
    messages, usage = await assembler.assemble(
        query=body.query,
        base_chunks=base_chunks,
        neighbor_chunks=neighbor_chunks,
        model=model,
        system_prompt=options.system_prompt,
        temperature=options.temperature or 0.2,
        max_tokens=options.max_tokens or 2200
    )
    return messages


def _slugify_branch(text: str) -> str:
    base = re.sub(r'[^a-zA-Z0-9._/-]+', '-', (text or "patch"))
    base = re.sub(r'[-/]+', '-', base).strip('-')
    if not base:
        base = "patch"
    return base[:40]


def _run(cmd: List[str], cwd: str | None = None, timeout: int = 120) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        return 124, "", f"Timeout running: {' '.join(cmd)}"
    except Exception as e:
        return 1, "", f"Exception running {' '.join(cmd)}: {e}"


def _run_pre_commit_hooks(hooks: List[str], cwd: str, logs: List[str]) -> bool:
    if not hooks:
        return True
    ok = True
    for cmd in hooks:
        parts = cmd.strip().split()
        code, out, err = _run(parts, cwd=cwd, timeout=300)
        logs.append(out or err or f"ran: {cmd}")
        if code != 0:
            ok = False
            logs.append(f"Hook failed: {cmd}")
    return ok

@router.post("/{repo_id}/patch")
async def generate_patch(
    request: Request,
    repo_id: str,
    body: GeneratePatchRequest,
    response: Response
):
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    llm_client = LLMGatewayClient()
    try:
        messages = await _build_messages_if_needed(request, repo_id, body)

        messages.append({
            "role": "user",
            "content": _patch_instruction(body.restrict_to_files, body.force_unified_diff if body.force_unified_diff is not None else True)
        })

        model = body.model or None
        temperature = body.temperature or 0.15
        max_out = body.max_output_tokens or 1400
        stream = bool(body.stream)
        dry_run = bool(body.dry_run)

        if not stream:
            result = await llm_client.chat(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_out,
                stream=False,
                metadata={"repo_id": repo_id, "session_id": session_id, "purpose": "generate_patch"},
                dry_run=dry_run
            )
            content = result.get("content", "")

            repo_store = request.app.state.repo_store
            repo = repo_store.get(repo_id)
            repo_path = repo.get("local_path") if repo else None

            restrict_list = body.restrict_to_files or []
            v_report = validate_patch(
                content,
                repo_root=repo_path,
                restrict_to_files=restrict_list if body.enforce_restriction else None
            )

            data = {
                "model": model,
                "messages_used": len(messages),
                "patch": content if not dry_run else None,
                "dry_run": dry_run,
                "validation": v_report,
                "summary": {
                    "restricted": bool(body.restrict_to_files),
                    "enforced": bool(body.enforce_restriction),
                    "files_in_patch": v_report.get("files", []),
                    "ok": v_report.get("ok", False)
                }
            }
            return success_response(request, data, response)

        else:
            async def streamer() -> AsyncIterator[bytes]:
                stream_iter = await llm_client.chat(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_out,
                    stream=True,
                    metadata={"repo_id": repo_id, "session_id": session_id, "purpose": "generate_patch"},
                    dry_run=dry_run
                )
                async for chunk in stream_iter:
                    yield chunk.encode("utf-8")

            return StreamingResponse(streamer(), media_type="text/plain")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Patch generation failed: {str(e)}")
    finally:
        await llm_client.close()


@router.post("/{repo_id}/apply-patch")
async def apply_patch(
    request: Request,
    repo_id: str,
    body: ApplyPatchRequest,
    response: Response
):
    """
    Apply a unified diff patch to a temporary worktree, commit it on a new branch, optionally push and open a PR.
    Runs optional pre-commit hooks before committing.
    """
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    repo_store = request.app.state.repo_store
    repo = repo_store.get(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    repo_path = repo.get("local_path")
    if not repo_path or not os.path.isdir(repo_path):
        raise HTTPException(status_code=400, detail="Local repository path not found")

    base_branch = body.base_branch or repo.get("branch") or "main"

    validation = validate_patch(
        body.patch,
        repo_root=repo_path,
        restrict_to_files=(body.restrict_to_files or None) if body.enforce_restriction else None
    )
    if not validation.get("ok") and body.enforce_restriction:
        raise HTTPException(status_code=400, detail={"message": "Patch validation failed", "validation": validation})

    logs: List[str] = []
    worktree_dir = None
    new_branch = body.new_branch or f"bot/{_slugify_branch(body.pr_title or body.commit_message or 'patch')}-{secrets.token_hex(3)}"
    commit_message = body.commit_message or (body.pr_title or "Automated patch")
    pushed = False
    pr_created = False
    pr_info: Optional[Dict[str, Any]] = None
    commit_sha: Optional[str] = None

    try:
        code, out, err = _run(["git", "fetch", "--all", "--tags"], cwd=repo_path, timeout=180)
        logs.append(out or err or "")
        parent = os.path.abspath(os.path.join(repo_path, ".."))
        worktrees_root = os.path.join(parent, "worktrees")
        os.makedirs(worktrees_root, exist_ok=True)
        worktree_dir = os.path.join(worktrees_root, f"{new_branch.replace('/', '_')}_{secrets.token_hex(4)}")

        code, out, err = _run(["git", "worktree", "add", "-b", new_branch, worktree_dir, base_branch], cwd=repo_path, timeout=180)
        logs.append(out or err or "")
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to create worktree/branch: {err}")

        with tempfile.NamedTemporaryFile(mode="w", delete=False) as tf:
            tf.write(body.patch)
            tf.flush()
            patch_file = tf.name

        try:
            code, out, err = _run(["git", "apply", "--check", "-p1", patch_file], cwd=worktree_dir)
            logs.append(out or err or "")
            if code != 0:
                code, out, err = _run(["git", "apply", "--check", "-p0", patch_file], cwd=worktree_dir)
                logs.append(out or err or "")
                if code != 0:
                    raise HTTPException(status_code=400, detail=f"Patch does not apply cleanly: {err}")
        finally:
            pass

        if body.dry_run:
            try:
                os.unlink(patch_file)
            except Exception:
                pass
            data = {
                "base_branch": base_branch,
                "new_branch": new_branch,
                "commit": None,
                "pushed": False,
                "pr_created": False,
                "pr": None,
                "validation": validation,
                "logs": logs,
                "summary": {"dry_run": True}
            }
            return success_response(request, data, response)

        code, out, err = _run(["git", "apply", "-p1", "--index", patch_file], cwd=worktree_dir)
        logs.append(out or err or "")
        if code != 0:
            code, out, err = _run(["git", "apply", "-p0", "--index", patch_file], cwd=worktree_dir)
            logs.append(out or err or "")
            if code != 0:
                raise HTTPException(status_code=400, detail=f"Patch apply failed: {err}")

        # Run pre-commit hooks if configured
        if not body.skip_hooks and settings.pre_commit_hooks:
            ok = _run_pre_commit_hooks(settings.pre_commit_hooks, cwd=worktree_dir, logs=logs)
            if not ok:
                # Allow user to override by skip_hooks true
                raise HTTPException(status_code=400, detail={"message": "Pre-commit hooks failed", "logs": logs})

        code, out, err = _run(["git", "add", "-A"], cwd=worktree_dir)
        logs.append(out or err or "")

        code, out, err = _run(["git", "commit", "-m", commit_message], cwd=worktree_dir)
        logs.append(out or err or "")
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Commit failed: {err}")

        code, out, err = _run(["git", "rev-parse", "HEAD"], cwd=worktree_dir)
        commit_sha = (out or "").strip()

        if body.push:
            code, out, err = _run(["git", "push", "-u", "origin", new_branch], cwd=worktree_dir, timeout=240)
            logs.append(out or err or "")
            if code != 0:
                raise HTTPException(status_code=500, detail=f"Push failed: {err}")
            pushed = True

        if body.create_pr:
            if not pushed:
                code, out, err = _run(["git", "push", "-u", "origin", new_branch], cwd=worktree_dir, timeout=240)
                logs.append(out or err or "")
                if code != 0:
                    raise HTTPException(status_code=500, detail=f"Push required before PR; push failed: {err}")
                pushed = True

            client = GitHubHubClient()
            pr_title = body.pr_title or commit_message
            pr_body = body.pr_body or f"Automated patch via CodeContext RAG.\n\nCommit: {commit_sha or ''}\nBranch: {new_branch}"
            pr_info = await client.create_pr(
                title=pr_title,
                head=new_branch,
                base=base_branch,
                body=pr_body,
                draft=bool(body.draft_pr),
                conn_id=repo.get("connection_id")
            )
            pr_created = True

        data = {
            "base_branch": base_branch,
            "new_branch": new_branch,
            "commit": commit_sha,
            "pushed": pushed,
            "pr_created": pr_created,
            "pr": pr_info,
            "validation": validation,
            "logs": logs,
            "summary": {
                "files_changed": validation.get("files", []),
                "worktree": worktree_dir
            }
        }
        return success_response(request, data, response)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Apply patch failed: {str(e)}")
    finally:
        try:
            if worktree_dir and os.path.isdir(worktree_dir):
                _run(["git", "worktree", "prune"], cwd=repo_path)
        except Exception:
            pass