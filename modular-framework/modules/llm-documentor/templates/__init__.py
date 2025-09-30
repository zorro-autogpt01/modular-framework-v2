# modules/llm-documentor/templates/__init__.py
"""
Prompt templates for documentation generation
Place this file in modules/llm-documentor/templates/__init__.py
"""

TEMPLATES = {
    "super_detailed.md": """You are a senior engineer documenting production systems. Generate comprehensive technical documentation.

# Context
{context}

# Requirements
Create super-detailed documentation that includes:

## Module Overview
- Purpose and core responsibilities
- Position in system architecture
- Key design decisions and trade-offs

## Public API
- All exported functions/classes with complete signatures
- Parameter types, defaults, and validation rules
- Return values and types
- Side effects and state changes

## Implementation Details
- Core algorithms and data structures
- Preconditions, invariants, and postconditions
- Edge cases and error boundaries
- Concurrency considerations

## Error Handling
- Exception hierarchy
- Error codes and messages
- Recovery strategies
- Logging and monitoring points

## Performance Profile
- Time and space complexity
- Optimization strategies employed
- Benchmarks and bottlenecks
- Caching strategies

## Security Considerations
- Authentication/authorization requirements
- Input validation and sanitization
- Sensitive data handling
- Security boundaries

## Dependencies
- External libraries (versions, licenses)
- Internal module dependencies
- Optional dependencies
- Dependency injection points

## Testing Strategy
- Unit test coverage
- Integration test scenarios
- Performance test baselines
- Testing utilities provided

## Extension Points
- Interfaces for customization
- Plugin architecture
- Event hooks
- Configuration options

## Migration Guide
- Breaking changes from previous versions
- Deprecation notices
- Upgrade paths

Cite specific files and line numbers where applicable using the format: `[filename:line]`""",

    "detailed.md": """Generate detailed component-level documentation for a development team.

# Context
{context}

# Requirements
Create comprehensive component documentation including:

## Component Summary
- Primary purpose and responsibilities
- Key features and capabilities

## Architecture
- Component structure and organization
- Internal modules and their relationships
- Data flow patterns

## Interfaces
- Input/output contracts
- Data models and schemas
- API endpoints or methods

## Configuration
- Environment variables
- Configuration files
- Feature flags
- Runtime parameters

## Key Workflows
- Main processing flows (step-by-step)
- State transitions
- Event handling
- Background processes

## Error Handling
- Common error scenarios
- Error recovery mechanisms
- Retry logic and circuit breakers
- Alerting triggers

## Observability
- Logging strategy and key log points
- Metrics and KPIs
- Distributed tracing
- Health checks

## Dependencies
- External services
- Database connections
- Message queues
- Caching layers

## Deployment
- Container configuration
- Resource requirements
- Scaling considerations
- Rollback procedures

## Maintenance
- Common operational tasks
- Troubleshooting guide
- Performance tuning tips
- Backup and recovery

Format as clear, readable Markdown with code examples where relevant.""",

    "high_level.md": """Create a high-level system overview for stakeholders and new team members.

# Context
{context}

# Requirements
Generate an executive-level system overview including:

## Executive Summary
- System purpose and business value
- Target users and use cases
- Key capabilities and features

## Problem Statement
- Business challenges addressed
- Technical problems solved
- Market positioning

## System Architecture
- High-level component diagram (describe in Mermaid syntax)
- Major subsystems and their roles
- Technology stack overview
- Deployment architecture

## Data Flow
- End-to-end data pipeline
- Key data transformations
- Data storage strategy
- Data governance considerations

## Integration Points
- External systems and APIs
- Third-party services
- Partner integrations
- Data import/export

## Security Model
- Authentication and authorization approach
- Data privacy measures
- Compliance requirements (GDPR, SOC2, etc.)
- Security boundaries and threat model

## Performance & Scale
- Current scale metrics
- Performance SLAs
- Scalability approach
- Growth projections

## Operational Model
- Deployment strategy
- Monitoring and alerting
- Support model
- Disaster recovery

## Roadmap
- Recent achievements
- Current initiatives
- Future enhancements
- Technical debt considerations

## Success Metrics
- Business KPIs
- Technical metrics
- User satisfaction measures

Format for non-technical stakeholders while maintaining technical accuracy.""",

    "api_reference.md": """Generate comprehensive API reference documentation from the provided specification.

# Context
{context}

# Requirements
Create developer-friendly API documentation including:

## API Overview
- Base URL and versioning
- Authentication methods
- Rate limiting policies
- General conventions

## Endpoints
For each endpoint provide:

### Endpoint Name
- **Path**: HTTP method and path with parameters
- **Description**: What the endpoint does
- **Authentication**: Required authentication/authorization
- **Tags**: Functional grouping

### Request
- **Headers**: Required and optional headers
- **Path Parameters**: Name, type, description, constraints
- **Query Parameters**: Name, type, required, default, description
- **Request Body**: 
  - Content-Type
  - Schema definition
  - Field descriptions
  - Validation rules
  - Example JSON

### Response
- **Success Response** (2xx):
  - Status code and meaning
  - Response schema
  - Field descriptions
  - Example JSON
- **Error Responses** (4xx, 5xx):
  - Status codes
  - Error schema
  - Common error scenarios

### Examples
- cURL command
- JavaScript/TypeScript example
- Python example
- Response examples for different scenarios

### Notes
- Rate limits specific to endpoint
- Caching behavior
- Idempotency
- Webhooks triggered
- Related endpoints

## Models/Schemas
- Detailed schema definitions
- Enumerations
- Validation rules
- Relationships

## Webhooks
- Event types
- Payload schemas
- Security/verification
- Retry policy

## SDKs
- Available SDKs
- Installation
- Quick start examples

Include realistic examples and be precise about data types and constraints.""",

    "db_schema.md": """Document the database schema comprehensively from the provided SQL and migrations.

# Context
{context}

# Requirements
Generate complete database documentation including:

## Database Overview
- Database type and version
- Character set and collation
- Naming conventions
- Key design decisions

## Tables
For each table provide:

### Table Name
- **Purpose**: Business purpose and data stored
- **Records**: Estimated row count and growth rate
- **Columns**:
  - Column name
  - Data type and size
  - Nullable
  - Default value
  - Description
  - Business rules
  - PII classification

### Keys and Constraints
- Primary key
- Foreign keys (with cascade rules)
- Unique constraints
- Check constraints
- Composite keys

### Indexes
- Index name and type
- Columns covered
- Performance rationale
- Usage patterns

### Triggers
- Trigger events
- Business logic
- Side effects

## Relationships
- ERD in Mermaid format:
```mermaid
erDiagram
    [Define all tables and relationships]
```
- Cardinality explanations
- Referential integrity rules
- Orphan handling

## Views
- View definitions
- Purpose and usage
- Performance considerations
- Refresh strategies

## Stored Procedures/Functions
- Procedure name and parameters
- Purpose and logic
- Usage examples
- Performance impact

## Data Patterns
### Common Queries
- Query patterns with EXPLAIN plans
- Optimization tips
- Index usage

### Data Integrity
- Validation rules
- Data quality checks
- Archival policies

### Performance
- Partitioning strategy
- Sharding approach
- Query optimization guidelines
- Connection pooling recommendations

## Migration History
- Schema version tracking
- Recent changes
- Pending migrations
- Rollback procedures

## Maintenance
- Backup schedule and strategy
- Maintenance windows
- Monitoring queries
- Cleanup procedures

Include SQL examples and performance considerations throughout.""",

    "operations.md": """Create comprehensive operations and deployment documentation.

# Context
{context}

# Requirements
Generate DevOps/SRE documentation including:

## Deployment Architecture
- Infrastructure overview (diagram in Mermaid)
- Compute resources
- Network topology
- Storage systems
- CDN/Load balancing

## Deployment Process
### CI/CD Pipeline
- Build process
- Test stages
- Deployment stages
- Rollback procedures

### Environments
- Development
- Staging  
- Production
- Environment promotion

### Configuration Management
- Configuration sources
- Secret management
- Feature flags
- Environment variables

## Container/Orchestration
### Docker Configuration
- Base images
- Multi-stage builds
- Image optimization
- Security scanning

### Kubernetes/Orchestration
- Deployment manifests
- Service definitions
- Ingress configuration
- Auto-scaling policies
- Resource limits

## Monitoring & Observability
### Metrics
- Key metrics and SLIs
- Dashboards
- Alert thresholds
- Escalation policies

### Logging
- Log aggregation
- Log levels and formats
- Retention policies
- Log analysis queries

### Tracing
- Distributed tracing setup
- Key transactions
- Performance baselines

## Operations Runbooks
### Startup Procedures
- Service startup order
- Health check sequence
- Warm-up procedures

### Shutdown Procedures  
- Graceful shutdown
- Connection draining
- Data persistence

### Common Issues
For each issue:
- Symptoms
- Root cause analysis steps
- Resolution steps
- Prevention measures

### Emergency Procedures
- Incident response process
- Emergency contacts
- Disaster recovery
- Data recovery

## Performance Tuning
- Resource optimization
- Caching strategies
- Database tuning
- Network optimization

## Security Operations
- Security scanning
- Vulnerability management
- Access control
- Audit logging
- Compliance checks

## Capacity Planning
- Growth projections
- Scaling triggers
- Resource planning
- Cost optimization

## Maintenance
- Upgrade procedures
- Patching strategy
- Certificate renewal
- Dependency updates

Provide specific commands and configuration examples where applicable.""",

    "cookbook.md": """Create practical how-to guides and recipes for common tasks.

# Context
{context}

# Requirements
Generate a cookbook with practical recipes including:

## Quick Start
### Prerequisites
- Required tools and versions
- Access requirements
- Initial setup steps

### Getting Started
1. Environment setup
2. Basic configuration
3. First run
4. Verification steps

## Common Tasks
For each task provide:

### Task Name
**Goal**: What you'll accomplish
**Time**: Estimated duration
**Difficulty**: Beginner/Intermediate/Advanced

**Prerequisites**:
- Required access
- Tools needed
- Prior knowledge

**Steps**:
1. Detailed step with explanation
   ```bash
   # Command example
   ```
2. Next step with context
   ```code
   # Code example
   ```

**Verification**:
- How to confirm success
- Expected output
- Common issues

**Related Tasks**: Links to similar recipes

## Development Recipes
- Setting up development environment
- Running tests locally
- Debugging techniques
- Code contribution workflow
- Performance profiling

## Integration Recipes  
- API integration examples
- Webhook setup
- Third-party service integration
- Data import/export

## Data Management
- Backup procedures
- Data migration
- Bulk operations
- Data cleanup
- Archival processes

## Troubleshooting Recipes
- Diagnostic procedures
- Common error solutions
- Performance issues
- Connectivity problems
- Data inconsistencies

## Advanced Recipes
- Custom extensions
- Plugin development
- Performance optimization
- Security hardening
- Scaling procedures

## Automation Scripts
- Useful scripts with explanations
- Batch operations
- Monitoring scripts
- Maintenance automation

## Tips & Tricks
- Productivity tips
- Hidden features
- Keyboard shortcuts
- CLI commands
- Best practices

Each recipe should be self-contained and tested. Include actual command examples and expected outputs."""
}

def get_template(name: str) -> str:
    """Get a template by name"""
    return TEMPLATES.get(name, TEMPLATES["high_level.md"])