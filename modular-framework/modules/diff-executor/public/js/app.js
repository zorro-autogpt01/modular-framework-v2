// Diff Executor App
class DiffExecutorApp {
    constructor() {
        this.ws = null;
        this.jobs = new Map();
        this.selectedJobId = null;
        this.currentFilter = 'all';

        this.init();
    }

    init() {
        this.connectWebSocket();
        this.setupEventListeners();
        this.loadJobs();
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.updateConnectionStatus(true);
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.updateConnectionStatus(false);
            // Reconnect after 3 seconds
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleWebSocketMessage(message);
        };
    }

    handleWebSocketMessage(message) {
        console.log('WebSocket message:', message);

        switch (message.type) {
            case 'connected':
                this.updateStatus(message.data);
                break;
            case 'job:created':
            case 'job:processing':
            case 'job:staged':
            case 'job:promoted':
            case 'job:failed':
            case 'job:rejected':
                this.updateJob(message.data);
                break;
        }
    }

    updateConnectionStatus(connected) {
        const statusEl = document.getElementById('connection-status');
        if (connected) {
            statusEl.textContent = '⚡ Connected';
            statusEl.className = 'status-indicator connected';
        } else {
            statusEl.textContent = '⚡ Disconnected';
            statusEl.className = 'status-indicator disconnected';
        }
    }

    updateStatus(data) {
        document.getElementById('active-jobs').textContent = `Active Jobs: ${data.jobCount || 0}`;

        const stagingStatus = data.stagingStatus;
        if (stagingStatus && stagingStatus.available) {
            document.getElementById('staging-status').textContent =
                `Staging: ${stagingStatus.activeJobs || 0} active`;
        }
    }

    setupEventListeners() {
        // Filter buttons
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentFilter = e.target.dataset.status;
                this.renderJobList();
            });
        });

        // Action buttons
        document.getElementById('create-job-btn').addEventListener('click', () => {
            this.showCreateJobModal();
        });

        document.getElementById('refresh-btn').addEventListener('click', () => {
            this.loadJobs();
        });

        // Create Job Modal
        const modal = document.getElementById('create-job-modal');
        const closeBtn = modal.querySelector('.close');
        const cancelBtn = modal.querySelector('.cancel-btn');
        const form = document.getElementById('create-job-form');

        closeBtn.addEventListener('click', () => this.hideCreateJobModal());
        cancelBtn.addEventListener('click', () => this.hideCreateJobModal());

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.createJob();
        });

        // Promote Job Modal
        const promoteModal = document.getElementById('promote-job-modal');
        const promoteCloseBtn = promoteModal.querySelector('.close');
        const promoteCancelBtn = promoteModal.querySelector('.cancel-promote-btn');
        const promoteForm = document.getElementById('promote-job-form');

        promoteCloseBtn.addEventListener('click', () => this.hidePromoteModal());
        promoteCancelBtn.addEventListener('click', () => this.hidePromoteModal());

        promoteForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.submitPromotion();
        });

        // Connection dropdown change handler
        document.getElementById('promote-connection').addEventListener('change', (e) => {
            this.updateRepoDropdown(e.target.value);
        });

        // Add/remove file buttons
        document.getElementById('add-file-btn').addEventListener('click', () => {
            this.addTargetFileInput();
        });

        window.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideCreateJobModal();
            }
            if (e.target === promoteModal) {
                this.hidePromoteModal();
            }
        });
    }

    async loadJobs() {
        try {
            const response = await fetch('/api/jobs');
            const data = await response.json();

            this.jobs.clear();
            data.jobs.forEach(job => {
                this.jobs.set(job.id, job);
            });

            this.renderJobList();
        } catch (error) {
            console.error('Error loading jobs:', error);
        }
    }

    renderJobList() {
        const container = document.getElementById('job-list');
        container.innerHTML = '';

        const filteredJobs = Array.from(this.jobs.values()).filter(job => {
            return this.currentFilter === 'all' || job.status === this.currentFilter;
        });

        if (filteredJobs.length === 0) {
            container.innerHTML = '<div class="empty-state">No jobs found</div>';
            return;
        }

        filteredJobs.forEach(job => {
            const jobEl = document.createElement('div');
            jobEl.className = 'job-item';
            if (job.id === this.selectedJobId) {
                jobEl.classList.add('selected');
            }

            jobEl.innerHTML = `
                <div class="job-header">
                    <span class="job-id">${job.id.substring(0, 8)}</span>
                    <span class="job-status ${job.status}">${job.status.toUpperCase()}</span>
                </div>
                <div class="job-meta">
                    ${job.source ? job.source.type : 'unknown'} • 
                    ${job.targetFiles ? job.targetFiles.length : 0} files • 
                    ${new Date(job.createdAt).toLocaleString()}
                </div>
            `;

            jobEl.addEventListener('click', () => this.selectJob(job.id));
            container.appendChild(jobEl);
        });
    }

    async selectJob(jobId) {
        this.selectedJobId = jobId;
        this.renderJobList();

        try {
            const response = await fetch(`/api/jobs/${jobId}`);
            const job = await response.json();
            this.renderJobDetails(job);
        } catch (error) {
            console.error('Error loading job details:', error);
        }
    }

    renderJobDetails(job) {
        const container = document.getElementById('job-details');

        if (!job) {
            container.innerHTML = '<div class="empty-state">Select a job to view details</div>';
            return;
        }

        let html = `
            <div class="detail-section">
                <h3>Job Information</h3>
                <div class="detail-grid">
                    <span class="detail-label">ID:</span>
                    <span>${job.id}</span>
                    <span class="detail-label">Status:</span>
                    <span class="job-status ${job.status}">${job.status.toUpperCase()}</span>
                    <span class="detail-label">Source:</span>
                    <span>${job.source ? job.source.type : 'unknown'}</span>
                    <span class="detail-label">Created:</span>
                    <span>${new Date(job.createdAt).toLocaleString()}</span>
                </div>
            </div>
        `;

        if (job.targetFiles && job.targetFiles.length > 0) {
            html += `
                <div class="detail-section">
                    <h3>Target Files</h3>
                    <div class="file-list">
                        ${job.targetFiles.map(f => `
                            <div class="file-item">
                                ${f.connectionId}/${f.repoName}/${f.filePath}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        if (job.diff) {
            html += `
                <div class="detail-section">
                    <h3>Diff Content</h3>
                    <pre style="background: #f8f9fa; padding: 0.5rem; border-radius: 4px; overflow-x: auto; max-height: 300px;">
${this.escapeHtml(job.diff)}
                    </pre>
                </div>
            `;
        }

        if (job.status === 'staged') {
            html += `
                <div class="detail-section">
                    <h3>Actions</h3>
                    <div class="action-buttons">
                        <button class="action-btn primary" onclick="app.showPromoteDialog('${job.id}')">
                            ✅ Promote to Workspace
                        </button>
                        <button class="action-btn" onclick="app.previewChanges('${job.id}')">
                            👁️ Preview Changes
                        </button>
                        <button class="action-btn" onclick="app.rejectJob('${job.id}')">
                            ❌ Reject
                        </button>
                    </div>
                </div>
            `;
        }

        if (job.error) {
            html += `
                <div class="detail-section">
                    <h3>Error</h3>
                    <div style="background: #f8d7da; color: #721c24; padding: 0.5rem; border-radius: 4px;">
                        ${job.error}
                    </div>
                </div>
            `;
        }
        if (job.validationResults) {
            const { allValid, results } = job.validationResults;
            html += `
                <div class="detail-section">
                <h3>Syntax Validation</h3>
                <div class="validation-status ${allValid ? 'valid' : 'invalid'}">
                    ${allValid ? '✅ All files passed validation' : '⚠️ Validation issues detected'}
                </div>
                <div class="validation-results">
                    ${results.map(r => `
                    <div class="validation-item ${r.valid ? 'valid' : r.skipped ? 'skipped' : 'invalid'}">
                        <span class="file-name">${r.file}</span>
                        ${r.valid ? '<span class="status">✅ Valid</span>' : 
                        r.skipped ? '<span class="status">⏭️ Skipped</span>' :
                        `<span class="status">❌ Error: ${r.error}</span>`}
                        ${r.line ? `<span class="location">Line ${r.line}:${r.column || 0}</span>` : ''}
                    </div>
                    `).join('')}
                </div>
                </div>
            `;
            
            // Show repairs if any
            if (job.repairs && job.repairs.length > 0) {
                html += `
                <div class="detail-section">
                    <h3>LLM Repair Attempts</h3>
                    ${job.repairs.map(repair => `
                    <div class="repair-item ${repair.success ? 'success' : 'failed'}">
                        <div class="repair-header">
                        <span class="file-name">${repair.file}</span>
                        <span class="repair-status">${repair.success ? '✅ Repaired' : '❌ Failed'}</span>
                        </div>
                        ${repair.originalError ? `<div class="original-error">Original: ${repair.originalError.error}</div>` : ''}
                        ${repair.revalidation ? `
                        <div class="revalidation ${repair.revalidation.valid ? 'valid' : 'invalid'}">
                            Revalidation: ${repair.revalidation.valid ? 'Passed ✅' : 'Failed ❌'}
                        </div>
                        ` : ''}
                    </div>
                    `).join('')}
                </div>
                `;
                }
            }

        container.innerHTML = html;
    }

    async previewChanges(jobId) {
        try {
            const response = await fetch(`/api/jobs/${jobId}/preview`);
            const previews = await response.json();

            // Add preview to the details view
            const container = document.getElementById('job-details');
            const previewHtml = `
                <div class="preview-container">
                    <h3>Preview Changes</h3>
                    ${previews.map(p => `
                        <div class="preview-file">
                            <div class="preview-header">${p.file} ${p.isNew ? '(NEW)' : ''}</div>
                            <div class="preview-diff">
                                ${this.renderDiff(p.original, p.staged)}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;

            container.innerHTML += previewHtml;
        } catch (error) {
            console.error('Error loading preview:', error);
            alert('Failed to load preview');
        }
    }

    renderDiff(original, staged) {
        // Simple diff rendering - in production you'd use a proper diff library
        const originalLines = original.split('\n');
        const stagedLines = staged.split('\n');

        let html = '';
        const maxLines = Math.max(originalLines.length, stagedLines.length);

        for (let i = 0; i < maxLines; i++) {
            const origLine = originalLines[i] || '';
            const stagedLine = stagedLines[i] || '';

            if (origLine !== stagedLine) {
                if (origLine && !stagedLine) {
                    html += `<div class="diff-line remove">- ${this.escapeHtml(origLine)}</div>`;
                } else if (!origLine && stagedLine) {
                    html += `<div class="diff-line add">+ ${this.escapeHtml(stagedLine)}</div>`;
                } else {
                    html += `<div class="diff-line remove">- ${this.escapeHtml(origLine)}</div>`;
                    html += `<div class="diff-line add">+ ${this.escapeHtml(stagedLine)}</div>`;
                }
            } else {
                html += `<div class="diff-line">  ${this.escapeHtml(origLine)}</div>`;
            }
        }

        return html;
    }

    showPromoteDialog(jobId) {
        const job = this.jobs.get(jobId);
        if (!job || !job.targetFiles) {
            alert('Job not found or has no target files');
            return;
        }

        // Extract unique connections and repos from targetFiles
        const connections = new Map();
        job.targetFiles.forEach(file => {
            if (!connections.has(file.connectionId)) {
                connections.set(file.connectionId, new Set());
            }
            connections.get(file.connectionId).add(file.repoName);
        });

        // Store for later use
        this.promoteConnections = connections;

        // Populate connection dropdown
        const connectionSelect = document.getElementById('promote-connection');
        connectionSelect.innerHTML = '';

        const connectionIds = Array.from(connections.keys());

        // If only one connection, select it automatically
        if (connectionIds.length === 1) {
            connectionSelect.innerHTML = `<option value="${connectionIds[0]}" selected>${connectionIds[0]}</option>`;
            this.updateRepoDropdown(connectionIds[0]);
        } else {
            connectionSelect.innerHTML = '<option value="">Select connection...</option>';
            connectionIds.forEach(connId => {
                connectionSelect.innerHTML += `<option value="${connId}">${connId}</option>`;
            });
        }

        // Set the job ID
        document.getElementById('promote-job-id').value = jobId;

        // Show the modal
        document.getElementById('promote-job-modal').classList.add('show');
    }

    updateRepoDropdown(connectionId) {
        const repoSelect = document.getElementById('promote-repo');
        repoSelect.innerHTML = '';

        if (!connectionId || !this.promoteConnections) {
            repoSelect.innerHTML = '<option value="">Select repository...</option>';
            return;
        }

        const repos = this.promoteConnections.get(connectionId);
        if (repos && repos.size > 0) {
            const repoArray = Array.from(repos);

            // If only one repo, select it automatically
            if (repoArray.length === 1) {
                repoSelect.innerHTML = `<option value="${repoArray[0]}" selected>${repoArray[0]}</option>`;
            } else {
                repoSelect.innerHTML = '<option value="">Select repository...</option>';
                repoArray.forEach(repo => {
                    repoSelect.innerHTML += `<option value="${repo}">${repo}</option>`;
                });
            }
        }
    }

    hidePromoteModal() {
        document.getElementById('promote-job-modal').classList.remove('show');
        document.getElementById('promote-job-form').reset();
    }

    async submitPromotion() {
        const form = document.getElementById('promote-job-form');
        const formData = new FormData(form);
        const jobId = document.getElementById('promote-job-id').value;

        const data = {
            repoId: formData.get('repoId'),
            connectionId: formData.get('connectionId'),
            createSnapshot: formData.get('createSnapshot') === 'on'
        };

        if (!data.repoId || !data.connectionId) {
            alert('Please select both connection and repository');
            return;
        }

        try {
            const response = await fetch(`/api/jobs/${jobId}/promote`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            const result = await response.json();

            if (result.success) {
                alert('Job promoted successfully!');
                this.hidePromoteModal();
                this.loadJobs();
            } else {
                alert(`Failed to promote: ${result.error}`);
            }
        } catch (error) {
            console.error('Error promoting job:', error);
            alert('Failed to promote job');
        }
    }

    async promoteJob(jobId, repoId, connectionId) {
        try {
            const response = await fetch(`/api/jobs/${jobId}/promote`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    repoId,
                    connectionId,
                    createSnapshot: true
                })
            });

            const result = await response.json();

            if (result.success) {
                alert('Job promoted successfully!');
                this.loadJobs();
            } else {
                alert(`Failed to promote: ${result.error}`);
            }
        } catch (error) {
            console.error('Error promoting job:', error);
            alert('Failed to promote job');
        }
    }

    async rejectJob(jobId) {
        const reason = prompt('Enter rejection reason (optional):');

        try {
            const response = await fetch(`/api/jobs/${jobId}/reject`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ reason })
            });

            const result = await response.json();

            if (result.success) {
                alert('Job rejected');
                this.loadJobs();
            } else {
                alert(`Failed to reject: ${result.error}`);
            }
        } catch (error) {
            console.error('Error rejecting job:', error);
            alert('Failed to reject job');
        }
    }

    showCreateJobModal() {
        document.getElementById('create-job-modal').classList.add('show');
    }

    hideCreateJobModal() {
        document.getElementById('create-job-modal').classList.remove('show');
        document.getElementById('create-job-form').reset();
    }

    addTargetFileInput() {
        const container = document.getElementById('target-files-list');
        const entry = document.createElement('div');
        entry.className = 'target-file-entry';
        entry.innerHTML = `
            <input type="text" name="connectionId" placeholder="Connection ID" required>
            <input type="text" name="repoName" placeholder="Repo Name" required>
            <input type="text" name="filePath" placeholder="File Path" required>
            <button type="button" class="remove-file-btn" onclick="this.parentElement.remove()">×</button>
        `;
        container.appendChild(entry);
    }

    async createJob() {
        const form = document.getElementById('create-job-form');
        const formData = new FormData(form);

        // Collect target files
        const targetFiles = [];
        const entries = document.querySelectorAll('.target-file-entry');
        entries.forEach(entry => {
            const connectionId = entry.querySelector('input[name="connectionId"]').value;
            const repoName = entry.querySelector('input[name="repoName"]').value;
            const filePath = entry.querySelector('input[name="filePath"]').value;

            if (connectionId && repoName && filePath) {
                targetFiles.push({ connectionId, repoName, filePath });
            }
        });

        const jobData = {
            diff: formData.get('diff'),
            targetFiles,
            source: {
                type: formData.get('sourceType'),
                user: 'manual'
            }
        };

        try {
            const response = await fetch('/api/jobs', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jobData)
            });

            const result = await response.json();

            if (result.success) {
                this.hideCreateJobModal();
                this.loadJobs();
                this.selectJob(result.job.id);
            } else {
                alert(`Failed to create job: ${result.error}`);
            }
        } catch (error) {
            console.error('Error creating job:', error);
            alert('Failed to create job');
        }
    }

    updateJob(jobData) {
        if (jobData.jobId) {
            // Reload the specific job
            this.loadJobById(jobData.jobId);
        } else if (jobData.id) {
            // Update job in map
            this.jobs.set(jobData.id, jobData);
            this.renderJobList();

            if (jobData.id === this.selectedJobId) {
                this.renderJobDetails(jobData);
            }
        } else {
            // Reload all jobs
            this.loadJobs();
        }
    }

    async loadJobById(jobId) {
        try {
            const response = await fetch(`/api/jobs/${jobId}`);
            const job = await response.json();

            this.jobs.set(job.id, job);
            this.renderJobList();

            if (job.id === this.selectedJobId) {
                this.renderJobDetails(job);
            }
        } catch (error) {
            console.error('Error loading job:', error);
        }
    }

    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}

// Initialize app when DOM is ready
const app = new DiffExecutorApp();
