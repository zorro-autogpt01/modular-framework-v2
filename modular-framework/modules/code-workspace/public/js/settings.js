// Settings Module

const Settings = {
    currentSection: 'general',
    settings: {},

    async init() {
        console.log('Initializing Settings module...');
        
        this.setupEventListeners();
        await this.loadSettings();
    },

    setupEventListeners() {
        // Section navigation
        document.querySelectorAll('.settings-nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const section = e.target.dataset.section;
                this.showSection(section);
            });
        });
    },

    async loadSettings() {
        try {
            this.settings = await API.settings.get();
            this.renderSection(this.currentSection);
        } catch (error) {
            console.error('Failed to load settings:', error);
            App.showToast('error', 'Load Failed', 'Failed to load settings');
        }
    },

    showSection(section) {
        this.currentSection = section;
        
        // Update navigation
        document.querySelectorAll('.settings-nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.section === section);
        });
        
        // Render section content
        this.renderSection(section);
    },

    renderSection(section) {
        const container = document.querySelector('.settings-content');
        if (!container) return;

        switch (section) {
            case 'general':
                container.innerHTML = this.renderGeneralSettings();
                break;
            case 'git':
                container.innerHTML = this.renderGitSettings();
                break;
            case 'ai':
                container.innerHTML = this.renderAISettings();
                break;
            case 'snapshots':
                container.innerHTML = this.renderSnapshotSettings();
                break;
            case 'integrations':
                container.innerHTML = this.renderIntegrationSettings();
                break;
            default:
                container.innerHTML = '<p>Unknown section</p>';
        }

        // Attach event handlers
        this.attachSectionHandlers(section);
    },

    renderGeneralSettings() {
        const ui = this.settings.ui || {};
        const workspace = this.settings.workspace || {};
        
        return `
            <div class="settings-section">
                <h3>User Interface</h3>
                <div class="form-group">
                    <label for="theme">Theme</label>
                    <select id="theme" class="form-control">
                        <option value="auto" ${ui.theme === 'auto' ? 'selected' : ''}>Auto</option>
                        <option value="light" ${ui.theme === 'light' ? 'selected' : ''}>Light</option>
                        <option value="dark" ${ui.theme === 'dark' ? 'selected' : ''}>Dark</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="date-format">Date Format</label>
                    <select id="date-format" class="form-control">
                        <option value="relative" ${ui.dateFormat === 'relative' ? 'selected' : ''}>Relative (e.g., 2 hours ago)</option>
                        <option value="absolute" ${ui.dateFormat === 'absolute' ? 'selected' : ''}>Absolute (e.g., 2024-01-01)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="diff-view">Diff View</label>
                    <select id="diff-view" class="form-control">
                        <option value="split" ${ui.diffView === 'split' ? 'selected' : ''}>Split</option>
                        <option value="unified" ${ui.diffView === 'unified' ? 'selected' : ''}>Unified</option>
                    </select>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="show-line-numbers" class="form-check-input" 
                           ${ui.showLineNumbers ? 'checked' : ''}>
                    <label for="show-line-numbers" class="form-check-label">
                        Show line numbers in editor
                    </label>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="syntax-highlighting" class="form-check-input" 
                           ${ui.syntaxHighlighting ? 'checked' : ''}>
                    <label for="syntax-highlighting" class="form-check-label">
                        Enable syntax highlighting
                    </label>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="auto-save" class="form-check-input" 
                           ${ui.autoSave ? 'checked' : ''}>
                    <label for="auto-save" class="form-check-label">
                        Auto-save files
                    </label>
                </div>
                ${ui.autoSave ? `
                    <div class="form-group">
                        <label for="auto-save-interval">Auto-save interval (seconds)</label>
                        <input type="number" id="auto-save-interval" class="form-control" 
                               value="${ui.autoSaveInterval || 30}" min="10" max="300">
                    </div>
                ` : ''}
            </div>

            <div class="settings-section">
                <h3>Workspace</h3>
                <div class="form-group">
                    <label for="clone-depth">Default clone depth (0 for full)</label>
                    <input type="number" id="clone-depth" class="form-control" 
                           value="${workspace.defaultCloneDepth || 0}" min="0">
                </div>
                <div class="form-group">
                    <label for="max-file-size">Maximum file size (bytes)</label>
                    <input type="number" id="max-file-size" class="form-control" 
                           value="${workspace.maxFileSize || 104857600}">
                </div>
                <div class="form-check">
                    <input type="checkbox" id="clone-submodules" class="form-check-input" 
                           ${workspace.cloneSubmodules ? 'checked' : ''}>
                    <label for="clone-submodules" class="form-check-label">
                        Clone submodules
                    </label>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="enable-lfs" class="form-check-input" 
                           ${workspace.enableLFS ? 'checked' : ''}>
                    <label for="enable-lfs" class="form-check-label">
                        Enable Git LFS
                    </label>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="file-watcher" class="form-check-input" 
                           ${workspace.fileWatcherEnabled ? 'checked' : ''}>
                    <label for="file-watcher" class="form-check-label">
                        Enable file watcher
                    </label>
                </div>
                <div class="form-group">
                    <label for="exclude-patterns">Exclude patterns (one per line)</label>
                    <textarea id="exclude-patterns" class="form-control" rows="5">${(workspace.excludePatterns || []).join('\n')}</textarea>
                </div>
            </div>

            <div class="mt-4">
                <button class="btn btn-primary" onclick="Settings.saveGeneralSettings()">Save Settings</button>
                <button class="btn btn-secondary" onclick="Settings.resetSection('general')">Reset to Defaults</button>
            </div>
        `;
    },

    renderGitSettings() {
        const git = this.settings.git || {};
        
        return `
            <div class="settings-section">
                <h3>Git Configuration</h3>
                <div class="form-group">
                    <label for="default-branch">Default branch</label>
                    <input type="text" id="default-branch" class="form-control" 
                           value="${git.defaultBranch || 'main'}">
                </div>
                <div class="form-group">
                    <label for="commit-template">Commit message template</label>
                    <select id="commit-template" class="form-control">
                        <option value="conventional" ${git.commitTemplate === 'conventional' ? 'selected' : ''}>Conventional Commits</option>
                        <option value="simple" ${git.commitTemplate === 'simple' ? 'selected' : ''}>Simple</option>
                        <option value="detailed" ${git.commitTemplate === 'detailed' ? 'selected' : ''}>Detailed</option>
                    </select>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="auto-fetch" class="form-check-input" 
                           ${git.autoFetch ? 'checked' : ''}>
                    <label for="auto-fetch" class="form-check-label">
                        Auto-fetch from remote
                    </label>
                </div>
                ${git.autoFetch ? `
                    <div class="form-group">
                        <label for="fetch-interval">Fetch interval (seconds)</label>
                        <input type="number" id="fetch-interval" class="form-control" 
                               value="${git.fetchInterval || 300}" min="60" max="3600">
                    </div>
                ` : ''}
                <div class="form-check">
                    <input type="checkbox" id="sign-commits" class="form-check-input" 
                           ${git.signCommits ? 'checked' : ''}>
                    <label for="sign-commits" class="form-check-label">
                        Sign commits with GPG
                    </label>
                </div>
            </div>

            <div class="mt-4">
                <button class="btn btn-primary" onclick="Settings.saveGitSettings()">Save Settings</button>
                <button class="btn btn-secondary" onclick="Settings.resetSection('git')">Reset to Defaults</button>
            </div>
        `;
    },

    renderAISettings() {
        const ai = this.settings.ai || {};
        const features = ai.features || {};
        
        return `
            <div class="settings-section">
                <h3>AI Configuration</h3>
                <div class="form-check mb-3">
                    <input type="checkbox" id="ai-enabled" class="form-check-input" 
                           ${ai.enabled ? 'checked' : ''}>
                    <label for="ai-enabled" class="form-check-label">
                        <strong>Enable AI Features</strong>
                    </label>
                </div>
                
                ${ai.enabled ? `
                    <div class="form-group">
                        <label for="llm-gateway-url">LLM Gateway URL</label>
                        <input type="text" id="llm-gateway-url" class="form-control" 
                               value="${ai.llmGatewayUrl || 'http://llm-gateway:3010'}">
                        <button class="btn btn-sm btn-secondary mt-2" onclick="Settings.testLLMConnection()">
                            Test Connection
                        </button>
                    </div>
                    <div class="form-group">
                        <label for="ai-model">Model</label>
                        <select id="ai-model" class="form-control">
                            <option value="gpt-4o" ${ai.model === 'gpt-4o' ? 'selected' : ''}>GPT-4 Optimized</option>
                            <option value="gpt-4" ${ai.model === 'gpt-4' ? 'selected' : ''}>GPT-4</option>
                            <option value="gpt-3.5-turbo" ${ai.model === 'gpt-3.5-turbo' ? 'selected' : ''}>GPT-3.5 Turbo</option>
                            <option value="claude-3-opus" ${ai.model === 'claude-3-opus' ? 'selected' : ''}>Claude 3 Opus</option>
                            <option value="claude-3-sonnet" ${ai.model === 'claude-3-sonnet' ? 'selected' : ''}>Claude 3 Sonnet</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="commit-style">Commit message style</label>
                        <select id="commit-style" class="form-control">
                            <option value="conventional" ${ai.commitStyle === 'conventional' ? 'selected' : ''}>Conventional</option>
                            <option value="simple" ${ai.commitStyle === 'simple' ? 'selected' : ''}>Simple</option>
                            <option value="detailed" ${ai.commitStyle === 'detailed' ? 'selected' : ''}>Detailed</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="temperature">Temperature (0-2)</label>
                        <input type="number" id="temperature" class="form-control" 
                               value="${ai.temperature || 0.7}" min="0" max="2" step="0.1">
                    </div>
                    <div class="form-group">
                        <label for="max-tokens">Max tokens</label>
                        <input type="number" id="max-tokens" class="form-control" 
                               value="${ai.maxTokens || 500}" min="1" max="4000">
                    </div>
                    
                    <h4>Features</h4>
                    <div class="form-check">
                        <input type="checkbox" id="ai-commit-messages" class="form-check-input" 
                               ${features.commitMessages ? 'checked' : ''}>
                        <label for="ai-commit-messages" class="form-check-label">
                            Generate commit messages
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="ai-push-analysis" class="form-check-input" 
                               ${features.prePushAnalysis ? 'checked' : ''}>
                        <label for="ai-push-analysis" class="form-check-label">
                            Pre-push code analysis
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="ai-pull-summaries" class="form-check-input" 
                               ${features.pullSummaries ? 'checked' : ''}>
                        <label for="ai-pull-summaries" class="form-check-label">
                            Pull change summaries
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="ai-token-counting" class="form-check-input" 
                               ${features.tokenCounting ? 'checked' : ''}>
                        <label for="ai-token-counting" class="form-check-label">
                            Token counting for file selection
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="ai-code-review" class="form-check-input" 
                               ${features.codeReview ? 'checked' : ''}>
                        <label for="ai-code-review" class="form-check-label">
                            Code review suggestions
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="ai-conflict-resolution" class="form-check-input" 
                               ${features.conflictResolution ? 'checked' : ''}>
                        <label for="ai-conflict-resolution" class="form-check-label">
                            Conflict resolution assistance
                        </label>
                    </div>
                ` : ''}
            </div>

            <div class="mt-4">
                <button class="btn btn-primary" onclick="Settings.saveAISettings()">Save Settings</button>
                <button class="btn btn-secondary" onclick="Settings.resetSection('ai')">Reset to Defaults</button>
            </div>
        `;
    },

    renderSnapshotSettings() {
        const snapshots = this.settings.snapshots || {};
        
        return `
            <div class="settings-section">
                <h3>Snapshot Configuration</h3>
                <div class="form-group">
                    <label for="max-snapshots">Maximum snapshots per repository</label>
                    <input type="number" id="max-snapshots" class="form-control" 
                           value="${snapshots.maxPerRepo || 250}" min="1" max="1000">
                </div>
                <div class="form-group">
                    <label for="retention-days">Retention period (days)</label>
                    <input type="number" id="retention-days" class="form-control" 
                           value="${snapshots.retentionDays || 30}" min="1" max="365">
                </div>
                <div class="form-check">
                    <input type="checkbox" id="auto-snapshot" class="form-check-input" 
                           ${snapshots.autoSnapshot ? 'checked' : ''}>
                    <label for="auto-snapshot" class="form-check-label">
                        Enable automatic snapshots
                    </label>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="snapshot-on-pull" class="form-check-input" 
                           ${snapshots.snapshotOnPull ? 'checked' : ''}>
                    <label for="snapshot-on-pull" class="form-check-label">
                        Create snapshot before pull
                    </label>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="snapshot-on-push" class="form-check-input" 
                           ${snapshots.snapshotOnPush ? 'checked' : ''}>
                    <label for="snapshot-on-push" class="form-check-label">
                        Create snapshot before push
                    </label>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="snapshot-on-merge" class="form-check-input" 
                           ${snapshots.snapshotOnMerge ? 'checked' : ''}>
                    <label for="snapshot-on-merge" class="form-check-label">
                        Create snapshot before merge
                    </label>
                </div>
            </div>

            <div class="mt-4">
                <button class="btn btn-primary" onclick="Settings.saveSnapshotSettings()">Save Settings</button>
                <button class="btn btn-secondary" onclick="Settings.resetSection('snapshots')">Reset to Defaults</button>
            </div>
        `;
    },

    renderIntegrationSettings() {
        const integrations = this.settings.integrations || {};
        const githubHub = integrations.githubHub || {};
        const notifications = integrations.notifications || {};
        
        return `
            <div class="settings-section">
                <h3>GitHub Hub Integration</h3>
                <div class="form-check">
                    <input type="checkbox" id="github-hub-enabled" class="form-check-input" 
                           ${githubHub.enabled ? 'checked' : ''}>
                    <label for="github-hub-enabled" class="form-check-label">
                        Enable GitHub Hub integration
                    </label>
                </div>
                <div class="form-group">
                    <label for="github-hub-url">GitHub Hub URL</label>
                    <input type="text" id="github-hub-url" class="form-control" 
                           value="${githubHub.url || 'http://github-hub-module:3002'}">
                    <button class="btn btn-sm btn-secondary mt-2" onclick="Settings.testGitHubConnection()">
                        Test Connection
                    </button>
                </div>
                <div class="form-check">
                    <input type="checkbox" id="sync-connections" class="form-check-input" 
                           ${githubHub.syncConnections ? 'checked' : ''}>
                    <label for="sync-connections" class="form-check-label">
                        Automatically sync connections
                    </label>
                </div>
            </div>

            <div class="settings-section">
                <h3>Notifications</h3>
                <div class="form-check">
                    <input type="checkbox" id="notifications-enabled" class="form-check-input" 
                           ${notifications.enabled ? 'checked' : ''}>
                    <label for="notifications-enabled" class="form-check-label">
                        Enable notifications
                    </label>
                </div>
                ${notifications.enabled ? `
                    <h4>Event Notifications</h4>
                    <div class="form-check">
                        <input type="checkbox" id="notify-push" class="form-check-input" 
                               ${notifications.events?.pushComplete ? 'checked' : ''}>
                        <label for="notify-push" class="form-check-label">
                            Push complete
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="notify-pull" class="form-check-input" 
                               ${notifications.events?.pullComplete ? 'checked' : ''}>
                        <label for="notify-pull" class="form-check-label">
                            Pull complete
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="notify-conflict" class="form-check-input" 
                               ${notifications.events?.mergeConflict ? 'checked' : ''}>
                        <label for="notify-conflict" class="form-check-label">
                            Merge conflict detected
                        </label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="notify-snapshot" class="form-check-input" 
                               ${notifications.events?.snapshotCreated ? 'checked' : ''}>
                        <label for="notify-snapshot" class="form-check-label">
                            Snapshot created
                        </label>
                    </div>
                ` : ''}
            </div>

            <div class="mt-4">
                <button class="btn btn-primary" onclick="Settings.saveIntegrationSettings()">Save Settings</button>
                <button class="btn btn-secondary" onclick="Settings.resetSection('integrations')">Reset to Defaults</button>
            </div>
        `;
    },

    attachSectionHandlers(section) {
        // Add any section-specific event handlers here
        if (section === 'general') {
            document.getElementById('auto-save')?.addEventListener('change', (e) => {
                const interval = document.getElementById('auto-save-interval');
                if (interval) {
                    interval.parentElement.style.display = e.target.checked ? 'block' : 'none';
                }
            });
        }
    },

    async saveGeneralSettings() {
        const updatedSettings = {
            ...this.settings,
            ui: {
                theme: document.getElementById('theme').value,
                dateFormat: document.getElementById('date-format').value,
                diffView: document.getElementById('diff-view').value,
                showLineNumbers: document.getElementById('show-line-numbers').checked,
                syntaxHighlighting: document.getElementById('syntax-highlighting').checked,
                autoSave: document.getElementById('auto-save').checked,
                autoSaveInterval: parseInt(document.getElementById('auto-save-interval')?.value || 30)
            },
            workspace: {
                defaultCloneDepth: parseInt(document.getElementById('clone-depth').value),
                maxFileSize: parseInt(document.getElementById('max-file-size').value),
                cloneSubmodules: document.getElementById('clone-submodules').checked,
                enableLFS: document.getElementById('enable-lfs').checked,
                fileWatcherEnabled: document.getElementById('file-watcher').checked,
                excludePatterns: document.getElementById('exclude-patterns').value.split('\n').filter(p => p.trim())
            }
        };

        await this.saveSettings(updatedSettings);
    },

    async saveGitSettings() {
        const updatedSettings = {
            ...this.settings,
            git: {
                defaultBranch: document.getElementById('default-branch').value,
                commitTemplate: document.getElementById('commit-template').value,
                autoFetch: document.getElementById('auto-fetch').checked,
                fetchInterval: parseInt(document.getElementById('fetch-interval')?.value || 300),
                signCommits: document.getElementById('sign-commits').checked
            }
        };

        await this.saveSettings(updatedSettings);
    },

    async saveAISettings() {
        const updatedSettings = {
            ...this.settings,
            ai: {
                enabled: document.getElementById('ai-enabled').checked,
                llmGatewayUrl: document.getElementById('llm-gateway-url')?.value,
                model: document.getElementById('ai-model')?.value,
                commitStyle: document.getElementById('commit-style')?.value,
                temperature: parseFloat(document.getElementById('temperature')?.value || 0.7),
                maxTokens: parseInt(document.getElementById('max-tokens')?.value || 500),
                features: {
                    commitMessages: document.getElementById('ai-commit-messages')?.checked,
                    prePushAnalysis: document.getElementById('ai-push-analysis')?.checked,
                    pullSummaries: document.getElementById('ai-pull-summaries')?.checked,
                    tokenCounting: document.getElementById('ai-token-counting')?.checked,
                    codeReview: document.getElementById('ai-code-review')?.checked,
                    conflictResolution: document.getElementById('ai-conflict-resolution')?.checked
                }
            }
        };

        await this.saveSettings(updatedSettings);
    },

    async saveSnapshotSettings() {
        const updatedSettings = {
            ...this.settings,
            snapshots: {
                maxPerRepo: parseInt(document.getElementById('max-snapshots').value),
                retentionDays: parseInt(document.getElementById('retention-days').value),
                autoSnapshot: document.getElementById('auto-snapshot').checked,
                snapshotOnPull: document.getElementById('snapshot-on-pull').checked,
                snapshotOnPush: document.getElementById('snapshot-on-push').checked,
                snapshotOnMerge: document.getElementById('snapshot-on-merge').checked
            }
        };

        await this.saveSettings(updatedSettings);
    },

    async saveIntegrationSettings() {
        const updatedSettings = {
            ...this.settings,
            integrations: {
                githubHub: {
                    enabled: document.getElementById('github-hub-enabled').checked,
                    url: document.getElementById('github-hub-url').value,
                    syncConnections: document.getElementById('sync-connections').checked
                },
                notifications: {
                    enabled: document.getElementById('notifications-enabled').checked,
                    events: {
                        pushComplete: document.getElementById('notify-push')?.checked,
                        pullComplete: document.getElementById('notify-pull')?.checked,
                        mergeConflict: document.getElementById('notify-conflict')?.checked,
                        snapshotCreated: document.getElementById('notify-snapshot')?.checked
                    }
                }
            }
        };

        await this.saveSettings(updatedSettings);
    },

    async saveSettings(settings) {
        try {
            App.showLoading('Saving settings...');
            
            await API.settings.update(settings);
            this.settings = settings;
            
            // Update app settings
            App.settings = settings;
            
            App.hideLoading();
            App.showToast('success', 'Settings Saved', 'Settings have been updated successfully');
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Save Failed', error.message);
        }
    },

    async resetSection(section) {
        const confirm = await App.confirmAction(
            'Reset Settings',
            `Are you sure you want to reset ${section} settings to defaults?`
        );

        if (!confirm) return;

        try {
            App.showLoading('Resetting settings...');
            
            await API.settings.reset(section);
            await this.loadSettings();
            
            App.hideLoading();
            App.showToast('success', 'Settings Reset', `${section} settings have been reset to defaults`);
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Reset Failed', error.message);
        }
    },

    async testLLMConnection() {
        const url = document.getElementById('llm-gateway-url').value;
        const model = document.getElementById('ai-model').value;

        try {
            App.showLoading('Testing LLM connection...');
            
            const result = await API.settings.testLLM(url, model);
            
            App.hideLoading();
            
            if (result.connected) {
                App.showToast('success', 'Connection Successful', `Connected to LLM Gateway with model ${model}`);
            } else {
                App.showToast('error', 'Connection Failed', result.error || 'Could not connect to LLM Gateway');
            }
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Test Failed', error.message);
        }
    },

    async testGitHubConnection() {
        const url = document.getElementById('github-hub-url').value;

        try {
            App.showLoading('Testing GitHub Hub connection...');
            
            const result = await API.settings.testGitHub(url);
            
            App.hideLoading();
            
            if (result.connected) {
                App.showToast('success', 'Connection Successful', 'Connected to GitHub Hub');
            } else {
                App.showToast('error', 'Connection Failed', result.error || 'Could not connect to GitHub Hub');
            }
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Test Failed', error.message);
        }
    },

    async exportSettings() {
        try {
            const blob = await API.settings.export();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'workspace-settings.json';
            a.click();
            URL.revokeObjectURL(url);
            
            App.showToast('success', 'Export Complete', 'Settings exported successfully');
        } catch (error) {
            App.showToast('error', 'Export Failed', error.message);
        }
    },

    async importSettings() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const settings = JSON.parse(text);
                
                App.showLoading('Importing settings...');
                
                await API.settings.import(settings);
                await this.loadSettings();
                
                App.hideLoading();
                App.showToast('success', 'Import Complete', 'Settings imported successfully');
            } catch (error) {
                App.hideLoading();
                App.showToast('error', 'Import Failed', error.message);
            }
        };

        input.click();
    },

    onShow() {
        // Called when settings view is shown
        // Refresh settings in case they changed
        this.loadSettings();
    }
};

// Export for global use
window.Settings = Settings;
