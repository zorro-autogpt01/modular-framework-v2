# modular-framework/modules/code-slicer-orchestrator/server/app.py
from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
import os
import json
import logging
from pathlib import Path
from datetime import datetime

from server.orchestrator_llm import LLMGatewayClient, OrchestratorLLM
from server.orchestrator_core import SmartOrchestrator
from server.config import Config

app = Flask(__name__, static_folder='../static')
CORS(app)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Load config
config = Config()

# Health check
@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "healthy", "service": "code-slicer-orchestrator"}), 200

# Serve frontend
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

# API Endpoints
@app.route('/api/models', methods=['GET'])
def list_models():
    """List available models from LLM Gateway."""
    try:
        gateway_url = request.args.get('gateway_url', config.gateway_url)
        client = LLMGatewayClient(base_url=gateway_url)
        models = client.list_models()
        return jsonify({"ok": True, "models": models})
    except Exception as e:
        logger.error(f"Failed to list models: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route('/api/config', methods=['GET'])
def get_config():
    """Get current configuration."""
    return jsonify({
        "ok": True,
        "config": {
            "gateway_url": config.gateway_url,
            "default_model": config.default_model
        }
    })

@app.route('/api/config', methods=['PUT'])
def update_config():
    """Update configuration."""
    try:
        data = request.json
        if 'gateway_url' in data:
            config.gateway_url = data['gateway_url']
        if 'default_model' in data:
            config.default_model = data['default_model']
        config.save()
        return jsonify({"ok": True, "config": config.to_dict()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route('/api/extract', methods=['POST'])
def extract():
    """
    Main extraction endpoint.
    
    Body:
    {
      "repo_path": "/path/to/repo",
      "query": "Add rate limiting to user creation",
      "model_id": 1,  // or model_key or model_name
      "force_reindex": false
    }
    """
    try:
        data = request.json
        
        # Validate required fields
        if not data.get('repo_path'):
            return jsonify({"ok": False, "error": "repo_path required"}), 400
        if not data.get('query'):
            return jsonify({"ok": False, "error": "query required"}), 400
        
        # Model selection
        model_id = data.get('model_id')
        model_key = data.get('model_key')
        model_name = data.get('model_name')
        
        if not any([model_id, model_key, model_name]):
            # Use default from config
            default = config.default_model
            if not default:
                return jsonify({
                    "ok": False, 
                    "error": "No model specified and no default configured"
                }), 400
            model_id = default.get('model_id')
            model_key = default.get('model_key')
            model_name = default.get('model_name')
        
        # Initialize gateway client
        gateway = LLMGatewayClient(
            base_url=config.gateway_url,
            model_id=model_id,
            model_key=model_key,
            model_name=model_name
        )
        
        # Get model info for response
        model_info = gateway._resolve_model()
        
        # Initialize orchestrator
        orchestrator = SmartOrchestrator(
            repo_path=data['repo_path'],
            gateway=gateway,
            data_dir=config.data_dir
        )
        
        # Run extraction
        result = orchestrator.run(
            user_query=data['query'],
            force_reindex=data.get('force_reindex', False)
        )
        
        return jsonify({
            "ok": True,
            "result": result,
            "model_used": {
                "id": model_info['id'],
                "name": model_info['model_name'],
                "display_name": model_info.get('display_name')
            }
        })
        
    except Exception as e:
        logger.error(f"Extraction failed: {e}", exc_info=True)
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route('/api/extract/stream', methods=['POST'])
def extract_stream():
    """
    Streaming extraction endpoint with live progress updates.
    
    Returns SSE stream with progress events.
    """
    def generate():
        try:
            data = request.json
            
            # Same setup as extract()
            gateway = LLMGatewayClient(
                base_url=config.gateway_url,
                model_id=data.get('model_id'),
                model_key=data.get('model_key'),
                model_name=data.get('model_name')
            )
            
            orchestrator = SmartOrchestrator(
                repo_path=data['repo_path'],
                gateway=gateway,
                data_dir=config.data_dir
            )
            
            # Emit progress events
            def progress_callback(event_type: str, data: dict):
                yield f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
            
            orchestrator.set_progress_callback(progress_callback)
            
            result = orchestrator.run(
                user_query=data['query'],
                force_reindex=data.get('force_reindex', False)
            )
            
            yield f"event: done\ndata: {json.dumps(result)}\n\n"
            
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(generate(), mimetype='text/event-stream')

@app.route('/api/extractions', methods=['GET'])
def list_extractions():
    """List past extraction results."""
    try:
        extractions_dir = Path(config.data_dir) / "extractions"
        if not extractions_dir.exists():
            return jsonify({"ok": True, "extractions": []})
        
        extractions = []
        for d in extractions_dir.iterdir():
            if d.is_dir():
                meta_file = d / "meta.json"
                if meta_file.exists():
                    meta = json.loads(meta_file.read_text())
                    extractions.append({
                        "name": d.name,
                        "created_at": meta.get('created_at'),
                        "query": meta.get('query'),
                        "files_count": len(meta.get('files', []))
                    })
        
        extractions.sort(key=lambda x: x.get('created_at', ''), reverse=True)
        return jsonify({"ok": True, "extractions": extractions})
        
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.getenv('PORT', 3050))
    app.run(host='0.0.0.0', port=port, debug=False)