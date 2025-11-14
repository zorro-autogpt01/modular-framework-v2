// History Module - Snapshot Management

const History = {
    snapshots: [],
    filters: {
        repo: '',
        type: ''
    },

    async init() {
        console.log('Initializing History module...');
        
        this.setupEventListeners();
        await this.loadRepositories();
    },

    setupEventListeners() {
        // Filter dropdowns
        document.getElementById('history-repo-filter')?.addEventListener('change', (e) => {
            this.filters.repo = e.target.value;
            this.applyFilters();
        });

        document.getElementById('history-type-filter')?.addEventListener('change', (e) => {
            this.filters.type = e.target.value;
            this.applyFilters();
        });

        // Create snapshot button
        document.getElementById('create-snapshot-btn')?.addEventListener('click', () => {
            this.showCreateSnapshotModal();
        });

        // WebSocket events
        WS.on('snapshot:created', (data) => {
            this.handleSnapshotCreated(data);
        });

        WS.on('snapshot:deleted', (data) => {
            this.handleSnapshotDeleted(data);
        });

        WS.on('snapshot:restored', (data) => {
            App.showToast('success', 'Snapshot Restored', `Files restored from snapshot ${data.snapshot_id}`);
            this.loadSnapshots();
        });
    },

    async loadRepositories() {
        try {
            const { repos } = await API.repos.list();
            
            const filter = document.getElementById('history-repo-filter');
            if (filter) {
                filter.innerHTML = '<option value="">All Repositories</option>';
                repos.forEach(repo => {
                    const option = document.createElement('option');
                    option.value = repo.id;
                    option.textContent = repo.name;
                    filter.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Failed to load repositories:', error);
        }
    },

    async loadSnapshots() {
        try {
            App.showLoading('Loading snapshots...');
            
            // Load snapshots for all repos or filtered repo
            if (this.filters.repo) {
                const [connection_id, repo_name] = this.filters.repo.split('/');
                const result = await API.history.list(connection_id, repo_name, null, 100);
                this.snapshots = result.snapshots || [];
            } else {
                // Load from all repos
                this.snapshots = [];
                const { repos } = await API.repos.list();
                
                for (const repo of repos) {
                    const [connection_id, repo_name] = repo.id.split('/');
                    try {
                        const result = await API.history.list(connection_id, repo_name, null, 50);
                        const snapshots = result.snapshots || [];
                        
                        // Add repo info to each snapshot
                        snapshots.forEach(s => {
                            s.repo_id = repo.id;
                            s.repo_name = repo.name;
                            s.connection_id = connection_id;
                        });
                        
                        this.snapshots.push(...snapshots);
                    } catch (error) {
                        console.error(`Failed to load snapshots for ${repo.id}:`, error);
                    }
                }
            }
            
            // Sort by timestamp
            this.snapshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            this.renderTimeline();
            App.hideLoading();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Load Failed', 'Failed to load snapshots');
        }
    },

    applyFilters() {
        this.loadSnapshots();
    },

    renderTimeline() {
        const container = document.getElementById('history-timeline');
        if (!container) return;

        const filteredSnapshots = this.snapshots.filter(snapshot => {
            if (this.filters.type && snapshot.type !== this.filters.type) {
                return false;
            }
            return true;
        });

        if (filteredSnapshots.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-history fa-3x text-muted"></i>
                    <h3>No snapshots found</h3>
                    <p>Create snapshots to save point-in-time copies of your repositories</p>
                    <button class="btn btn-primary" onclick="History.showCreateSnapshotModal()">
                        <i class="fas fa-camera"></i>
                        Create Snapshot
                    </button>
                </div>
            `;
            return;
        }

        container.innerHTML = filteredSnapshots.map(snapshot => this.renderTimelineItem(snapshot)).join('');
    },

    renderTimelineItem(snapshot) {
        const icon = this.getSnapshotIcon(snapshot.type);
        const color = this.getSnapshotColor(snapshot.type);
        
        return `
            <div class="timeline-item" data-snapshot-id="${snapshot.id}">
                <div class="timeline-marker" style="background: ${color}">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="timeline-content">
                    <div class="timeline-header">
                        <div>
                            <span class="timeline-title">${snapshot.type === 'manual' ? 'Manual Snapshot' : this.formatSnapshotType(snapshot.type)}</span>
                            ${snapshot.repo_name ? `<span class="badge badge-secondary">${snapshot.repo_name}</span>` : ''}
                        </div>
                        <span class="timeline-time">${App.formatRelativeTime(snapshot.timestamp)}</span>
                    </div>
                    ${snapshot.description ? `<div class="timeline-description">${snapshot.description}</div>` : ''}
                    <div class="timeline-metadata">
                        ${snapshot.author ? `<span><i class="fas fa-user"></i> ${snapshot.author}</span>` : ''}
                        ${snapshot.size ? `<span><i class="fas fa-database"></i> ${App.formatFileSize(snapshot.size)}</span>` : ''}
                        ${snapshot.files && snapshot.files.length > 0 ? 
                            `<span><i class="fas fa-file"></i> ${snapshot.files[0] === '*' ? 'All files' : `${snapshot.files.length} files`}</span>` : ''}
                    </div>
                    <div class="timeline-actions">
                        <button class="btn btn-sm btn-secondary" 
                                onclick="History.viewSnapshot('${snapshot.connection_id || snapshot.repo_id?.split('/')[0]}', '${snapshot.repo_name}', '${snapshot.id}')">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button class="btn btn-sm btn-secondary"
                                onclick="History.restoreSnapshot('${snapshot.connection_id || snapshot.repo_id?.split('/')[0]}', '${snapshot.repo_name}', '${snapshot.id}')">
                            <i class="fas fa-undo"></i> Restore
                        </button>
                        <button class="btn btn-sm btn-secondary"
                                onclick="History.compareSnapshot('${snapshot.connection_id || snapshot.repo_id?.split('/')[0]}', '${snapshot.repo_name}', '${snapshot.id}')">
                            <i class="fas fa-exchange-alt"></i> Compare
                        </button>
                        <button class="btn btn-sm btn-danger"
                                onclick="History.deleteSnapshot('${snapshot.connection_id || snapshot.repo_id?.split('/')[0]}', '${snapshot.repo_name}', '${snapshot.id}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    getSnapshotIcon(type) {
        const icons = {
            'manual': 'fa-camera',
            'auto': 'fa-clock',
            'pre-commit': 'fa-check',
            'pre-pull': 'fa-download',
            'pre-push': 'fa-upload',
            'pre-merge': 'fa-code-branch',
            'file-edit': 'fa-edit',
            'file-delete': 'fa-trash',
            'file-rename': 'fa-i-cursor'
        };
        return icons[type] || 'fa-save';
    },

    getSnapshotColor(type) {
        const colors = {
            'manual': 'var(--primary-color)',
            'auto': 'var(--secondary-color)',
            'pre-commit': 'var(--success-color)',
            'pre-pull': 'var(--info-color)',
            'pre-push': 'var(--warning-color)',
            'pre-merge': 'var(--danger-color)'
        };
        return colors[type] || 'var(--secondary-color)';
    },

    formatSnapshotType(type) {
        return type.split('-').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
    },

    showCreateSnapshotModal() {
        // Create modal HTML if it doesn't exist
        let modal = document.getElementById('snapshot-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'snapshot-modal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>Create Snapshot</h3>
                        <button class="modal-close" onclick="App.closeModal('snapshot-modal')">&times;</button>
                    </div>
                    <div class="modal-body">
                        <form id="snapshot-form">
                            <div class="form-group">
                                <label for="snapshot-repo">Repository</label>
                                <select id="snapshot-repo" class="form-control" required>
                                    <option value="">Select Repository</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label for="snapshot-type">Type</label>
                                <select id="snapshot-type" class="form-control">
                                    <option value="manual">Manual</option>
                                    <option value="checkpoint">Checkpoint</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label for="snapshot-description">Description</label>
                                <textarea id="snapshot-description" class="form-control" rows="3" 
                                          placeholder="Optional description of this snapshot"></textarea>
                            </div>
                            <div class="form-group">
                                <label>Files to Include</label>
                                <div class="form-check">
                                    <input type="radio" name="snapshot-files" id="snapshot-all-files" 
                                           class="form-check-input" value="all" checked>
                                    <label for="snapshot-all-files" class="form-check-label">
                                        All files
                                    </label>
                                </div>
                                <div class="form-check">
                                    <input type="radio" name="snapshot-files" id="snapshot-modified-files" 
                                           class="form-check-input" value="modified">
                                    <label for="snapshot-modified-files" class="form-check-label">
                                        Modified files only
                                    </label>
                                </div>
                            </div>
                        </form>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="App.closeModal('snapshot-modal')">Cancel</button>
                        <button class="btn btn-primary" onclick="History.createSnapshot()">Create Snapshot</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        // Populate repository dropdown
        this.populateSnapshotRepoDropdown();
        
        App.openModal('snapshot-modal');
    },

    async populateSnapshotRepoDropdown() {
        const select = document.getElementById('snapshot-repo');
        if (!select) return;

        try {
            const { repos } = await API.repos.list();
            select.innerHTML = '<option value="">Select Repository</option>';
            repos.forEach(repo => {
                const option = document.createElement('option');
                option.value = repo.id;
                option.textContent = `${repo.name} (${repo.status?.current || 'unknown'})`;
                select.appendChild(option);
            });
        } catch (error) {
            console.error('Failed to load repositories:', error);
        }
    },

    async createSnapshot() {
        const repoId = document.getElementById('snapshot-repo').value;
        const type = document.getElementById('snapshot-type').value;
        const description = document.getElementById('snapshot-description').value;
        const filesOption = document.querySelector('input[name="snapshot-files"]:checked').value;

        if (!repoId) {
            App.showToast('error', 'Missing Repository', 'Please select a repository');
            return;
        }

        const [connection_id, repo_name] = repoId.split('/');
        let files = [];

        // Get file list if modified only
        if (filesOption === 'modified') {
            try {
                const status = await API.repos.status(connection_id, repo_name);
                files = [
                    ...(status.status?.modified || []),
                    ...(status.status?.created || [])
                ];
            } catch (error) {
                console.error('Failed to get modified files:', error);
            }
        }

        try {
            App.showLoading('Creating snapshot...');
            App.closeModal('snapshot-modal');

            const result = await API.history.create(
                connection_id,
                repo_name,
                type,
                description,
                files
            );

            App.hideLoading();
            App.showToast('success', 'Snapshot Created', `Snapshot ${result.snapshot.id} created successfully`);

            // Clear form
            document.getElementById('snapshot-form')?.reset();

            // Reload snapshots
            await this.loadSnapshots();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Creation Failed', error.message);
        }
    },

    async viewSnapshot(connection_id, repo_name, snapshot_id) {
        try {
            App.showLoading('Loading snapshot...');
            
            const snapshot = await API.history.get(connection_id, repo_name, snapshot_id);
            
            App.hideLoading();
            
            // Create view modal
            this.showSnapshotViewModal(snapshot);
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Load Failed', error.message);
        }
    },

    showSnapshotViewModal(snapshot) {
        let modal = document.getElementById('snapshot-view-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'snapshot-view-modal';
            modal.className = 'modal modal-large';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Snapshot: ${snapshot.id}</h3>
                    <button class="modal-close" onclick="App.closeModal('snapshot-view-modal')">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="snapshot-details">
                        <div class="detail-row">
                            <label>Created:</label>
                            <span>${new Date(snapshot.timestamp).toLocaleString()}</span>
                        </div>
                        <div class="detail-row">
                            <label>Type:</label>
                            <span>${snapshot.type}</span>
                        </div>
                        ${snapshot.description ? `
                            <div class="detail-row">
                                <label>Description:</label>
                                <span>${snapshot.description}</span>
                            </div>
                        ` : ''}
                        ${snapshot.author ? `
                            <div class="detail-row">
                                <label>Author:</label>
                                <span>${snapshot.author}</span>
                            </div>
                        ` : ''}
                        ${snapshot.size ? `
                            <div class="detail-row">
                                <label>Size:</label>
                                <span>${App.formatFileSize(snapshot.size)}</span>
                            </div>
                        ` : ''}
                    </div>
                    
                    <h4>Files in Snapshot</h4>
                    <div class="snapshot-files">
                        ${snapshot.files && snapshot.files.length > 0 ? `
                            <ul class="file-list">
                                ${snapshot.files.map(file => `
                                    <li>
                                        <i class="${App.getFileIcon(file)}"></i>
                                        ${file}
                                    </li>
                                `).join('')}
                            </ul>
                        ` : '<p>All repository files</p>'}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="App.closeModal('snapshot-view-modal')">Close</button>
                </div>
            </div>
        `;

        App.openModal('snapshot-view-modal');
    },

    async restoreSnapshot(connection_id, repo_name, snapshot_id) {
        const confirm = await App.confirmAction(
            'Restore Snapshot',
            'This will replace current files with the snapshot version. Are you sure?'
        );

        if (!confirm) return;

        try {
            App.showLoading('Restoring snapshot...');
            
            const result = await API.history.restore(connection_id, repo_name, snapshot_id);
            
            App.hideLoading();
            App.showToast('success', 'Snapshot Restored', result.message);
            
            // Refresh workspace if it's the current repo
            if (window.Workspace && window.Workspace.currentRepo) {
                const { connection_id: curr_conn, repo_name: curr_repo } = window.Workspace.currentRepo;
                if (curr_conn === connection_id && curr_repo === repo_name) {
                    await window.Workspace.loadFileTree();
                    await window.Workspace.loadGitStatus();
                }
            }
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Restore Failed', error.message);
        }
    },

    async compareSnapshot(connection_id, repo_name, snapshot_id) {
        // For comparison, we need another snapshot to compare with
        // This could open a modal to select another snapshot
        App.showToast('info', 'Coming Soon', 'Snapshot comparison feature is coming soon');
    },

    async deleteSnapshot(connection_id, repo_name, snapshot_id) {
        const confirm = await App.confirmAction(
            'Delete Snapshot',
            'Are you sure you want to delete this snapshot? This cannot be undone.'
        );

        if (!confirm) return;

        try {
            App.showLoading('Deleting snapshot...');
            
            await API.history.delete(connection_id, repo_name, snapshot_id);
            
            App.hideLoading();
            App.showToast('success', 'Snapshot Deleted', 'Snapshot has been removed');
            
            // Remove from UI
            const item = document.querySelector(`[data-snapshot-id="${snapshot_id}"]`);
            if (item) {
                item.remove();
            }
            
            // Remove from local array
            this.snapshots = this.snapshots.filter(s => s.id !== snapshot_id);
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Delete Failed', error.message);
        }
    },

    handleSnapshotCreated(data) {
        // Add to snapshots array
        data.snapshot.repo_id = `${data.connection_id}/${data.repo_name}`;
        data.snapshot.repo_name = data.repo_name;
        data.snapshot.connection_id = data.connection_id;
        
        this.snapshots.unshift(data.snapshot);
        
        // Re-render if on history view
        if (App.currentView === 'history') {
            this.renderTimeline();
        }
    },

    handleSnapshotDeleted(data) {
        // Remove from snapshots array
        this.snapshots = this.snapshots.filter(s => s.id !== data.snapshot_id);
        
        // Re-render if on history view
        if (App.currentView === 'history') {
            this.renderTimeline();
        }
    },

    handleSnapshotChange(data) {
        // Generic handler for snapshot changes
        this.loadSnapshots();
    },

    onShow() {
        // Called when history view is shown
        this.loadSnapshots();
    }
};

// Export for global use
window.History = History;
