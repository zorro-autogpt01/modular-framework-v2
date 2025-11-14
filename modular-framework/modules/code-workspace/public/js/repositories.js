// Repository Management Module

const Repositories = {
    repos: [],
    connections: [],

    async init() {
        console.log('Initializing Repositories module...');
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Load GitHub connections
        await this.loadConnections();
        
        // Load repositories
        await this.loadRepos();
    },

    setupEventListeners() {
        // Clone repository button
        document.getElementById('clone-repo-btn')?.addEventListener('click', () => {
            this.showCloneModal();
        });

        // Clone modal submit
        document.getElementById('clone-submit')?.addEventListener('click', async () => {
            await this.cloneRepository();
        });

        // WebSocket events
        WS.on('clone:start', (data) => {
            App.showToast('info', 'Cloning Started', `Cloning ${data.repo_name}...`);
        });

        WS.on('clone:complete', (data) => {
            App.showToast('success', 'Clone Complete', `${data.repo_name} has been cloned`);
            this.loadRepos();
        });

        WS.on('clone:error', (data) => {
            App.showToast('error', 'Clone Failed', data.error);
        });

        WS.on('fetch:complete', (data) => {
            this.updateRepoStatus(data.connection_id, data.repo_name);
        });
    },

    async loadConnections() {
        try {
            this.connections = await API.githubHub.getConnections();
            console.log('Loaded connections:', this.connections);
            
            // Update clone modal dropdown
            const select = document.getElementById('clone-connection');
            if (select) {
                select.innerHTML = '<option value="">Select Connection</option>';
                this.connections.forEach(conn => {
                    const option = document.createElement('option');
                    option.value = conn.id || conn.name;
                    option.textContent = conn.name || conn.id;
                    select.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Failed to load connections:', error);
            this.connections = [];
        }
    },

    async loadRepos() {
        try {
            App.showLoading('Loading repositories...');
            const response = await API.repos.list();
            this.repos = response.repos || [];
            this.renderRepos();
            App.hideLoading();
        } catch (error) {
            console.error('Failed to load repositories:', error);
            App.hideLoading();
            App.showToast('error', 'Load Failed', 'Failed to load repositories');
        }
    },

    renderRepos() {
        const container = document.getElementById('repos-list');
        if (!container) return;

        if (this.repos.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-folder-open fa-3x text-muted"></i>
                    <h3>No repositories cloned yet</h3>
                    <p>Clone a repository from GitHub to get started</p>
                    <button class="btn btn-primary" onclick="Repositories.showCloneModal()">
                        <i class="fas fa-download"></i>
                        Clone Repository
                    </button>
                </div>
            `;
            return;
        }

        container.innerHTML = this.repos.map(repo => this.renderRepoCard(repo)).join('');
        
        // Add event listeners to cards
        this.attachCardListeners();
    },

    renderRepoCard(repo) {
        const isClean = repo.status?.isClean;
        const statusClass = isClean ? 'clean' : 'dirty';
        const statusText = isClean ? 'Clean' : `${repo.status?.modified?.length || 0} modified`;
        
        return `
            <div class="repo-card" data-repo-id="${repo.id}">
                <div class="repo-card-header">
                    <div class="repo-card-title">
                        <i class="fab fa-github"></i>
                        <h3>${repo.name}</h3>
                        <span class="branch-badge">
                            <i class="fas fa-code-branch"></i>
                            ${repo.status?.current || 'unknown'}
                        </span>
                    </div>
                    <span class="repo-status ${statusClass}">
                        ${statusText}
                    </span>
                </div>
                
                <div class="repo-card-stats">
                    <span class="stat-item">
                        <i class="fas fa-arrow-up"></i>
                        ${repo.status?.ahead || 0} ahead
                    </span>
                    <span class="stat-item">
                        <i class="fas fa-arrow-down"></i>
                        ${repo.status?.behind || 0} behind
                    </span>
                    <span class="stat-item">
                        <i class="fas fa-file"></i>
                        ${repo.status?.modified?.length || 0} modified
                    </span>
                    <span class="stat-item">
                        <i class="fas fa-plus"></i>
                        ${repo.status?.created?.length || 0} new
                    </span>
                </div>
                
                ${repo.lastSync ? `
                    <div class="repo-last-sync">
                        <i class="fas fa-sync"></i>
                        Last sync: ${App.formatRelativeTime(repo.lastSync)}
                    </div>
                ` : ''}
                
                <div class="repo-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="Repositories.openRepo('${repo.id}')">
                        <i class="fas fa-folder-open"></i>
                        Open
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="Repositories.syncRepo('${repo.id}')">
                        <i class="fas fa-sync"></i>
                        Sync
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="Repositories.pullRepo('${repo.id}')">
                        <i class="fas fa-download"></i>
                        Pull
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="Repositories.pushRepo('${repo.id}')">
                        <i class="fas fa-upload"></i>
                        Push
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="Repositories.deleteRepo('${repo.id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    },

    attachCardListeners() {
        // Add any additional card-specific listeners here
    },

    showCloneModal() {
        App.openModal('clone-modal');
        
        // Add connection change listener for auto-population
        const connectionSelect = document.getElementById('clone-connection');
        if (connectionSelect && !connectionSelect.dataset.listenerAdded) {
            connectionSelect.addEventListener('change', (e) => this.handleConnectionSelect(e));
            connectionSelect.dataset.listenerAdded = 'true';
        }
    },

    async handleConnectionSelect(e) {
        const connectionId = e.target.value;
        
        if (!connectionId) {
            // Clear form if no connection selected
            document.getElementById('clone-url').value = '';
            document.getElementById('clone-name').value = '';
            document.getElementById('clone-branch').innerHTML = '<option value="">Select branch...</option>';
            return;
        }
        
        try {
            App.showLoading('Loading repository details...');
            
            // Get connection details from github-hub
            const connection = await API.githubHub.getConnection(connectionId);
            
            // Auto-fill repository URL
            document.getElementById('clone-url').value = connection.repo_url || '';
            
            // Auto-fill local name (extract repo name from URL)
            const repoName = this.extractRepoName(connection.repo_url);
            document.getElementById('clone-name').value = repoName;
            
            // Load and populate branches
            await this.populateBranchesDropdown(connectionId, connection.default_branch);
            
            App.hideLoading();
        } catch (error) {
            console.error('Failed to load connection details:', error);
            App.hideLoading();
            App.showToast('error', 'Failed to load repository details', error.message);
        }
    },

    extractRepoName(repoUrl) {
        if (!repoUrl) return '';
        
        // Extract repo name from various URL formats:
        // https://github.com/owner/repo.git
        // https://github.com/owner/repo
        // git@github.com:owner/repo.git
        const match = repoUrl.match(/[/:]([^/]+)\/([^/]+?)(\.git)?$/);
        if (match) {
            return match[2].replace('.git', '');
        }
        
        return '';
    },

    async populateBranchesDropdown(connectionId, defaultBranch = 'main') {
        const branchSelect = document.getElementById('clone-branch');
        
        console.log('🌿 populateBranchesDropdown called with:', { connectionId, defaultBranch });
        
        // Convert to dropdown if it's not already
        if (branchSelect.tagName !== 'SELECT') {
            const newSelect = document.createElement('select');
            newSelect.id = 'clone-branch';
            newSelect.className = 'form-control';
            newSelect.required = true;
            branchSelect.parentNode.replaceChild(newSelect, branchSelect);
        }
        
        const select = document.getElementById('clone-branch');
        select.innerHTML = '<option value="">Loading branches...</option>';
        
        try {
            console.log('📡 Fetching branches for connection:', connectionId);
            const response = await API.githubHub.getBranches(connectionId);
            console.log('📦 Branches response:', response);
            
            const branches = response.branches || [];
            console.log('🌿 Extracted branches:', branches);
            
            select.innerHTML = '';
            
            if (branches.length === 0) {
                console.warn('⚠️ No branches found, using default');
                select.innerHTML = '<option value="main">main</option>';
                return;
            }
            
            // Add all branches
            branches.forEach(branch => {
                // ✅ FIXED: Handle both string and object formats
                const branchName = typeof branch === 'string' ? branch : branch.name;
                
                console.log('➕ Adding branch:', branchName);
                const option = document.createElement('option');
                option.value = branchName;
                option.textContent = branchName;
                
                // Pre-select default branch
                if (branchName === defaultBranch) {
                    option.selected = true;
                    console.log('✅ Pre-selected default branch:', branchName);
                }
                
                select.appendChild(option);
            });
            
            console.log('✅ Populated', branches.length, 'branches');
            
            // If default branch not found, select first branch
            if (!select.value && branches.length > 0) {
                const firstBranch = typeof branches[0] === 'string' ? branches[0] : branches[0].name;
                select.value = firstBranch;
                console.log('📌 Selected first branch as fallback:', firstBranch);
            }
            
        } catch (error) {
            console.error('❌ Failed to load branches:', error);
            // Fallback to common branch names
            select.innerHTML = `
                <option value="main">main</option>
                <option value="master">master</option>
            `;
            select.value = defaultBranch || 'main';
        }
    },

    async cloneRepository() {
        const connectionId = document.getElementById('clone-connection').value;
        const repoUrl = document.getElementById('clone-url').value;
        const repoName = document.getElementById('clone-name').value;
        const branch = document.getElementById('clone-branch').value || 'main';
        const depth = parseInt(document.getElementById('clone-depth').value) || 0;

        if (!connectionId || !repoUrl || !repoName) {
            App.showToast('error', 'Missing Information', 'Please fill in all required fields');
            return;
        }

        try {
            App.showLoading(`Cloning ${repoName}...`);
            App.closeModal('clone-modal');
            
            const result = await API.repos.clone({
                connection_id: connectionId,
                repo_url: repoUrl,
                repo_name: repoName,
                branch,
                depth
            });
            
            App.hideLoading();
            App.showToast('success', 'Clone Complete', result.message);
            
            // Clear form
            document.getElementById('clone-form').reset();
            
            // Reload repos
            await this.loadRepos();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Clone Failed', error.message);
        }
    },

    async openRepo(repoId) {
        const [connection_id, repo_name] = repoId.split('/');
        
        // Switch to workspace view
        App.showView('workspace');
        
        // Load repository in workspace
        if (window.Workspace) {
            await Workspace.loadRepository(connection_id, repo_name);
        }
    },

    async syncRepo(repoId) {
        const [connection_id, repo_name] = repoId.split('/');
        
        try {
            App.showLoading(`Syncing ${repo_name}...`);
            
            // Fetch from remote
            await API.repos.fetch(connection_id, repo_name);
            
            // Get updated status
            const status = await API.repos.status(connection_id, repo_name);
            
            // Auto-pull if behind
            if (status.status?.behind > 0) {
                const pullResult = await API.git.pull(connection_id, repo_name, { preview: true });
                
                if (pullResult.wouldPull) {
                    const confirm = await App.confirmAction(
                        'Pull Changes',
                        `There are ${pullResult.behind} commits to pull. Do you want to pull them now?`
                    );
                    
                    if (confirm) {
                        await API.git.pull(connection_id, repo_name);
                    }
                }
            }
            
            App.hideLoading();
            App.showToast('success', 'Sync Complete', `${repo_name} is up to date`);
            
            // Reload repos to update status
            await this.loadRepos();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Sync Failed', error.message);
        }
    },

    async pullRepo(repoId) {
        const [connection_id, repo_name] = repoId.split('/');
        
        try {
            // Preview pull
            const preview = await API.git.pull(connection_id, repo_name, { preview: true });
            
            if (!preview.wouldPull) {
                App.showToast('info', 'Up to Date', 'No changes to pull');
                return;
            }
            
            const confirm = await App.confirmAction(
                'Pull Changes',
                `Pull ${preview.commits.length} commits from remote?`
            );
            
            if (!confirm) return;
            
            App.showLoading(`Pulling changes for ${repo_name}...`);
            
            const result = await API.git.pull(connection_id, repo_name, { stash: true });
            
            App.hideLoading();
            
            if (result.summary) {
                App.showToast('success', 'Pull Complete', result.summary);
            } else {
                App.showToast('success', 'Pull Complete', `Pulled ${result.result.changes} changes`);
            }
            
            await this.loadRepos();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Pull Failed', error.message);
        }
    },

    async pushRepo(repoId) {
        const [connection_id, repo_name] = repoId.split('/');
        
        try {
            // Preview push
            const preview = await API.git.push(connection_id, repo_name, { preview: true });
            
            if (!preview.wouldPush) {
                App.showToast('info', 'Up to Date', 'No changes to push');
                return;
            }
            
            // Quality check if available
            if (preview.qualityCheck && preview.qualityCheck.risk_level === 'high') {
                const stillPush = await App.confirmAction(
                    'Quality Issues Detected',
                    `There are potential issues with your code:\n${preview.qualityCheck.issues.map(i => `- ${i.message}`).join('\n')}\n\nDo you still want to push?`
                );
                
                if (!stillPush) return;
            }
            
            const confirm = await App.confirmAction(
                'Push Changes',
                `Push ${preview.commits.length} commits to remote?`
            );
            
            if (!confirm) return;
            
            App.showLoading(`Pushing changes for ${repo_name}...`);
            
            const result = await API.git.push(connection_id, repo_name);
            
            App.hideLoading();
            App.showToast('success', 'Push Complete', 'Changes pushed successfully');
            
            await this.loadRepos();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Push Failed', error.message);
        }
    },

    async deleteRepo(repoId) {
        const [connection_id, repo_name] = repoId.split('/');
        
        const confirm = await App.confirmAction(
            'Delete Repository',
            `Are you sure you want to delete the local clone of ${repo_name}?\n\nThis will not affect the remote repository.`
        );
        
        if (!confirm) return;
        
        try {
            App.showLoading(`Deleting ${repo_name}...`);
            
            await API.repos.delete(connection_id, repo_name);
            
            App.hideLoading();
            App.showToast('success', 'Repository Deleted', `${repo_name} has been removed`);
            
            await this.loadRepos();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Delete Failed', error.message);
        }
    },

    async updateRepoStatus(connection_id, repo_name) {
        try {
            const status = await API.repos.status(connection_id, repo_name);
            
            // Find and update the repo in our list
            const repo = this.repos.find(r => r.id === `${connection_id}/${repo_name}`);
            if (repo) {
                repo.status = status.status;
                repo.lastSync = new Date().toISOString();
                
                // Re-render just this card
                const card = document.querySelector(`[data-repo-id="${repo.id}"]`);
                if (card) {
                    const newCard = document.createElement('div');
                    newCard.innerHTML = this.renderRepoCard(repo);
                    card.replaceWith(newCard.firstElementChild);
                }
            }
        } catch (error) {
            console.error('Failed to update repo status:', error);
        }
    },

    handleRepoChange(data) {
        // Handle repository change events from WebSocket
        this.loadRepos();
    },

    onShow() {
        // Called when repositories view is shown
        // Refresh if data is stale
        const lastLoad = this.lastLoadTime || 0;
        const now = Date.now();
        
        if (now - lastLoad > 60000) { // Refresh if older than 1 minute
            this.loadRepos();
        }
    }
};

// Export for global use
window.Repositories = Repositories;
