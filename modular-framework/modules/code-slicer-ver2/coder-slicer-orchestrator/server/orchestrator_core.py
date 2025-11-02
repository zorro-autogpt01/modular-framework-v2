import subprocess
import json
import uuid
import os
from pathlib import Path
from typing import Dict, List, Optional, Callable
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class SmartOrchestrator:
    """
    Main orchestration logic - coordinates between LLM and code analyzers.
    
    This is the core class that:
    1. Manages profile caching
    2. Coordinates LLM calls for intent parsing
    3. Runs Python/JS analyzers
    4. Reviews and iterates on extractions
    """
    
    def __init__(
        self,
        repo_path: str,
        gateway,  # LLMGatewayClient instance
        data_dir: str = "/app/data"
    ):
        """
        Initialize orchestrator.
        
        Args:
            repo_path: Path to repository to analyze
            gateway: Configured LLMGatewayClient instance
            data_dir: Directory for caching and outputs
        """
        self.repo_path = Path(repo_path).resolve()
        self.gateway = gateway
        self.data_dir = Path(data_dir)
        self.profile_cache_dir = self.data_dir / "cache"
        self.extractions_dir = self.data_dir / "extractions"
        self.progress_callback: Optional[Callable] = None
        
        # Ensure directories exist
        self.profile_cache_dir.mkdir(parents=True, exist_ok=True)
        self.extractions_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Initialized orchestrator for repo: {self.repo_path}")
    
    def set_progress_callback(self, callback: Callable):
        """
        Set callback for progress updates (for streaming API).
        
        Callback signature: callback(event_type: str, data: dict)
        """
        self.progress_callback = callback
    
    def _emit_progress(self, event_type: str, data: dict):
        """Emit progress event if callback is set."""
        if self.progress_callback:
            try:
                self.progress_callback(event_type, data)
            except Exception as e:
                logger.warning(f"Progress callback error: {e}")
    
    def run(
        self,
        user_query: str,
        force_reindex: bool = False
    ) -> Dict:
        """
        Main orchestration flow.
        
        Steps:
        1. Load/generate repository profile
        2. Parse user intent with LLM
        3. Expand targets intelligently
        4. Run code extraction
        5. Review completeness
        6. Generate next steps
        
        Args:
            user_query: Natural language query from user
            force_reindex: Force regeneration of profile
        
        Returns:
            {
              "extraction_id": "abc123",
              "extraction_path": "/app/data/extractions/abc123",
              "files_extracted": 10,
              "query": "Add rate limiting...",
              "plan": {...},
              "review": {...},
              "next_steps": "..."
            }
        """
        extraction_id = str(uuid.uuid4())[:8]
        output_dir = self.extractions_dir / extraction_id
        output_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Starting extraction {extraction_id} for query: {user_query}")
        self._emit_progress("started", {
            "extraction_id": extraction_id,
            "query": user_query
        })
        
        try:
            # Step 1: Get or generate profile
            logger.info("Step 1: Loading profile...")
            self._emit_progress("progress", {"step": "loading_profile", "message": "Loading repository profile..."})
            profile = self._get_profile(force_reindex)
            
            # Step 2: LLM parses intent
            logger.info("Step 2: Parsing intent with LLM...")
            self._emit_progress("progress", {"step": "parsing_intent", "message": "Analyzing your request..."})
            
            from server.orchestrator_llm import OrchestratorLLM
            llm = OrchestratorLLM(self.gateway)
            
            plan = llm.parse_intent(user_query, profile)
            logger.info(f"Generated plan: {plan}")
            self._emit_progress("plan", plan)
            
            # Step 3: Expand targets
            logger.info("Step 3: Expanding targets...")
            self._emit_progress("progress", {"step": "expanding_targets", "message": "Expanding to related code..."})
            expanded_targets = llm.expand_targets(plan['targets'], profile)
            logger.info(f"Expanded to {len(expanded_targets)} targets")
            
            # Step 4: Run extraction
            logger.info("Step 4: Running code extraction...")
            self._emit_progress("progress", {"step": "extracting", "message": "Extracting code snippets..."})
            extraction_result = self._run_extraction(
                targets=expanded_targets,
                hints=plan.get('hints', []),
                context=plan.get('context_lines', 10),
                output_dir=str(output_dir)
            )
            
            # Step 5: Review completeness
            logger.info("Step 5: Reviewing extraction...")
            self._emit_progress("progress", {"step": "reviewing", "message": "Reviewing completeness..."})
            summary = {
                "files": extraction_result['files'],
                "snippets": extraction_result['snippets'],
                "total_lines": extraction_result['total_lines']
            }
            review = llm.review_extraction(user_query, summary)
            logger.info(f"Review result: sufficient={review.get('sufficient')}")
            
            # Optional: Re-extract if insufficient
            if not review.get('sufficient', True) and review.get('suggestions'):
                logger.info("Extraction insufficient, adding suggested targets...")
                self._emit_progress("progress", {"step": "refining", "message": "Adding missing context..."})
                
                additional_result = self._run_extraction(
                    targets=review['suggestions'],
                    hints=plan.get('hints', []),
                    context=plan.get('context_lines', 10),
                    output_dir=str(output_dir)
                )
                
                # Merge results
                extraction_result['files'].extend(additional_result['files'])
                extraction_result['snippets'] += additional_result['snippets']
                extraction_result['total_lines'] += additional_result['total_lines']
            
            # Step 6: Generate next steps
            logger.info("Step 6: Generating recommendations...")
            self._emit_progress("progress", {"step": "generating_recommendations", "message": "Generating recommendations..."})
            next_steps = llm.suggest_next_steps(user_query, str(output_dir))
            
            # Save metadata
            meta = {
                "extraction_id": extraction_id,
                "created_at": datetime.utcnow().isoformat(),
                "query": user_query,
                "plan": plan,
                "files": extraction_result['files'],
                "snippets_count": extraction_result['snippets'],
                "total_lines": extraction_result['total_lines'],
                "review": review,
                "next_steps": next_steps,
                "model_used": {
                    "id": self.gateway._resolve_model()['id'],
                    "name": self.gateway._resolve_model()['model_name']
                }
            }
            (output_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding='utf-8')
            
            result = {
                "extraction_id": extraction_id,
                "extraction_path": str(output_dir),
                "files_extracted": len(extraction_result['files']),
                "query": user_query,
                "plan": plan,
                "review": review,
                "next_steps": next_steps
            }
            
            logger.info(f"Extraction {extraction_id} completed successfully")
            self._emit_progress("done", result)
            return result
            
        except Exception as e:
            logger.error(f"Extraction {extraction_id} failed: {e}", exc_info=True)
            self._emit_progress("error", {"error": str(e)})
            raise
    
    def _get_profile(self, force: bool = False) -> Dict:
        """
        Get cached profile or generate new one.
        
        Profile caching strategy:
        - Cache key: repo name + git hash
        - Invalidate on: git commit change or force flag
        
        Args:
            force: Force regeneration even if cache exists
        
        Returns:
            Profile dict with languages, frameworks, routes, etc.
        """
        # Use repo name as cache key
        repo_name = self.repo_path.name
        profile_path = self.profile_cache_dir / f"{repo_name}_profile.json"
        
        if not force and profile_path.exists():
            # Check if cache is fresh
            cached = json.loads(profile_path.read_text())
            current_hash = self._get_repo_hash()
            
            if cached.get('repo_hash') == current_hash:
                logger.info(f"Using cached profile for {repo_name}")
                return cached
            else:
                logger.info(f"Cache stale (hash mismatch), regenerating profile")
        
        # Generate new profile
        logger.info(f"Generating new profile for {repo_name}...")
        self._run_profile_generation(profile_path.parent)
        
        # Load generated profile
        profile = json.loads(profile_path.read_text())
        
        # Add cache metadata
        profile['repo_hash'] = self._get_repo_hash()
        profile['cached_at'] = datetime.utcnow().isoformat()
        
        # Save with metadata
        profile_path.write_text(json.dumps(profile, indent=2), encoding='utf-8')
        
        logger.info(f"Profile generated: {len(profile.get('languages', []))} languages detected")
        return profile
    
    def _run_profile_generation(self, output_dir: Path):
        """
        Run the Python/JS analyzers in profile mode.
        
        Calls orchestrator.py (the original Python script that coordinates
        slicer-core and slicer-js containers).
        
        Args:
            output_dir: Where to save profile.json
        """
        # Assume orchestrator.py is in the parent directory
        orchestrator_script = Path(__file__).parent.parent / "orchestrator.py"
        
        if not orchestrator_script.exists():
            # Fall back to system path
            orchestrator_script = "orchestrator.py"
        
        cmd = [
            "python3", str(orchestrator_script),
            "--repo", str(self.repo_path),
            "--out", str(output_dir),
            "--profile"
        ]
        
        logger.info(f"Running: {' '.join(cmd)}")
        
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            text=True,
            timeout=300  # 5 minute timeout
        )
        
        if result.returncode != 0:
            logger.error(f"Profile generation failed with code {result.returncode}")
            logger.error(f"STDOUT: {result.stdout}")
            logger.error(f"STDERR: {result.stderr}")
            raise RuntimeError(f"Profile generation failed: {result.stderr}")
        
        logger.info("Profile generation completed successfully")
    
    def _run_extraction(
        self,
        targets: List[str],
        hints: List[str],
        context: int,
        output_dir: str
    ) -> Dict:
        """
        Run code extraction with specified targets.
        
        Args:
            targets: List of routes or function names to extract
            hints: Keywords to search for additional context
            context: Number of context lines before/after
            output_dir: Where to save extraction results
        
        Returns:
            {
              "files": ["list of files"],
              "snippets": 42,
              "total_lines": 850
            }
        """
        orchestrator_script = Path(__file__).parent.parent / "orchestrator.py"
        if not orchestrator_script.exists():
            orchestrator_script = "orchestrator.py"
        
        cmd = [
            "python3", str(orchestrator_script),
            "--repo", str(self.repo_path),
            "--out", output_dir,
            "--context", str(context)
        ]
        
        # Add targets
        for t in targets:
            cmd.extend(["--target", t])
        
        # Add hints
        for h in hints:
            cmd.extend(["--hint", h])
        
        logger.info(f"Running extraction with {len(targets)} targets, {len(hints)} hints")
        
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            text=True,
            timeout=600  # 10 minute timeout
        )
        
        if result.returncode != 0:
            logger.error(f"Extraction failed with code {result.returncode}")
            logger.error(f"STDERR: {result.stderr}")
            raise RuntimeError(f"Extraction failed: {result.stderr}")
        
        # Parse results from output files
        out_path = Path(output_dir)
        
        # Load meta.json
        meta_file = out_path / "meta.json"
        if not meta_file.exists():
            raise RuntimeError("Extraction did not produce meta.json")
        
        meta = json.loads(meta_file.read_text())
        
        # Count snippets
        snippets_count = 0
        total_lines = 0
        
        snippets_file = out_path / "snippets.jsonl"
        if snippets_file.exists():
            with open(snippets_file) as f:
                for line in f:
                    snippets_count += 1
                    try:
                        snippet = json.loads(line)
                        total_lines += snippet['end_line'] - snippet['start_line']
                    except Exception:
                        pass
        
        logger.info(f"Extraction complete: {len(meta['files'])} files, {snippets_count} snippets")
        
        return {
            "files": meta['files'],
            "snippets": snippets_count,
            "total_lines": total_lines
        }
    
    def _get_repo_hash(self) -> str:
        """
        Get current git commit hash for cache validation.
        
        Returns:
            Git commit SHA or "unknown" if not a git repo
        """
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=self.repo_path,
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception as e:
            logger.debug(f"Failed to get git hash: {e}")
        
        return "unknown"
    
    def get_extraction_path(self, extraction_id: str) -> Optional[Path]:
        """
        Get path to extraction by ID.
        
        Args:
            extraction_id: Extraction ID from run() result
        
        Returns:
            Path to extraction directory or None if not found
        """
        path = self.extractions_dir / extraction_id
        return path if path.exists() else None
    
    def list_extractions(self, limit: int = 50) -> List[Dict]:
        """
        List past extractions.
        
        Args:
            limit: Maximum number of extractions to return
        
        Returns:
            List of extraction metadata dicts
        """
        extractions = []
        
        if not self.extractions_dir.exists():
            return []
        
        for d in sorted(self.extractions_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if not d.is_dir():
                continue
            
            meta_file = d / "meta.json"
            if meta_file.exists():
                try:
                    meta = json.loads(meta_file.read_text())
                    extractions.append({
                        "extraction_id": d.name,
                        "path": str(d),
                        "created_at": meta.get('created_at'),
                        "query": meta.get('query'),
                        "files_count": len(meta.get('files', [])),
                        "snippets_count": meta.get('snippets_count', 0)
                    })
                except Exception as e:
                    logger.warning(f"Failed to load meta for {d.name}: {e}")
            
            if len(extractions) >= limit:
                break
        
        return extractions
