# src/codecontext/agents/personas.py
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field
from abc import ABC, abstractmethod
import asyncio

@dataclass
class Message:
    """Agent conversation message"""
    role: str  # Agent role or "user"
    content: str
    reasoning: Optional[str] = None  # Internal reasoning (not shown to other agents)
    metadata: Dict = field(default_factory=dict)
    timestamp: Optional[str] = None

@dataclass
class AgentContext:
    """Context provided to agents"""
    repo_id: str
    features: List[Dict]
    repo_metadata: Dict
    conversation_history: List[Message] = field(default_factory=list)
    custom_data: Dict = field(default_factory=dict)


class AgentPersona(ABC):
    """
    Base class for LLM-powered agent personalities
    
    Each agent has:
    - A specific role and expertise
    - A personality prompt that shapes behavior
    - Conversation memory
    - Reasoning capabilities
    """
    
    def __init__(self, llm_client, embedder=None):
        self.llm_client = llm_client
        self.embedder = embedder
        self.conversation_memory: List[Message] = []
    
    @property
    @abstractmethod
    def role(self) -> str:
        """Agent role name"""
        pass
    
    @property
    @abstractmethod
    def expertise(self) -> List[str]:
        """Areas of expertise"""
        pass
    
    @property
    @abstractmethod
    def personality_prompt(self) -> str:
        """System prompt that defines personality"""
        pass
    
    async def analyze(
        self,
        context: AgentContext,
        query: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Main analysis method - each agent implements their own logic
        
        Returns:
            Dict with 'analysis', 'reasoning', 'recommendations', etc.
        """
        messages = self._build_messages(context, query)
        
        try:
            response = await self.llm_client.chat(
                messages=messages,
                temperature=kwargs.get('temperature', 0.5),
                max_tokens=kwargs.get('max_tokens', 2000)
            )
            
            content = response.get('content', '')
            
            # Parse response into structured format
            result = self._parse_response(content)
            
            # Add to memory
            self.conversation_memory.append(Message(
                role=self.role,
                content=content,
                reasoning=result.get('reasoning'),
                metadata=result.get('metadata', {})
            ))
            
            return result
            
        except Exception as e:
            print(f"Error in {self.role} analysis: {e}")
            return {
                'analysis': f"Error: {str(e)}",
                'error': True
            }
    
    def _build_messages(
        self,
        context: AgentContext,
        query: str
    ) -> List[Dict]:
        """Build message list for LLM"""
        
        messages = [
            {
                "role": "system",
                "content": self.personality_prompt
            }
        ]
        
        # Add context summary
        context_text = self._format_context(context)
        messages.append({
            "role": "user",
            "content": f"Context:\n{context_text}\n\nQuery: {query}"
        })
        
        # Add relevant conversation history
        for msg in self.conversation_memory[-5:]:  # Last 5 messages
            if msg.role != self.role:  # Don't include own messages
                messages.append({
                    "role": "user" if msg.role == "user" else "assistant",
                    "content": msg.content
                })
        
        return messages
    
    def _format_context(self, context: AgentContext) -> str:
        """Format context for LLM"""
        
        lines = [
            f"Repository: {context.repo_id}",
            f"Total Features: {len(context.features)}",
            ""
        ]
        
        if context.features:
            lines.append("Current Features:")
            for feature in context.features[:20]:  # Limit to 20
                lines.append(f"- {feature['name']} ({feature['category']})")
                if feature.get('description'):
                    lines.append(f"  {feature['description']}")
        
        return "\n".join(lines)
    
    def _parse_response(self, content: str) -> Dict[str, Any]:
        """Parse LLM response - can be overridden by subclasses"""
        return {
            'analysis': content,
            'recommendations': []
        }
    
    def clear_memory(self):
        """Clear conversation memory"""
        self.conversation_memory = []


class ProductManagerAgent(AgentPersona):
    """
    Product Manager agent - focuses on user value and business impact
    """
    
    @property
    def role(self) -> str:
        return "Product Manager"
    
    @property
    def expertise(self) -> List[str]:
        return [
            "Feature prioritization",
            "User story creation",
            "Roadmap planning",
            "Stakeholder management",
            "Business value assessment"
        ]
    
    @property
    def personality_prompt(self) -> str:
        return """You are a senior product manager with 10+ years of experience building successful software products.

Your approach:
- Always start with user needs and pain points
- Prioritize features based on impact vs effort
- Think strategically about product direction
- Consider business metrics and KPIs
- Balance user desires with technical feasibility
- Create clear, actionable user stories

When analyzing a product:
1. Identify gaps in current feature set
2. Suggest high-value enhancements
3. Explain the "why" behind each suggestion
4. Consider competitive positioning
5. Estimate business impact

Be specific, pragmatic, and user-focused in your analysis."""
    
    async def analyze_current_features(
        self,
        context: AgentContext
    ) -> Dict[str, Any]:
        """Analyze existing features from a product perspective"""
        
        query = """Analyze the current features of this product. Provide:

1. Feature Gap Analysis: What critical features are missing?
2. User Experience Assessment: How well do current features serve users?
3. Feature Maturity: Which features need improvement?
4. Quick Wins: What low-effort, high-impact improvements can be made?
5. Strategic Opportunities: What would make this product stand out?

Format your response as:

## Gap Analysis
[Your analysis]

## UX Assessment
[Your analysis]

## Maturity Evaluation
[Your analysis]

## Quick Wins
1. [Feature] - [Why it matters] - [Effort: Small/Medium/Large]
2. ...

## Strategic Opportunities
1. [Opportunity] - [Business impact] - [User value]
2. ...
"""
        
        result = await self.analyze(context, query, temperature=0.6)
        
        # Extract structured recommendations
        recommendations = self._extract_recommendations(result.get('analysis', ''))
        result['recommendations'] = recommendations
        
        return result
    
    async def propose_features(
        self,
        context: AgentContext,
        market_insights: Optional[Dict] = None
    ) -> List[Dict]:
        """Propose new features based on analysis"""
        
        market_context = ""
        if market_insights:
            market_context = f"\n\nMarket Insights:\n{market_insights.get('summary', '')}"
        
        query = f"""Based on the current product features and market context, propose 3-5 high-value features that should be built next.

{market_context}

For each feature, provide:
- Title: Short, clear name
- Description: What it does and why it matters
- User Value: How it helps users
- Business Impact: Revenue, retention, acquisition, etc.
- Priority: Critical/High/Medium/Low
- Effort: Small/Medium/Large/XL
- Dependencies: What must exist first

Format as JSON:
[
  {{
    "title": "...",
    "description": "...",
    "user_value": "...",
    "business_impact": "...",
    "priority": "high",
    "effort": "medium",
    "dependencies": []
  }},
  ...
]
"""
        
        result = await self.analyze(context, query, temperature=0.7, max_tokens=3000)
        
        # Parse proposals
        proposals = self._parse_json_proposals(result.get('analysis', ''))
        
        return proposals
    
    def _extract_recommendations(self, analysis: str) -> List[Dict]:
        """Extract recommendations from analysis text"""
        import re
        
        recommendations = []
        
        # Look for numbered lists in Quick Wins section
        quick_wins_match = re.search(
            r'## Quick Wins\s*(.*?)(?=##|$)',
            analysis,
            re.DOTALL
        )
        
        if quick_wins_match:
            section = quick_wins_match.group(1)
            items = re.findall(r'\d+\.\s*(.+)', section)
            
            for item in items:
                # Parse: Feature - Why - Effort: X
                parts = item.split(' - ')
                if len(parts) >= 2:
                    recommendations.append({
                        'title': parts[0].strip(),
                        'rationale': parts[1].strip() if len(parts) > 1 else '',
                        'priority': 'high',
                        'type': 'quick_win'
                    })
        
        return recommendations
    
    def _parse_json_proposals(self, content: str) -> List[Dict]:
        """Parse JSON proposals from LLM response"""
        import json
        import re
        
        try:
            # Extract JSON array
            json_match = re.search(r'\[.*\]', content, re.DOTALL)
            if json_match:
                proposals = json.loads(json_match.group())
                return proposals
        except Exception as e:
            print(f"Failed to parse proposals JSON: {e}")
        
        return []


class MarketerAgent(AgentPersona):
    """
    Marketer agent - focuses on market positioning and user acquisition
    """
    
    @property
    def role(self) -> str:
        return "Growth Marketer"
    
    @property
    def expertise(self) -> List[str]:
        return [
            "Market analysis",
            "Competitive intelligence",
            "User acquisition",
            "Product positioning",
            "Growth strategies"
        ]
    
    @property
    def personality_prompt(self) -> str:
        return """You are a growth marketer with expertise in B2B and B2C software products.

Your approach:
- Analyze competitive landscape and market trends
- Identify differentiation opportunities
- Focus on user acquisition and retention
- Think about messaging and positioning
- Consider viral growth potential
- Assess market fit and timing

When analyzing a product:
1. Identify what makes it unique (or could make it unique)
2. Spot market gaps and opportunities
3. Suggest features that drive growth
4. Consider competitive responses
5. Think about go-to-market strategy

Be data-driven, growth-focused, and market-aware in your analysis."""
    
    async def analyze_market_fit(
        self,
        context: AgentContext
    ) -> Dict[str, Any]:
        """Analyze product-market fit and positioning"""
        
        query = """Analyze this product from a market perspective. Provide:

1. Competitive Positioning: How does this compare to alternatives?
2. Differentiation Opportunities: What could make this unique?
3. Market Gaps: What user needs are underserved?
4. Growth Levers: What features would drive user acquisition?
5. Retention Factors: What keeps users coming back?

Format your response as:

## Competitive Positioning
[Analysis]

## Differentiation Opportunities
1. [Opportunity] - [Market impact]
2. ...

## Market Gaps
1. [Gap] - [User need] - [Market size]
2. ...

## Growth Levers
1. [Feature] - [How it drives growth]
2. ...

## Retention Factors
[Analysis]
"""
        
        result = await self.analyze(context, query, temperature=0.6)
        
        # Extract growth opportunities
        opportunities = self._extract_opportunities(result.get('analysis', ''))
        result['opportunities'] = opportunities
        
        return result
    
    async def validate_suggestions(
        self,
        context: AgentContext,
        suggestions: List[Dict]
    ) -> List[Dict]:
        """Validate and enhance PM suggestions from market perspective"""
        
        suggestions_text = "\n\n".join([
            f"{idx+1}. {s.get('title')}\n"
            f"   {s.get('description', '')}\n"
            f"   Priority: {s.get('priority')}, Effort: {s.get('effort')}"
            for idx, s in enumerate(suggestions)
        ])
        
        query = f"""Review these feature suggestions from a market perspective:

{suggestions_text}

For each suggestion:
1. Assess market demand (High/Medium/Low)
2. Identify competitive advantage potential
3. Suggest positioning/messaging angles
4. Recommend any enhancements to increase market impact

Format as JSON:
[
  {{
    "index": 1,
    "market_demand": "high",
    "competitive_advantage": "...",
    "positioning": "...",
    "enhancements": ["..."],
    "recommendation": "proceed/enhance/reconsider"
  }},
  ...
]
"""
        
        result = await self.analyze(context, query, temperature=0.5, max_tokens=2500)
        
        # Parse validation results
        validations = self._parse_json_validations(result.get('analysis', ''))
        
        # Merge validations back into suggestions
        enhanced = []
        for idx, suggestion in enumerate(suggestions):
            validation = next((v for v in validations if v.get('index') == idx + 1), {})
            
            enhanced_suggestion = {**suggestion}
            enhanced_suggestion['market_validation'] = {
                'demand': validation.get('market_demand', 'unknown'),
                'competitive_advantage': validation.get('competitive_advantage', ''),
                'positioning': validation.get('positioning', ''),
                'recommendation': validation.get('recommendation', 'proceed')
            }
            
            if validation.get('enhancements'):
                enhanced_suggestion['market_enhancements'] = validation['enhancements']
            
            enhanced.append(enhanced_suggestion)
        
        return enhanced
    
    def _extract_opportunities(self, analysis: str) -> List[Dict]:
        """Extract growth opportunities from analysis"""
        import re
        
        opportunities = []
        
        # Extract from Growth Levers section
        growth_match = re.search(
            r'## Growth Levers\s*(.*?)(?=##|$)',
            analysis,
            re.DOTALL
        )
        
        if growth_match:
            section = growth_match.group(1)
            items = re.findall(r'\d+\.\s*(.+)', section)
            
            for item in items:
                parts = item.split(' - ')
                if parts:
                    opportunities.append({
                        'title': parts[0].strip(),
                        'impact': parts[1].strip() if len(parts) > 1 else '',
                        'type': 'growth_lever'
                    })
        
        return opportunities
    
    def _parse_json_validations(self, content: str) -> List[Dict]:
        """Parse validation results from JSON"""
        import json
        import re
        
        try:
            json_match = re.search(r'\[.*\]', content, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
        except Exception as e:
            print(f"Failed to parse validation JSON: {e}")
        
        return []


# Multi-agent conversation facilitator

class ConversationFacilitator:
    """
    Orchestrates multi-agent discussions
    
    Manages turn-taking, topic focus, and consensus building
    """
    
    def __init__(self, llm_client):
        self.llm_client = llm_client
    
    async def facilitate_discussion(
        self,
        agents: List[AgentPersona],
        topic: str,
        context: AgentContext,
        max_turns: int = 5
    ) -> Dict[str, Any]:
        """
        Facilitate a multi-agent discussion
        
        Returns:
            Dict with conversation history and consensus
        """
        
        print(f"🎭 Starting discussion: {topic}")
        print(f"   Participants: {', '.join(a.role for a in agents)}")
        
        conversation = []
        
        # Initial round - each agent provides their perspective
        for agent in agents:
            print(f"   → {agent.role} analyzing...")
            
            result = await agent.analyze(
                context,
                f"Discuss: {topic}. Share your perspective based on your expertise.",
                temperature=0.6
            )
            
            message = Message(
                role=agent.role,
                content=result.get('analysis', ''),
                reasoning=result.get('reasoning')
            )
            conversation.append(message)
            
            # Add to all other agents' memory
            for other_agent in agents:
                if other_agent != agent:
                    other_agent.conversation_memory.append(message)
        
        # Follow-up rounds - agents respond to each other
        for turn in range(max_turns - 1):
            print(f"   Round {turn + 2}/{max_turns}")
            
            for agent in agents:
                # Build query referencing others' points
                other_points = self._summarize_other_perspectives(
                    agent,
                    agents,
                    conversation
                )
                
                query = f"""Based on the discussion so far:

{other_points}

Continue the discussion on: {topic}

Build on others' points, identify agreements/disagreements, and work toward actionable recommendations."""
                
                result = await agent.analyze(context, query, temperature=0.6)
                
                message = Message(
                    role=agent.role,
                    content=result.get('analysis', ''),
                    reasoning=result.get('reasoning')
                )
                conversation.append(message)
                
                # Share with other agents
                for other_agent in agents:
                    if other_agent != agent:
                        other_agent.conversation_memory.append(message)
        
        # Synthesize consensus
        print("   → Synthesizing consensus...")
        consensus = await self._synthesize_consensus(agents, conversation, topic)
        
        return {
            'topic': topic,
            'conversation': conversation,
            'consensus': consensus,
            'participants': [a.role for a in agents]
        }
    
    def _summarize_other_perspectives(
        self,
        current_agent: AgentPersona,
        all_agents: List[AgentPersona],
        conversation: List[Message]
    ) -> str:
        """Summarize what other agents have said"""
        
        lines = []
        for agent in all_agents:
            if agent == current_agent:
                continue
            
            # Get their last message
            agent_messages = [m for m in conversation if m.role == agent.role]
            if agent_messages:
                last = agent_messages[-1]
                lines.append(f"{agent.role} says:\n{last.content[:500]}...\n")
        
        return "\n".join(lines)
    
    async def _synthesize_consensus(
        self,
        agents: List[AgentPersona],
        conversation: List[Message],
        topic: str
    ) -> Dict[str, Any]:
        """Use LLM to synthesize consensus from conversation"""
        
        # Build conversation summary
        conv_text = "\n\n".join([
            f"{msg.role}:\n{msg.content}"
            for msg in conversation
        ])
        
        messages = [
            {
                "role": "system",
                "content": "You are an expert facilitator synthesizing a multi-expert discussion into actionable conclusions."
            },
            {
                "role": "user",
                "content": f"""Review this discussion between {', '.join(a.role for a in agents)}:

Topic: {topic}

Discussion:
{conv_text}

Synthesize the discussion into:
1. Key Points of Agreement
2. Key Points of Disagreement (if any)
3. Actionable Recommendations (ranked by priority)
4. Next Steps

Format as:

## Agreement
[Summary]

## Disagreement
[Summary or "None"]

## Recommendations
1. [Recommendation] - Priority: High/Medium/Low - Owner: [Role]
2. ...

## Next Steps
1. [Step]
2. ...
"""
            }
        ]
        
        try:
            response = await self.llm_client.chat(
                messages=messages,
                temperature=0.3,
                max_tokens=2000
            )
            
            content = response.get('content', '')
            
            # Parse into structured format
            return {
                'summary': content,
                'recommendations': self._extract_consensus_recommendations(content)
            }
            
        except Exception as e:
            print(f"Error synthesizing consensus: {e}")
            return {
                'summary': "Error synthesizing consensus",
                'recommendations': []
            }
    
    def _extract_consensus_recommendations(self, content: str) -> List[Dict]:
        """Extract recommendations from consensus summary"""
        import re
        
        recommendations = []
        
        rec_match = re.search(
            r'## Recommendations\s*(.*?)(?=##|$)',
            content,
            re.DOTALL
        )
        
        if rec_match:
            section = rec_match.group(1)
            items = re.findall(r'\d+\.\s*(.+)', section)
            
            for item in items:
                # Parse: [Rec] - Priority: X - Owner: Y
                parts = item.split(' - ')
                
                rec = {
                    'title': parts[0].strip(),
                    'priority': 'medium',
                    'owner': ''
                }
                
                for part in parts[1:]:
                    if 'Priority:' in part:
                        rec['priority'] = part.split(':')[1].strip().lower()
                    elif 'Owner:' in part:
                        rec['owner'] = part.split(':')[1].strip()
                
                recommendations.append(rec)
        
        return recommendations