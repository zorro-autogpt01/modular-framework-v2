# src/codecontext/workflows/product_analysis.py
from typing import Dict, List, Optional
import asyncio
from datetime import datetime

from ..features.extractor import FeatureExtractor
from ..storage.feature_store import FeatureStore
from ..agents.personas import (
    AgentContext,
    ProductManagerAgent,
    MarketerAgent,
    ConversationFacilitator
)
from ..integrations.llm_gateway import LLMGatewayClient


class ProductAnalysisWorkflow:
    """
    Orchestrates Stage 1: PM/Marketer analyze product and suggest enhancements
    
    Steps:
    1. Extract features from code
    2. PM analyzes current state
    3. Marketer provides market perspective
    4. Multi-agent discussion
    5. Generate and store feature suggestions
    """
    
    def __init__(
        self,
        feature_store: FeatureStore,
        llm_client: LLMGatewayClient,
        embedder
    ):
        self.feature_store = feature_store
        self.llm_client = llm_client
        self.embedder = embedder
        self.feature_extractor = FeatureExtractor(embedder, llm_client)
    
    async def run(
        self,
        repo_id: str,
        repo_path: str,
        parsed_data: Dict,
        vector_store,
        skip_feature_extraction: bool = False
    ) -> Dict:
        """
        Execute full product analysis workflow
        
        Args:
            repo_id: Repository ID
            repo_path: Path to repository on disk
            parsed_data: Output from CodeParser
            vector_store: VectorStore instance
            skip_feature_extraction: If True, use existing features
        
        Returns:
            Dict with analysis results
        """
        
        print(f"\n{'='*60}")
        print(f"🚀 PRODUCT ANALYSIS WORKFLOW - Stage 1")
        print(f"{'='*60}\n")
        
        results = {
            'repo_id': repo_id,
            'started_at': datetime.utcnow().isoformat() + 'Z',
            'features_extracted': 0,
            'features_analyzed': 0,
            'suggestions_generated': 0,
            'analyses': {},
            'conversation': None,
            'suggestions': []
        }
        
        # Step 1: Extract features
        if not skip_feature_extraction:
            print("📊 Step 1/5: Extracting features from codebase...")
            
            features = await self.feature_extractor.extract_features(
                repo_id,
                repo_path,
                parsed_data,
                vector_store
            )
            
            # Save to store
            saved = self.feature_store.save_features(features)
            results['features_extracted'] = saved
            
            print(f"   ✓ Extracted and saved {saved} features\n")
        else:
            print("📊 Step 1/5: Loading existing features...")
            features_data = self.feature_store.get_features(repo_id)
            print(f"   ✓ Loaded {len(features_data)} features\n")
        
        # Load features for analysis
        features_data = self.feature_store.get_features(repo_id, min_confidence=0.5)
        results['features_analyzed'] = len(features_data)
        
        # Build context for agents
        context = AgentContext(
            repo_id=repo_id,
            features=features_data,
            repo_metadata={
                'path': repo_path,
                'total_files': len(parsed_data.get('files', [])),
                'languages': list(parsed_data.get('language_stats', {}).keys())
            }
        )
        
        # Step 2: PM Analysis
        print("🎯 Step 2/5: Product Manager analyzing current features...")
        
        pm_agent = ProductManagerAgent(self.llm_client, self.embedder)
        pm_analysis = await pm_agent.analyze_current_features(context)
        
        # Save analysis
        self.feature_store.save_analysis(
            repo_id=repo_id,
            agent_role=pm_agent.role,
            analysis_type="feature_assessment",
            summary=pm_analysis.get('analysis', '')[:500],
            details=pm_analysis
        )
        
        results['analyses']['pm'] = {
            'role': pm_agent.role,
            'summary': pm_analysis.get('analysis', '')[:500] + '...',
            'recommendations_count': len(pm_analysis.get('recommendations', []))
        }
        
        print(f"   ✓ PM identified {len(pm_analysis.get('recommendations', []))} quick wins\n")
        
        # Step 3: Marketer Analysis
        print("📈 Step 3/5: Growth Marketer analyzing market fit...")
        
        marketer_agent = MarketerAgent(self.llm_client, self.embedder)
        market_analysis = await marketer_agent.analyze_market_fit(context)
        
        # Save analysis
        self.feature_store.save_analysis(
            repo_id=repo_id,
            agent_role=marketer_agent.role,
            analysis_type="market_analysis",
            summary=market_analysis.get('analysis', '')[:500],
            details=market_analysis
        )
        
        results['analyses']['marketer'] = {
            'role': marketer_agent.role,
            'summary': market_analysis.get('analysis', '')[:500] + '...',
            'opportunities_count': len(market_analysis.get('opportunities', []))
        }
        
        print(f"   ✓ Marketer identified {len(market_analysis.get('opportunities', []))} growth opportunities\n")
        
        # Step 4: Multi-agent Discussion
        print("💬 Step 4/5: Facilitating multi-agent discussion...")
        
        facilitator = ConversationFacilitator(self.llm_client)
        
        discussion = await facilitator.facilitate_discussion(
            agents=[pm_agent, marketer_agent],
            topic="Product enhancement priorities for the next quarter",
            context=context,
            max_turns=3
        )
        
        results['conversation'] = {
            'topic': discussion['topic'],
            'message_count': len(discussion['conversation']),
            'consensus_summary': discussion['consensus'].get('summary', '')[:300] + '...',
            'recommendations_count': len(discussion['consensus'].get('recommendations', []))
        }
        
        print(f"   ✓ Discussion completed with {len(discussion['conversation'])} exchanges\n")
        
        # Step 5: Generate Feature Suggestions
        print("💡 Step 5/5: Generating feature suggestions...")
        
        # PM proposes features based on discussion
        proposals = await pm_agent.propose_features(
            context,
            market_insights=market_analysis
        )
        
        print(f"   → PM proposed {len(proposals)} features")
        
        # Marketer validates proposals
        validated_proposals = await marketer_agent.validate_suggestions(
            context,
            proposals
        )
        
        print(f"   → Marketer validated proposals")
        
        # Save suggestions to store
        saved_suggestions = []
        for proposal in validated_proposals:
            # Add embeddings
            if self.embedder:
                embedding_text = f"{proposal['title']}\n{proposal['description']}"
                try:
                    if asyncio.iscoroutinefunction(self.embedder.embed_text):
                        embedding = await self.embedder.embed_text(embedding_text)
                    else:
                        embedding = self.embedder.embed_text(embedding_text)
                    proposal['embedding'] = embedding
                except Exception:
                    pass
            
            suggestion = {
                'repo_id': repo_id,
                'title': proposal.get('title', ''),
                'description': proposal.get('description', ''),
                'rationale': proposal.get('user_value', ''),
                'market_evidence': proposal.get('market_validation', {}),
                'priority': proposal.get('priority', 'medium'),
                'effort_estimate': proposal.get('effort', 'medium'),
                'dependencies': proposal.get('dependencies', []),
                'status': 'proposed',
                'proposed_by': 'PM & Marketer Agents',
                'embedding': proposal.get('embedding')
            }
            
            suggestion_id = self.feature_store.save_suggestion(suggestion)
            saved_suggestions.append(suggestion_id)
            
            # Save conversation about this suggestion
            self.feature_store.save_conversation_message(
                feature_suggestion_id=suggestion_id,
                repo_id=repo_id,
                agent_role="Product Manager",
                message=f"Proposed: {proposal['title']}",
                reasoning=proposal.get('user_value', '')
            )
            
            if proposal.get('market_validation'):
                self.feature_store.save_conversation_message(
                    feature_suggestion_id=suggestion_id,
                    repo_id=repo_id,
                    agent_role="Growth Marketer",
                    message=f"Market validation: {proposal['market_validation'].get('recommendation', '')}",
                    reasoning=proposal['market_validation'].get('competitive_advantage', '')
                )
        
        results['suggestions_generated'] = len(saved_suggestions)
        results['suggestions'] = validated_proposals
        
        print(f"   ✓ Saved {len(saved_suggestions)} feature suggestions\n")
        
        # Final summary
        results['completed_at'] = datetime.utcnow().isoformat() + 'Z'
        
        print(f"{'='*60}")
        print(f"✅ WORKFLOW COMPLETED")
        print(f"{'='*60}")
        print(f"Features Extracted: {results['features_extracted']}")
        print(f"Features Analyzed: {results['features_analyzed']}")
        print(f"Suggestions Generated: {results['suggestions_generated']}")
        print(f"{'='*60}\n")
        
        return results