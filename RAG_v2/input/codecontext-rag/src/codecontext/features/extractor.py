# src/codecontext/features/extractor.py
from typing import List, Dict, Optional, Set
from dataclasses import dataclass, asdict
from pathlib import Path
import re
import json
from collections import defaultdict
import asyncio

@dataclass
class Feature:
    """Represents a product feature extracted from code"""
    id: str
    repo_id: str
    name: str
    description: str
    category: str
    code_files: List[str]
    api_endpoints: List[str]
    ui_components: List[str]
    maturity: str  # "production", "beta", "prototype", "deprecated"
    last_updated: Optional[str] = None
    embedding: Optional[List[float]] = None
    confidence: float = 0.0  # How confident we are this is a real feature
    
    def to_dict(self) -> Dict:
        return asdict(self)


class FeatureExtractor:
    """
    Extracts high-level product features from codebase analysis
    
    Uses multiple signals:
    - API endpoints and routes
    - UI components and pages
    - Documentation (README, API specs)
    - Test files
    - Directory structure
    - LLM-assisted classification
    """
    
    def __init__(self, embedder, llm_client):
        self.embedder = embedder
        self.llm_client = llm_client
        
    async def extract_features(
        self,
        repo_id: str,
        repo_path: str,
        parsed_data: Dict,
        vector_store
    ) -> List[Feature]:
        """Main entry point for feature extraction"""
        
        print(f"🔍 Extracting features from {repo_path}")
        
        # Collect signals from multiple sources
        api_features = await self._extract_api_features(repo_path, parsed_data)
        ui_features = await self._extract_ui_features(repo_path, parsed_data)
        doc_features = await self._extract_documentation_features(repo_path)
        test_features = await self._extract_test_features(repo_path, parsed_data)
        
        # Merge and deduplicate
        raw_features = api_features + ui_features + doc_features + test_features
        merged_features = self._merge_similar_features(raw_features)
        
        # LLM-assisted classification and enhancement
        enhanced_features = await self._enhance_with_llm(
            merged_features,
            repo_path,
            parsed_data
        )
        
        # Generate embeddings
        features = await self._add_embeddings(enhanced_features, repo_id)
        
        print(f"✅ Extracted {len(features)} features")
        return features
    
    async def _extract_api_features(
        self,
        repo_path: str,
        parsed_data: Dict
    ) -> List[Feature]:
        """Extract features from API routes/endpoints"""
        
        features = []
        endpoint_map = defaultdict(lambda: {
            'files': set(),
            'endpoints': set(),
            'methods': set()
        })
        
        # Scan for route definitions
        for file_data in parsed_data['files']:
            file_path = file_data['file_path']
            code = self._read_file_safely(Path(repo_path) / file_path)
            
            if not code:
                continue
            
            # Python FastAPI/Flask patterns
            if file_data['language'] == 'python':
                # FastAPI: @app.get("/users")
                routes = re.findall(
                    r'@\w+\.(get|post|put|delete|patch)\(["\']([^"\']+)["\']',
                    code,
                    re.IGNORECASE
                )
                
                # Flask: @app.route("/users", methods=["GET"])
                routes += re.findall(
                    r'@\w+\.route\(["\']([^"\']+)["\'].*methods=\[([^\]]+)\]',
                    code,
                    re.IGNORECASE
                )
                
                for match in routes:
                    if len(match) == 2:
                        method, path = match
                        feature_name = self._infer_feature_from_endpoint(path)
                        endpoint_map[feature_name]['files'].add(file_path)
                        endpoint_map[feature_name]['endpoints'].add(f"{method.upper()} {path}")
                        endpoint_map[feature_name]['methods'].add(method.upper())
            
            # JavaScript/TypeScript Express patterns
            elif file_data['language'] in ['javascript', 'typescript']:
                # Express: app.get('/users', ...)
                routes = re.findall(
                    r'app\.(get|post|put|delete|patch)\(["\']([^"\']+)["\']',
                    code,
                    re.IGNORECASE
                )
                
                # Router: router.get('/users', ...)
                routes += re.findall(
                    r'router\.(get|post|put|delete|patch)\(["\']([^"\']+)["\']',
                    code,
                    re.IGNORECASE
                )
                
                for method, path in routes:
                    feature_name = self._infer_feature_from_endpoint(path)
                    endpoint_map[feature_name]['files'].add(file_path)
                    endpoint_map[feature_name]['endpoints'].add(f"{method.upper()} {path}")
                    endpoint_map[feature_name]['methods'].add(method.upper())
        
        # Convert to Feature objects
        for feature_name, data in endpoint_map.items():
            if not data['endpoints']:
                continue
                
            # Determine maturity based on HTTP methods
            maturity = "production"
            if any(m in data['methods'] for m in ['POST', 'PUT', 'DELETE']):
                maturity = "production"  # Write operations = production
            elif 'GET' in data['methods'] and len(data['methods']) == 1:
                maturity = "beta"  # Read-only might be beta
            
            features.append(Feature(
                id=f"api_{feature_name.lower().replace(' ', '_')}",
                repo_id="",  # Will be set later
                name=feature_name,
                description=f"API endpoints for {feature_name.lower()}",
                category="API",
                code_files=list(data['files']),
                api_endpoints=list(data['endpoints']),
                ui_components=[],
                maturity=maturity,
                confidence=0.9  # High confidence for explicit API routes
            ))
        
        return features
    
    async def _extract_ui_features(
        self,
        repo_path: str,
        parsed_data: Dict
    ) -> List[Feature]:
        """Extract features from UI components"""
        
        features = []
        component_map = defaultdict(lambda: {
            'files': set(),
            'components': set()
        })
        
        for file_data in parsed_data['files']:
            file_path = file_data['file_path']
            
            # Focus on UI directories
            if not any(x in file_path for x in ['components', 'pages', 'views', 'screens']):
                continue
            
            code = self._read_file_safely(Path(repo_path) / file_path)
            if not code:
                continue
            
            if file_data['language'] in ['javascript', 'typescript']:
                # React components: export default function UserProfile()
                components = re.findall(
                    r'(?:export\s+default\s+)?(?:function|const)\s+([A-Z][a-zA-Z0-9]+)',
                    code
                )
                
                # React class components: class UserProfile extends
                components += re.findall(
                    r'class\s+([A-Z][a-zA-Z0-9]+)\s+extends',
                    code
                )
                
                for component_name in components:
                    feature_name = self._infer_feature_from_component(component_name)
                    component_map[feature_name]['files'].add(file_path)
                    component_map[feature_name]['components'].add(component_name)
        
        # Convert to Feature objects
        for feature_name, data in component_map.items():
            if not data['components']:
                continue
            
            features.append(Feature(
                id=f"ui_{feature_name.lower().replace(' ', '_')}",
                repo_id="",
                name=feature_name,
                description=f"UI components for {feature_name.lower()}",
                category="UI",
                code_files=list(data['files']),
                api_endpoints=[],
                ui_components=list(data['components']),
                maturity="production",
                confidence=0.8
            ))
        
        return features
    
    async def _extract_documentation_features(
        self,
        repo_path: str
    ) -> List[Feature]:
        """Extract features from README, docs, OpenAPI specs"""
        
        features = []
        repo_path_obj = Path(repo_path)
        
        # Read README
        readme_content = ""
        for readme_name in ['README.md', 'README.txt', 'README', 'readme.md']:
            readme_path = repo_path_obj / readme_name
            if readme_path.exists():
                readme_content = self._read_file_safely(readme_path)
                break
        
        if readme_content:
            # Extract features from headers and lists
            # Pattern: ## Features or ## Key Features
            features_section = re.search(
                r'##\s+(?:Key\s+)?Features(.*?)(?=##|$)',
                readme_content,
                re.IGNORECASE | re.DOTALL
            )
            
            if features_section:
                section_text = features_section.group(1)
                # Extract bullet points
                bullets = re.findall(r'[-*]\s+(.+)', section_text)
                
                for idx, bullet in enumerate(bullets[:20]):  # Limit to 20
                    # Clean up markdown links [text](url) -> text
                    clean_text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', bullet)
                    clean_text = clean_text.strip()
                    
                    if len(clean_text) < 5:  # Skip very short items
                        continue
                    
                    feature_name = clean_text.split(':')[0].strip()
                    if len(feature_name) > 50:
                        feature_name = feature_name[:50]
                    
                    features.append(Feature(
                        id=f"doc_{idx}_{feature_name.lower().replace(' ', '_')[:30]}",
                        repo_id="",
                        name=feature_name,
                        description=clean_text,
                        category="Documented",
                        code_files=[],
                        api_endpoints=[],
                        ui_components=[],
                        maturity="production",  # Documented = likely in production
                        confidence=0.7
                    ))
        
        # Parse OpenAPI/Swagger specs
        for spec_file in ['openapi.yaml', 'openapi.json', 'swagger.yaml', 'swagger.json']:
            spec_path = repo_path_obj / spec_file
            if spec_path.exists():
                spec_features = self._parse_openapi_spec(spec_path)
                features.extend(spec_features)
        
        return features
    
    async def _extract_test_features(
        self,
        repo_path: str,
        parsed_data: Dict
    ) -> List[Feature]:
        """Infer features from test files"""
        
        features = []
        test_map = defaultdict(lambda: {'files': set(), 'tests': []})
        
        for file_data in parsed_data['files']:
            file_path = file_data['file_path']
            
            # Only test files
            if not any(x in file_path for x in ['test', 'spec', '__tests__']):
                continue
            
            # Look at test function names
            for func in file_data.get('functions', []):
                func_name = func.get('name', '')
                
                # Python: test_user_login, test_payment_processing
                # JS: testUserLogin, test('user login')
                if func_name.startswith('test_') or func_name.startswith('test'):
                    feature_name = self._infer_feature_from_test_name(func_name)
                    test_map[feature_name]['files'].add(file_path)
                    test_map[feature_name]['tests'].append(func_name)
        
        # Convert to Feature objects
        for feature_name, data in test_map.items():
            if len(data['tests']) < 2:  # Need at least 2 tests to be confident
                continue
            
            features.append(Feature(
                id=f"test_{feature_name.lower().replace(' ', '_')}",
                repo_id="",
                name=feature_name,
                description=f"Feature tested in {len(data['tests'])} test cases",
                category="Tested",
                code_files=list(data['files']),
                api_endpoints=[],
                ui_components=[],
                maturity="production",  # Tested = likely in production
                confidence=0.6
            ))
        
        return features
    
    def _merge_similar_features(self, features: List[Feature]) -> List[Feature]:
        """Merge features that refer to the same thing"""
        
        if not features:
            return []
        
        # Group by normalized name
        groups = defaultdict(list)
        for feature in features:
            normalized = self._normalize_feature_name(feature.name)
            groups[normalized].append(feature)
        
        merged = []
        for normalized_name, group in groups.items():
            if len(group) == 1:
                merged.append(group[0])
                continue
            
            # Merge multiple features into one
            base = group[0]
            
            # Combine all data
            all_files = set()
            all_endpoints = set()
            all_components = set()
            categories = set()
            max_confidence = 0.0
            
            for f in group:
                all_files.update(f.code_files)
                all_endpoints.update(f.api_endpoints)
                all_components.update(f.ui_components)
                categories.add(f.category)
                max_confidence = max(max_confidence, f.confidence)
            
            # Create merged feature
            merged_category = "Full-Stack" if len(categories) > 1 else list(categories)[0]
            
            merged.append(Feature(
                id=f"merged_{normalized_name}",
                repo_id=base.repo_id,
                name=base.name,
                description=f"Combined feature with {len(all_files)} files, {len(all_endpoints)} endpoints, {len(all_components)} components",
                category=merged_category,
                code_files=list(all_files),
                api_endpoints=list(all_endpoints),
                ui_components=list(all_components),
                maturity=base.maturity,
                confidence=max_confidence * 1.2  # Boost for multiple signals
            ))
        
        return merged
    
    async def _enhance_with_llm(
        self,
        features: List[Feature],
        repo_path: str,
        parsed_data: Dict
    ) -> List[Feature]:
        """Use LLM to improve feature descriptions and categorization"""
        
        if not features:
            return features
        
        # Prepare context about the codebase
        context = {
            "total_files": len(parsed_data['files']),
            "languages": list(parsed_data['language_stats'].keys()),
            "directory_structure": self._get_directory_structure(repo_path),
        }
        
        # Process in batches to avoid token limits
        batch_size = 10
        enhanced = []
        
        for i in range(0, len(features), batch_size):
            batch = features[i:i+batch_size]
            
            prompt = self._build_feature_enhancement_prompt(batch, context)
            
            try:
                response = await self.llm_client.chat(
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a senior software architect analyzing a codebase to identify product features."
                        },
                        {
                            "role": "user",
                            "content": prompt
                        }
                    ],
                    temperature=0.3,
                    max_tokens=2000
                )
                
                # Parse LLM response
                enhanced_batch = self._parse_llm_feature_response(
                    batch,
                    response.get("content", "")
                )
                enhanced.extend(enhanced_batch)
                
            except Exception as e:
                print(f"Warning: LLM enhancement failed: {e}")
                enhanced.extend(batch)  # Use originals
        
        return enhanced
    
    def _build_feature_enhancement_prompt(
        self,
        features: List[Feature],
        context: Dict
    ) -> str:
        """Build prompt for LLM to enhance feature descriptions"""
        
        features_text = "\n\n".join([
            f"Feature {idx+1}:\n"
            f"- Name: {f.name}\n"
            f"- Category: {f.category}\n"
            f"- Files: {len(f.code_files)}\n"
            f"- Endpoints: {', '.join(f.api_endpoints[:3]) if f.api_endpoints else 'None'}\n"
            f"- Components: {', '.join(f.ui_components[:3]) if f.ui_components else 'None'}"
            for idx, f in enumerate(features)
        ])
        
        return f"""I've extracted the following features from a codebase:

Repository Context:
- Total Files: {context['total_files']}
- Languages: {', '.join(context['languages'])}

Extracted Features:
{features_text}

For each feature, provide:
1. An improved name (if needed)
2. A clear 1-2 sentence description of what the feature does
3. A better category (choose from: Authentication, Data Management, API, UI/UX, Integration, Security, Analytics, Search, Messaging, Payment, Admin, Core)
4. Estimated maturity (production/beta/prototype)

Format your response as JSON:
[
  {{
    "index": 1,
    "improved_name": "...",
    "description": "...",
    "category": "...",
    "maturity": "..."
  }},
  ...
]
"""
    
    def _parse_llm_feature_response(
        self,
        original_features: List[Feature],
        llm_response: str
    ) -> List[Feature]:
        """Parse LLM response and update features"""
        
        try:
            # Extract JSON from response
            json_match = re.search(r'\[.*\]', llm_response, re.DOTALL)
            if not json_match:
                return original_features
            
            enhancements = json.loads(json_match.group())
            
            enhanced_features = []
            for i, feature in enumerate(original_features):
                if i < len(enhancements):
                    enh = enhancements[i]
                    feature.name = enh.get('improved_name', feature.name)
                    feature.description = enh.get('description', feature.description)
                    feature.category = enh.get('category', feature.category)
                    feature.maturity = enh.get('maturity', feature.maturity)
                
                enhanced_features.append(feature)
            
            return enhanced_features
            
        except Exception as e:
            print(f"Warning: Failed to parse LLM response: {e}")
            return original_features
    
    async def _add_embeddings(
        self,
        features: List[Feature],
        repo_id: str
    ) -> List[Feature]:
        """Generate embeddings for features"""
        
        for feature in features:
            # Set repo_id
            feature.repo_id = repo_id
            
            # Create embedding text
            embedding_text = f"{feature.name}\n{feature.description}\n"
            embedding_text += f"Category: {feature.category}\n"
            if feature.api_endpoints:
                embedding_text += f"Endpoints: {', '.join(feature.api_endpoints[:5])}\n"
            if feature.ui_components:
                embedding_text += f"Components: {', '.join(feature.ui_components[:5])}"
            
            try:
                # Use existing embedder
                if hasattr(self.embedder, 'embed_text'):
                    if asyncio.iscoroutinefunction(self.embedder.embed_text):
                        embedding = await self.embedder.embed_text(embedding_text)
                    else:
                        embedding = self.embedder.embed_text(embedding_text)
                    feature.embedding = embedding
            except Exception as e:
                print(f"Warning: Failed to embed feature {feature.name}: {e}")
        
        return features
    
    # Helper methods
    
    def _infer_feature_from_endpoint(self, path: str) -> str:
        """Convert API path to feature name: /api/users -> User Management"""
        
        # Remove common prefixes
        path = re.sub(r'^/(api|v\d+)/', '', path)
        
        # Extract resource name
        parts = path.strip('/').split('/')
        resource = parts[0] if parts else path
        
        # Remove IDs and params
        resource = re.sub(r':\w+|\{\w+\}', '', resource)
        
        # Convert to title case
        feature_name = resource.replace('-', ' ').replace('_', ' ').title()
        
        # Add "Management" suffix if appropriate
        if not any(x in feature_name.lower() for x in ['management', 'service', 'system']):
            feature_name += " Management"
        
        return feature_name
    
    def _infer_feature_from_component(self, component_name: str) -> str:
        """Convert component name to feature: UserProfile -> User Profile"""
        
        # Split camelCase
        feature_name = re.sub(r'([A-Z])', r' \1', component_name).strip()
        
        # Remove common suffixes
        feature_name = re.sub(r'\s+(Page|View|Screen|Component|Container)$', '', feature_name, re.IGNORECASE)
        
        return feature_name.strip()
    
    def _infer_feature_from_test_name(self, test_name: str) -> str:
        """Convert test name to feature: test_user_login -> User Login"""
        
        # Remove test prefix
        name = re.sub(r'^test[_\s]', '', test_name, re.IGNORECASE)
        
        # Convert to title case
        feature_name = name.replace('_', ' ').replace('-', ' ').title()
        
        return feature_name.strip()
    
    def _normalize_feature_name(self, name: str) -> str:
        """Normalize for comparison: 'User Management' -> 'usermanagement'"""
        return re.sub(r'[^a-z0-9]', '', name.lower())
    
    def _read_file_safely(self, file_path: Path) -> Optional[str]:
        """Read file with error handling"""
        try:
            return file_path.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            return None
    
    def _get_directory_structure(self, repo_path: str) -> List[str]:
        """Get top-level directory names"""
        try:
            repo_path_obj = Path(repo_path)
            return [
                d.name for d in repo_path_obj.iterdir()
                if d.is_dir() and not d.name.startswith('.')
            ][:10]
        except Exception:
            return []
    
    def _parse_openapi_spec(self, spec_path: Path) -> List[Feature]:
        """Parse OpenAPI spec to extract API features"""
        # Implementation would parse YAML/JSON spec
        # For now, return empty list
        return []