// Main Application JavaScript

const App = {
    currentView: 'repos',
    settings: null,

    async init() {
        console.log('Initializing Code Workspace...');
        
        // Load settings
        await this.loadSettings();
        
        // Initialize view navigation
        this.initNavigation();
        
        // Initialize modals
        this.initModals();
        
        // Initialize views
        await this.initViews();
        
        // Setup global event listeners
        this.setupEventListeners();
        
        // Load initial view
        this.showView('repos');
        
        console.log('Code Workspace initialized');
    },

    async loadSettings() {
        try {
            this.settings = await API.settings.get();
            console.log('Settings loaded:', this.settings);
        } catch (error) {
            console.error('Failed to load settings:', error);
            this.settings = {};
        }
    },

    initNavigation() {
        // Navigation buttons
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const view = e.currentTarget.dataset.view;
                this.showView(view);
            });
        });

        // GitHub Hub button — go through Nginx proxy (same-origin)
        document.getElementById('github-hub-btn')?.addEventListener('click', () => {
            window.open('/api/v1/github/', '_blank');
        });

        // Sync all button
        document.getElementById('sync-all-btn')?.addEventListener('click', async () => {
            await this.syncAllRepos();
        });
    },

    initModals() {
        // Close buttons for all modals
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                this.closeModal(modal.id);
            });
        });

        // Click outside to close
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal(modal.id);
                }
            });
        });
    },

    async initViews() {
        // Initialize each view module
        if (window.Repositories) await Repositories.init();
        if (window.Workspace) await Workspace.init();
        if (window.History) await History.init();
        if (window.Settings) await Settings.init();
    },

    setupEventListeners() {
        // WebSocket events
        WS.on('repo:cloned', (data) => {
            this.showToast('success', 'Repository Cloned', `${data.repo_name} has been cloned successfully`);
            if (window.Repositories) Repositories.loadRepos();
        });

        WS.on('file:modified', (data) => {
            if (this.currentView === 'workspace') {
                this.showToast('info', 'File Modified', `${data.file} was modified`);
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + S to save
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (this.currentView === 'workspace' && window.Workspace) {
                    Workspace.saveCurrentFile();
                }
            }

            // Ctrl/Cmd + Shift + P for command palette (future feature)
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
                e.preventDefault();
                // Show command palette
            }
        });
    },

    showView(viewName) {
        // Update navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === viewName);
        });

        // Update view containers
        document.querySelectorAll('.view-container').forEach(view => {
            view.classList.toggle('active', view.id === `${viewName}-view`);
        });

        this.currentView = viewName;

        // Trigger view-specific initialization
        switch (viewName) {
            case 'repos':
                if (window.Repositories) Repositories.onShow();
                break;
            case 'workspace':
                if (window.Workspace) Workspace.onShow();
                break;
            case 'history':
                if (window.History) History.onShow();
                break;
            case 'settings':
                if (window.Settings) Settings.onShow();
                break;
        }
    },

    openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
        }
    },

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
        }
    },

    showLoading(message = 'Loading...') {
        const overlay = document.getElementById('loading-overlay');
        const messageEl = document.getElementById('loading-message');
        
        if (overlay) {
            overlay.classList.add('active');
            if (messageEl) {
                messageEl.textContent = message;
            }
        }
    },

    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    },

    showToast(type, title, message) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icons = {
            success: 'fa-check-circle',
            error: 'fa-exclamation-circle',
            warning: 'fa-exclamation-triangle',
            info: 'fa-info-circle'
        };

        toast.innerHTML = `
            <i class="fas ${icons[type]} toast-icon"></i>
            <div class="toast-content">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close">&times;</button>
        `;

        container.appendChild(toast);

        // Close button
        toast.querySelector('.toast-close').addEventListener('click', () => {
            toast.classList.add('removing');
            setTimeout(() => toast.remove(), 300);
        });

        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('removing');
                setTimeout(() => toast.remove(), 300);
            }
        }, 5000);
    },

    async syncAllRepos() {
        this.showLoading('Syncing all repositories...');
        
        try {
            const { repos } = await API.repos.list();
            
            for (const repo of repos) {
                if (repo.error) continue;
                
                const [connection_id, repo_name] = repo.id.split('/');
                
                // Fetch from remote
                await API.repos.fetch(connection_id, repo_name);
                
                // Get status
                const status = await API.repos.status(connection_id, repo_name);
                
                // Auto-pull if behind
                if (status.status && status.status.behind > 0) {
                    await API.git.pull(connection_id, repo_name, { stash: true });
                }
            }
            
            this.hideLoading();
            this.showToast('success', 'Sync Complete', 'All repositories have been synchronized');
            
            // Refresh repos view
            if (window.Repositories) {
                await Repositories.loadRepos();
            }
        } catch (error) {
            this.hideLoading();
            this.showToast('error', 'Sync Failed', error.message);
        }
    },

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    formatRelativeTime(date) {
        const now = new Date();
        const then = new Date(date);
        const seconds = Math.floor((now - then) / 1000);
        
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
        if (seconds < 2592000) return `${Math.floor(seconds / 86400)} days ago`;
        if (seconds < 31536000) return `${Math.floor(seconds / 2592000)} months ago`;
        return `${Math.floor(seconds / 31536000)} years ago`;
    },

    getFileIcon(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const icons = {
            js: 'fab fa-js',
            ts: 'fab fa-js',
            py: 'fab fa-python',
            html: 'fab fa-html5',
            css: 'fab fa-css3-alt',
            json: 'fas fa-code',
            md: 'fab fa-markdown',
            yml: 'fas fa-cog',
            yaml: 'fas fa-cog',
            git: 'fab fa-git-alt',
            gitignore: 'fab fa-git-alt',
            dockerfile: 'fab fa-docker',
            'docker-compose': 'fab fa-docker',
        };
        
        return icons[ext] || icons[filename.toLowerCase()] || 'fas fa-file';
    },

    async confirmAction(title, message) {
        return new Promise((resolve) => {
            if (confirm(`${title}\n\n${message}`)) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    }
};

// Helper function for modals (global)
window.closeModal = (modalId) => {
    App.closeModal(modalId);
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

// Export for use in other modules
window.App = App;
