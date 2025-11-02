// modular-framework/modules/code-slicer-orchestrator/static/js/app.js

let config = {};
let models = [];

// Load config and models on page load
window.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    await loadModels();
    await loadExtractions();
});

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        config = data.config;
        
        document.getElementById('gateway-url').value = config.gateway_url;
    } catch (e) {
        console.error('Failed to load config:', e);
    }
}

async function loadModels() {
    try {
        const gatewayUrl = document.getElementById('gateway-url').value;
        const res = await fetch(`/api/models?gateway_url=${encodeURIComponent(gatewayUrl)}`);
        const data = await res.json();
        
        if (data.ok) {
            models = data.models;
            populateModelSelects();
        }
    } catch (e) {
        console.error('Failed to load models:', e);
    }
}

function populateModelSelects() {
    const selects = [
        document.getElementById('model-select'),
        document.getElementById('model-override')
    ];
    
    selects.forEach(select => {
        // Clear options
        select.innerHTML = select.id === 'model-override' 
            ? '<option value="">Use default</option>' 
            : '<option value="">Select a model...</option>';
        
        // Group by provider
        const byProvider = {};
        models.forEach(m => {
            const provider = m.provider_name || 'unknown';
            if (!byProvider[provider]) byProvider[provider] = [];
            byProvider[provider].push(m);
        });
        
        // Add optgroups
        Object.entries(byProvider).forEach(([provider, providerModels]) => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = provider;
            
            providerModels.forEach(m => {
                const option = document.createElement('option');
                option.value = m.id;
                option.textContent = `${m.display_name || m.model_name} (ID: ${m.id})`;
                optgroup.appendChild(option);
            });
            
            select.appendChild(optgroup);
        });
    });
    
    // Set default if configured
    if (config.default_model?.model_id) {
        document.getElementById('model-select').value = config.default_model.model_id;
    }
}

async function saveConfig() {
    const gatewayUrl = document.getElementById('gateway-url').value;
    const modelId = document.getElementById('model-select').value;
    
    const newConfig = {
        gateway_url: gatewayUrl,
        default_model: modelId ? { model_id: parseInt(modelId) } : null
    };
    
    try {
        const res = await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newConfig)
        });
        
        const data = await res.json();
        if (data.ok) {
            alert('✅ Configuration saved!');
            config = data.config;
            await loadModels();  // Reload models with new gateway URL
        } else {
            alert('❌ Failed to save: ' + data.error);
        }
    } catch (e) {
        alert('❌ Error: ' + e.message);
    }
}

async function extractCode(event) {
    event.preventDefault();
    
    const repoPath = document.getElementById('repo-path').value;
    const query = document.getElementById('query').value;
    const modelOverride = document.getElementById('model-override').value;
    const forceReindex = document.getElementById('force-reindex').checked;
    
    const payload = {
        repo_path: repoPath,
        query: query,
        force_reindex: forceReindex
    };
    
    if (modelOverride) {
        payload.model_id = parseInt(modelOverride);
    }
    
    // Show progress section
    document.getElementById('progress-section').style.display = 'block';
    document.getElementById('results-section').style.display = 'none';
    const progressLog = document.getElementById('progress-log');
    progressLog.innerHTML = '<p>🚀 Starting extraction...</p>';
    
    try {
        // Use streaming endpoint
        const eventSource = new EventSource('/api/extract/stream');
        
        eventSource.addEventListener('progress', (e) => {
            const data = JSON.parse(e.data);
            progressLog.innerHTML += `<p>⏳ ${formatStep(data.step)}</p>`;
        });
        
        eventSource.addEventListener('plan', (e) => {
            const plan = JSON.parse(e.data);
            progressLog.innerHTML += `
                <div class="plan-box">
                    <strong>📋 Extraction Plan:</strong>
                    <ul>
                        <li>Intent: ${plan.intent}</li>
                        <li>Targets: ${plan.targets.join(', ')}</li>
                        <li>Hints: ${plan.hints.join(', ')}</li>
                    </ul>
                </div>
            `;
        });
        
        eventSource.addEventListener('done', (e) => {
            const result = JSON.parse(e.data);
            displayResults(result);
            eventSource.close();
            loadExtractions();  // Refresh list
        });
        
        eventSource.addEventListener('error', (e) => {
            progressLog.innerHTML += '<p class="error">❌ Error occurred</p>';
            eventSource.close();
        });
        
        // Trigger the extraction
        fetch('/api/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
    } catch (e) {
        progressLog.innerHTML += `<p class="error">❌ Error: ${e.message}</p>`;
    }
}

function formatStep(step) {
    const steps = {
        'loading_profile': 'Loading repository profile...',
        'parsing_intent': 'Analyzing your request...',
        'expanding_targets': 'Expanding to related code...',
        'extracting': 'Extracting code snippets...',
        'reviewing': 'Reviewing completeness...',
        'generating_recommendations': 'Generating recommendations...'
    };
    return steps[step] || step;
}

function displayResults(result) {
    const resultsSection = document.getElementById('results-section');
    const resultsDiv = document.getElementById('results');
    
    resultsDiv.innerHTML = `
        <div class="results-grid">
            <div class="result-item">
                <strong>Extraction ID:</strong>
                <code>${result.extraction_id}</code>
            </div>
            <div class="result-item">
                <strong>Files Extracted:</strong>
                ${result.files_extracted}
            </div>
            <div class="result-item">
                <strong>Output Path:</strong>
                <code>${result.extraction_path}</code>
            </div>
        </div>
        
        <div class="next-steps">
            <h3>💡 Next Steps:</h3>
            <pre>${result.next_steps}</pre>
        </div>
        
        <div class="review">
            <h3>📊 Review:</h3>
            <p><strong>Sufficient:</strong> ${result.review.sufficient ? '✅ Yes' : '⚠️ No'}</p>
            ${result.review.missing?.length ? `
                <p><strong>Missing:</strong></p>
                <ul>${result.review.missing.map(m => `<li>${m}</li>`).join('')}</ul>
            ` : ''}
        </div>
    `;
    
    resultsSection.style.display = 'block';
}

async function loadExtractions() {
    try {
        const res = await fetch('/api/extractions');
        const data = await res.json();
        
        const listDiv = document.getElementById('extractions-list');
        
        if (!data.ok || data.extractions.length === 0) {
            listDiv.innerHTML = '<p>No past extractions found.</p>';
            return;
        }
        
        listDiv.innerHTML = '<table class="extractions-table"><thead><tr>' +
            '<th>ID</th><th>Query</th><th>Files</th><th>Created</th>' +
            '</tr></thead><tbody>' +
            data.extractions.map(e => `
                <tr>
                    <td><code>${e.name}</code></td>
                    <td>${e.query || 'N/A'}</td>
                    <td>${e.files_count}</td>
                    <td>${new Date(e.created_at).toLocaleString()}</td>
                </tr>
            `).join('') +
            '</tbody></table>';
        
    } catch (e) {
        console.error('Failed to load extractions:', e);
    }
}