# orchestrator_cli.py
import argparse
import sys
from pathlib import Path
from orchestrator_llm import LLMGatewayClient, OrchestratorLLM
from tabulate import tabulate  # pip install tabulate

def list_models_command(args):
    """List available models from gateway."""
    client = LLMGatewayClient(base_url=args.gateway)
    
    try:
        models = client.list_models()
    except Exception as e:
        print(f"❌ Failed to fetch models: {e}", file=sys.stderr)
        return 1
    
    if not models:
        print("⚠️  No models configured in gateway")
        print("\nTo add a model:")
        print("  1. Add provider: POST /api/providers")
        print("  2. Add model: POST /api/models")
        return 0
    
    # Group by provider
    by_provider = {}
    for m in models:
        provider = m.get('provider_name', 'unknown')
        by_provider.setdefault(provider, []).append(m)
    
    print(f"\n📋 Available Models ({len(models)} total):\n")
    
    for provider, provider_models in sorted(by_provider.items()):
        print(f"━━━ {provider} ({m.get('provider_kind', 'N/A')}) ━━━")
        
        table_data = []
        for m in provider_models:
            table_data.append([
                m['id'],
                m.get('key', 'N/A'),
                m['model_name'],
                m.get('display_name', 'N/A'),
                f"${float(m.get('input_cost_per_million', 0)):.2f}",
                f"${float(m.get('output_cost_per_million', 0)):.2f}"
            ])
        
        print(tabulate(
            table_data,
            headers=['ID', 'Key', 'Model Name', 'Display Name', 'In/$1M', 'Out/$1M'],
            tablefmt='simple'
        ))
        print()
    
    print("\n💡 Usage:")
    print("  By ID:   --model-id 1")
    print("  By Key:  --model-key 'openai:gpt-4o-mini'")
    print("  By Name: --model-name 'claude-sonnet-4.5-20250929'")
    
    return 0


def extract_command(args):
    """Run code extraction with LLM orchestration."""
    
    # Initialize gateway client with model selection
    try:
        client = LLMGatewayClient(
            base_url=args.gateway,
            model_id=args.model_id,
            model_key=args.model_key,
            model_name=args.model_name
        )
        
        # Print selected model info
        client.print_model_info()
        
    except ValueError as e:
        print(f"\n❌ Model selection error: {e}", file=sys.stderr)
        print("\n💡 Use --list-models to see available models", file=sys.stderr)
        return 1
    
    # Initialize orchestrator
    llm = OrchestratorLLM(client)
    
    from orchestrator_enhanced import SmartOrchestrator
    orchestrator = SmartOrchestrator(
        repo_path=args.repo,
        gateway_url=args.gateway
    )
    orchestrator.llm = llm  # Inject our configured LLM
    
    try:
        result = orchestrator.run(
            user_query=args.query,
            output_dir=args.out,
            force_reindex=args.force_reindex
        )
        
        print(f"\n✅ Success: {result['files_extracted']} files extracted")
        return 0
        
    except Exception as e:
        print(f"\n❌ Extraction failed: {e}", file=sys.stderr)
        return 1


def main():
    parser = argparse.ArgumentParser(
        description="Smart code extraction with LLM orchestration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List available models
  %(prog)s --list-models
  
  # Extract with specific model by ID
  %(prog)s --repo ./myapp --query "Add rate limiting" --model-id 1
  
  # Extract with model by key
  %(prog)s --repo ./myapp --query "How does auth work?" \\
    --model-key "anthropic:claude-sonnet-4.5-20250929"
  
  # Extract with model by name
  %(prog)s --repo ./myapp --query "Fix bug in /api/users" \\
    --model-name "claude-sonnet-4.5-20250929"
        """
    )
    
    # Global options
    parser.add_argument(
        "--gateway", 
        default=os.getenv("LLM_GATEWAY_URL", "http://localhost:3010"),
        help="LLM Gateway base URL (default: $LLM_GATEWAY_URL or http://localhost:3010)"
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Commands')
    
    # List models command
    list_parser = subparsers.add_parser(
        'list-models',
        help='List available models from gateway',
        aliases=['ls', 'models']
    )
    
    # Extract command
    extract_parser = subparsers.add_parser(
        'extract',
        help='Extract code with LLM orchestration',
        aliases=['run']
    )
    
    # Required args
    extract_parser.add_argument("--repo", required=True, help="Repository path")
    extract_parser.add_argument("--query", required=True, help="Natural language query")
    
    # Model selection (one of these required)
    model_group = extract_parser.add_argument_group('Model Selection (choose one)')
    model_group.add_argument("--model-id", type=int, help="Model ID from gateway")
    model_group.add_argument("--model-key", help="Model key (e.g., 'anthropic:claude-sonnet-4.5')")
    model_group.add_argument("--model-name", help="Model name (e.g., 'claude-sonnet-4.5-20250929')")
    
    # Optional args
    extract_parser.add_argument("--out", default="extraction_output", help="Output directory")
    extract_parser.add_argument("--force-reindex", action="store_true", help="Force profile regeneration")
    
    args = parser.parse_args()
    
    # Default to list-models if no command
    if not args.command:
        args.command = 'list-models'
    
    # Route to command handler
    if args.command in ['list-models', 'ls', 'models']:
        return list_models_command(args)
    elif args.command in ['extract', 'run']:
        # Validate that at least one model selector is provided
        if not any([args.model_id, args.model_key, args.model_name]):
            print("❌ Error: Must specify one of --model-id, --model-key, or --model-name", 
                  file=sys.stderr)
            print("💡 Run --list-models to see available models", file=sys.stderr)
            return 1
        return extract_command(args)
    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    sys.exit(main())