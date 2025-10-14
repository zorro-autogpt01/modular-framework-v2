# src/codecontext/git/analyzer.py
from git import Repo
from typing import Dict, List, Set
from collections import defaultdict
from datetime import datetime, timedelta

class GitAnalyzer:
    def __init__(self, repo_path: str):
        try:
            self.repo = Repo(repo_path)
        except:
            self.repo = None
    
    def analyze_comodification_patterns(self, months_back: int = 6) -> Dict[str, List[str]]:
        """Find files that are frequently modified together"""
        if not self.repo:
            return {}
        
        since_date = datetime.now() - timedelta(days=30 * months_back)
        
        # Track which files are modified together in each commit
        comodifications = defaultdict(lambda: defaultdict(int))
        
        for commit in self.repo.iter_commits(since=since_date):
            modified_files = []
            try:
                for item in commit.stats.files:
                    modified_files.append(item)
            except:
                continue
            
            # Record co-modifications
            for i, file1 in enumerate(modified_files):
                for file2 in modified_files[i+1:]:
                    comodifications[file1][file2] += 1
                    comodifications[file2][file1] += 1
        
        # Convert to sorted lists
        result = {}
        for file, comod_files in comodifications.items():
            # Sort by frequency
            sorted_files = sorted(comod_files.items(), key=lambda x: x[1], reverse=True)
            result[file] = [f for f, _ in sorted_files[:10]]  # Top 10
        
        return result
    
    def get_file_recency(self, file_path: str) -> float:
        """Get recency score for a file (0-1, higher = more recent)"""
        if not self.repo:
            return 0.5
        
        try:
            commits = list(self.repo.iter_commits(paths=file_path, max_count=1))
            if not commits:
                return 0.0
            
            last_commit_date = commits[0].committed_datetime
            days_ago = (datetime.now(last_commit_date.tzinfo) - last_commit_date).days
            
            # Decay function: 1.0 for today, 0.5 for 180 days ago, 0.0 for 365+ days
            recency = max(0.0, 1.0 - (days_ago / 365.0))
            return recency
        except:
            return 0.5
    
    def get_change_frequency(self, file_path: str, months_back: int = 12) -> int:
        """Get number of times file was modified in the period"""
        if not self.repo:
            return 0
        
        since_date = datetime.now() - timedelta(days=30 * months_back)
        
        try:
            commits = list(self.repo.iter_commits(paths=file_path, since=since_date))
            return len(commits)
        except:
            return 0