// Workspace Module - File Editing and Git Operations with Multi-Select & Token Counting
// Updated to integrate with existing Code Workspace UI

const Workspace = {
    currentRepo: null,
    fileTree: [],
    openFiles: [],
    activeFile: null,
    modifiedFiles: new Set(),
    fileContents: new Map(),
    locks: new Map(),
    selectedFiles: new Set(),
    tokenCountTimer: null,

    async init() {
        console.log('Initializing Workspace module...');
        
        this.setupEventListeners();
        this.setupGitActions();
        this.setupPanels();
        this.setupFileSelection();
        await this.loadRepositoryList();
    },

    setupEventListeners() {
        // Repository selector
        document.getElementById('repo-selector')?.addEventListener('change', async (e) => {
            const value = e.target.value;
            if (value) {
                const [connection_id, repo_name] = value.split('/');
                await this.loadRepository(connection_id, repo_name);
            }
        });

        // Terminal input
        const terminalInput = document.getElementById('terminal-input');
        terminalInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.executeCommand(e.target.value);
                e.target.value = '';
            }
        });

        // Panel tabs
        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const panel = e.target.dataset.panel;
                this.switchPanel(panel);
            });
        });

        // WebSocket events
        if (typeof WS !== 'undefined') {
            WS.on('file:modified', (data) => {
                if (this.currentRepo && 
                    data.connection_id === this.currentRepo.connection_id &&
                    data.repo_name === this.currentRepo.repo_name) {
                    this.handleFileModified(data.file);
                }
            });
        }
    },

    setupFileSelection() {
        // Copy selected files button
        const copyBtn = document.getElementById('copy-selected-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                await this.copySelectedFiles();
            });
        }

        // Select all checkbox
        const selectAllCheckbox = document.getElementById('select-all-files');
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                this.toggleSelectAll(e.target.checked);
            });
        }

        // Clear selection button
        const clearBtn = document.getElementById('clear-selection-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.clearSelection();
            });
        }
    },

    setupGitActions() {
        // Pull button
        document.getElementById('pull-btn')?.addEventListener('click', async () => {
            await this.pullChanges();
        });

        // Commit button
        document.getElementById('commit-btn')?.addEventListener('click', () => {
            this.showCommitModal();
        });

        // Push button
        document.getElementById('push-btn')?.addEventListener('click', async () => {
            await this.pushChanges();
        });

        // Stash button
        document.getElementById('stash-btn')?.addEventListener('click', async () => {
            await this.stashChanges();
        });

        // Branch button
        document.getElementById('branch-btn')?.addEventListener('click', () => {
            this.showBranchModal();
        });

        // Commit modal
        document.getElementById('commit-submit')?.addEventListener('click', async () => {
            await this.commitChanges();
        });

        document.getElementById('generate-commit-msg')?.addEventListener('click', async () => {
            await this.generateCommitMessage();
        });
    },

    setupPanels() {
        // Initialize diff viewer buttons
        document.getElementById('diff-view-split')?.addEventListener('click', () => {
            this.setDiffView('split');
        });

        document.getElementById('diff-view-unified')?.addEventListener('click', () => {
            this.setDiffView('unified');
        });

        document.getElementById('stage-from-diff')?.addEventListener('click', async () => {
            await this.stageFromDiff();
        });
    },

    async loadRepositoryList() {
        const selector = document.getElementById('repo-selector');
        if (!selector) return;

        try {
            const { repos } = await API.repos.list();
            
            selector.innerHTML = '<option value="">Select Repository</option>';
            repos.forEach(repo => {
                const option = document.createElement('option');
                option.value = repo.id;
                option.textContent = `${repo.name} (${repo.status?.current || 'unknown'})`;
                selector.appendChild(option);
            });
        } catch (error) {
            console.error('Failed to load repository list:', error);
        }
    },

    async loadRepository(connection_id, repo_name) {
        try {
            App.showLoading(`Loading ${repo_name}...`);
            
            this.currentRepo = { connection_id, repo_name };
            
            // Clear selection when loading new repo
            this.clearSelection();
            
            // Update selector if needed
            const selector = document.getElementById('repo-selector');
            if (selector) {
                selector.value = `${connection_id}/${repo_name}`;
            }
            
            // Subscribe to WebSocket events for this repo
            if (typeof WS !== 'undefined') {
                WS.watchRepo(connection_id, repo_name);
            }
            
            // Load file tree
            await this.loadFileTree();
            
            // Load Git status
            await this.loadGitStatus();
            
            // Load recent commits
            await this.loadRecentCommits();
            
            App.hideLoading();
            App.showToast('success', 'Repository Loaded', `Loaded ${repo_name}`);
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Load Failed', error.message);
        }
    },

    async loadFileTree() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            const result = await API.workspace.browse(connection_id, repo_name, '', 15);
            this.fileTree = result.items || [];
            this.renderFileTree();
        } catch (error) {
            console.error('Failed to load file tree:', error);
        }
    },

    renderFileTree() {
        const container = document.getElementById('file-tree');
        if (!container) return;
        
        container.innerHTML = this.renderTreeItems(this.fileTree);
        
        // Add click handlers
        container.querySelectorAll('.tree-item').forEach(item => {
            item.addEventListener('click', async (e) => {
                // Don't trigger if clicking checkbox
                if (e.target.type === 'checkbox') return;
                
                e.stopPropagation();
                const path = item.dataset.path;
                const type = item.dataset.type;
                
                if (type === 'directory') {
                    item.classList.toggle('expanded');
                    const children = item.nextElementSibling;
                    if (children?.classList.contains('tree-children')) {
                        children.style.display = children.style.display === 'none' ? 'block' : 'none';
                    }
                } else {
                    await this.openFile(path);
                }
            });
        });

        // Add checkbox handlers
        container.querySelectorAll('.file-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const path = e.target.dataset.path;
                if (e.target.checked) {
                    this.selectedFiles.add(path);
                } else {
                    this.selectedFiles.delete(path);
                }
                this.updateFileSelectionUI();
            });
        });
    },

    renderTreeItems(items, level = 0, parentPath = '') {
        return items.map(item => {
            const fullPath = parentPath ? `${parentPath}/${item.name}` : item.name;
            const isFile = item.type === 'file';
            
            const checkbox = isFile 
                ? `<input type="checkbox" 
                          class="file-checkbox" 
                          data-path="${fullPath}"
                          ${this.selectedFiles.has(fullPath) ? 'checked' : ''}
                          onclick="event.stopPropagation()">`
                : '';
            
            const icon = item.type === 'directory' 
                ? '<i class="fas fa-folder"></i>'
                : `<i class="${App.getFileIcon(item.name)}"></i>`;
            
            const children = item.children 
                ? `<div class="tree-children" style="display: none;">
                    ${this.renderTreeItems(item.children, level + 1, fullPath)}
                   </div>`
                : '';
            
            return `
                <div class="tree-item ${item.type}" 
                     data-path="${fullPath}" 
                     data-type="${item.type}"
                     style="padding-left: ${level * 20}px">
                    ${checkbox}
                    ${icon}
                    <span>${item.name}</span>
                </div>
                ${children}
            `;
        }).join('');
    },

    async loadGitStatus() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            const status = await API.repos.status(connection_id, repo_name);
            
            // Update branch info
            const branchEl = document.getElementById('current-branch');
            if (branchEl) branchEl.textContent = status.current_branch || 'unknown';
            
            const aheadEl = document.getElementById('ahead-count');
            if (aheadEl) aheadEl.textContent = status.status?.ahead || 0;
            
            const behindEl = document.getElementById('behind-count');
            if (behindEl) behindEl.textContent = status.status?.behind || 0;
            
            // Update file lists
            this.renderStagedFiles(status.status?.staged || []);
            this.renderModifiedFiles(status.status?.modified || []);
            this.renderChanges([
                ...status.status?.modified || [],
                ...status.status?.created || [],
                ...status.status?.deleted || []
            ]);
        } catch (error) {
            console.error('Failed to load git status:', error);
        }
    },

    renderStagedFiles(files) {
        const container = document.getElementById('staged-files');
        if (!container) return;
        
        if (files.length === 0) {
            container.innerHTML = '<div class="text-muted">No staged files</div>';
            return;
        }
        
        container.innerHTML = files.map(file => `
            <div class="file-item" onclick="Workspace.viewDiff('${this.escapeHtml(file)}', true)">
                <i class="${App.getFileIcon(file)}"></i>
                ${this.escapeHtml(file)}
                <button class="btn btn-sm" onclick="event.stopPropagation(); Workspace.unstageFile('${this.escapeHtml(file)}')">
                    <i class="fas fa-minus"></i>
                </button>
            </div>
        `).join('');
    },

    renderModifiedFiles(files) {
        const container = document.getElementById('modified-files');
        if (!container) return;
        
        if (files.length === 0) {
            container.innerHTML = '<div class="text-muted">No modified files</div>';
            return;
        }
        
        container.innerHTML = files.map(file => `
            <div class="file-item" onclick="Workspace.viewDiff('${this.escapeHtml(file)}', false)">
                <i class="${App.getFileIcon(file)}"></i>
                ${this.escapeHtml(file)}
                <button class="btn btn-sm" onclick="event.stopPropagation(); Workspace.stageFile('${this.escapeHtml(file)}')">
                    <i class="fas fa-plus"></i>
                </button>
            </div>
        `).join('');
    },

    renderChanges(files) {
        const container = document.getElementById('changes-list');
        if (!container) return;
        
        if (files.length === 0) {
            container.innerHTML = '<div class="text-muted">No changes</div>';
            return;
        }
        
        container.innerHTML = files.map(file => `
            <div class="change-item">
                <i class="${App.getFileIcon(file)}"></i>
                <span>${this.escapeHtml(file)}</span>
                <div class="change-actions">
                    <button class="btn btn-sm" title="View diff" onclick="Workspace.viewDiff('${this.escapeHtml(file)}')">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn btn-sm" title="Discard changes" onclick="Workspace.discardChanges('${this.escapeHtml(file)}')">
                        <i class="fas fa-undo"></i>
                    </button>
                </div>
            </div>
        `).join('');
    },

    async loadRecentCommits() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            const status = await API.repos.status(connection_id, repo_name);
            const commits = status.recent_commits || [];
            
            const container = document.getElementById('recent-commits');
            if (!container) return;
            
            if (commits.length === 0) {
                container.innerHTML = '<div class="text-muted">No recent commits</div>';
                return;
            }
            
            container.innerHTML = commits.map(commit => `
                <div class="commit-item">
                    <div class="commit-hash">${this.escapeHtml(commit.hash)}</div>
                    <div class="commit-message">${this.escapeHtml(commit.message)}</div>
                </div>
            `).join('');
        } catch (error) {
            console.error('Failed to load recent commits:', error);
        }
    },

    // ========== FILE SELECTION & CLIPBOARD FUNCTIONS ==========

    collectSelectedFiles() {
        return Array.from(this.selectedFiles).sort();
    },

    updateFileSelectionUI() {
        const selectedCount = this.selectedFiles.size;
        const copyBtn = document.getElementById('copy-selected-btn');
        const countText = document.getElementById('selected-count-text');
        
        if (countText) {
            countText.textContent = selectedCount.toString();
        }
        
        if (copyBtn) {
            copyBtn.disabled = selectedCount === 0;
        }
        
        // Update select-all checkbox state
        const selectAllCheckbox = document.getElementById('select-all-files');
        if (selectAllCheckbox) {
            const allCheckboxes = document.querySelectorAll('.file-checkbox');
            const allChecked = allCheckboxes.length > 0 && 
                               selectedCount === allCheckboxes.length;
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.indeterminate = selectedCount > 0 && !allChecked;
        }
        
        // Schedule token calculation
        this.scheduleTokenCalc();
    },

    scheduleTokenCalc() {
        if (this.tokenCountTimer) {
            cancelAnimationFrame(this.tokenCountTimer);
        }
        
        this.tokenCountTimer = requestAnimationFrame(async () => {
            const tokenCountText = document.getElementById('token-count-text');
            const tokenCountChip = document.getElementById('token-count-chip');
            
            if (!tokenCountText) return;
            
            const files = this.collectSelectedFiles();
            
            if (files.length === 0) {
                tokenCountText.textContent = '0';
                if (tokenCountChip) tokenCountChip.classList.remove('loading');
                return;
            }
            
            tokenCountText.textContent = '…';
            if (tokenCountChip) tokenCountChip.classList.add('loading');
            
            try {
                const text = await this.buildClipboardText(files);
                const tokenCount = await this.countTokensFor(text);
                tokenCountText.textContent = this.formatNumber(tokenCount);
                if (tokenCountChip) tokenCountChip.classList.remove('loading');
            } catch (error) {
                console.error('Token calculation error:', error);
                tokenCountText.textContent = '—';
                if (tokenCountChip) tokenCountChip.classList.remove('loading');
            }
        });
    },

    formatNumber(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toString();
    },

    async buildClipboardText(paths) {
        const parts = [];
        
        for (const path of paths) {
            parts.push(`# ${path}\n`);
            
            try {
                const content = await this.getFileContentForClipboard(path);
                parts.push(content.endsWith('\n') ? content : content + '\n');
                parts.push('\n');
            } catch (error) {
                console.error(`Error reading ${path}:`, error);
                parts.push(`[Error reading file: ${error.message}]\n\n`);
            }
        }
        
        return parts.join('');
    },

    async getFileContentForClipboard(path) {
        // Check if already loaded in memory
        if (this.fileContents.has(path)) {
            return this.fileContents.get(path);
        }
        
        // Otherwise fetch from API
        if (!this.currentRepo) {
            throw new Error('No repository loaded');
        }
        
        const { connection_id, repo_name } = this.currentRepo;
        const result = await API.workspace.readFile(connection_id, repo_name, path);
        
        if (result.binary) {
            return `[Binary file: ${result.size} bytes]`;
        }
        
        return result.content;
    },

    async countTokensFor(text) {
        // Use the API token counting endpoint if available
        if (API.ai && API.ai.countTokens) {
            try {
                const result = await API.ai.countTokens(text);
                return result.tokens;
            } catch (error) {
                console.error('Token counting API error:', error);
            }
        }
        
        // Fallback to rough estimation (1 token ~= 4 characters)
        return Math.ceil(text.length / 4);
    },

    async copySelectedFiles() {
        const files = this.collectSelectedFiles();
        
        if (files.length === 0) {
            App.showToast('warning', 'No Files', 'Select one or more files in the tree first.');
            return;
        }
        
        try {
            App.showLoading('Building clipboard content...');
            
            const text = await this.buildClipboardText(files);
            
            // Try modern clipboard API first
            try {
                await navigator.clipboard.writeText(text);
                App.hideLoading();
                
                const copyBtn = document.getElementById('copy-selected-btn');
                if (copyBtn) {
                    const oldHTML = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<i class="fas fa-check"></i>';
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        copyBtn.innerHTML = oldHTML;
                        copyBtn.classList.remove('copied');
                    }, 2000);
                }
                
                App.showToast('success', 'Copied', `${files.length} file${files.length !== 1 ? 's' : ''} copied to clipboard`);
            } catch (clipboardError) {
                // Fallback to textarea method
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                textarea.style.pointerEvents = 'none';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                
                try {
                    document.execCommand('copy');
                    App.hideLoading();
                    App.showToast('success', 'Copied', `${files.length} file${files.length !== 1 ? 's' : ''} copied to clipboard`);
                } catch (execError) {
                    App.hideLoading();
                    App.showToast('error', 'Copy Failed', 'Could not copy to clipboard');
                }
                
                document.body.removeChild(textarea);
            }
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Copy Failed', error.message);
        }
    },

    toggleSelectAll(checked) {
        // Get all file checkboxes
        const checkboxes = document.querySelectorAll('.file-checkbox');
        
        checkboxes.forEach(checkbox => {
            checkbox.checked = checked;
            const path = checkbox.dataset.path;
            
            if (checked) {
                this.selectedFiles.add(path);
            } else {
                this.selectedFiles.delete(path);
            }
        });
        
        this.updateFileSelectionUI();
    },

    clearSelection() {
        this.selectedFiles.clear();
        
        // Uncheck all checkboxes
        document.querySelectorAll('.file-checkbox').forEach(checkbox => {
            checkbox.checked = false;
        });
        
        // Update select-all checkbox
        const selectAllCheckbox = document.getElementById('select-all-files');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        }
        
        this.updateFileSelectionUI();
    },

    // ========== EXISTING FILE OPERATIONS ==========

    async openFile(path) {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        // Check if already open
        if (this.openFiles.find(f => f.path === path)) {
            this.activateFile(path);
            return;
        }
        
        try {
            App.showLoading(`Opening ${path}...`);
            
            const result = await API.workspace.readFile(connection_id, repo_name, path);
            
            // Store content
            this.fileContents.set(path, result.content);
            
            // Add to open files
            this.openFiles.push({
                path,
                name: path.split('/').pop(),
                modified: false,
                binary: result.binary,
                encoding: result.encoding
            });
            
            // Render tabs
            this.renderTabs();
            
            // Activate this file
            this.activateFile(path);
            
            App.hideLoading();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Open Failed', error.message);
        }
    },

    activateFile(path) {
        this.activeFile = path;
        
        // Update tabs
        document.querySelectorAll('.editor-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.path === path);
        });
        
        // Display file content
        this.displayFileContent(path);
    },

    displayFileContent(path) {
        const container = document.getElementById('editor-content');
        if (!container) return;
        
        const content = this.fileContents.get(path);
        const file = this.openFiles.find(f => f.path === path);
        
        if (!content || !file) {
            container.innerHTML = '<div class="welcome-screen">File not found</div>';
            return;
        }
        
        if (file.binary) {
            container.innerHTML = `
                <div class="binary-preview">
                    <i class="fas fa-file-alt fa-3x"></i>
                    <p>Binary file${App.formatFileSize ? ' (' + App.formatFileSize(content.length) + ')' : ''}</p>
                    <p>Preview not available</p>
                </div>
            `;
            return;
        }
        
        // Create editable code editor
        const lines = content.split('\n');
        container.innerHTML = `
            <div class="code-editor">
                <div class="editor-wrapper">
                    <div class="line-numbers">
                        ${lines.map((_, i) => `<div>${i + 1}</div>`).join('')}
                    </div>
                    <pre><code contenteditable="true" 
                              class="language-javascript" 
                              id="editor-code"
                              data-path="${this.escapeHtml(path)}">${this.escapeHtml(content)}</code></pre>
                </div>
            </div>
        `;
        
        // Syntax highlighting
        if (typeof Prism !== 'undefined') {
            const codeEl = document.getElementById('editor-code');
            if (codeEl) Prism.highlightElement(codeEl);
        }
        
        // Track changes
        document.getElementById('editor-code')?.addEventListener('input', (e) => {
            this.handleFileEdit(path, e.target.textContent);
        });
    },

    handleFileEdit(path, newContent) {
        const oldContent = this.fileContents.get(path);
        const file = this.openFiles.find(f => f.path === path);
        
        if (!file) return;
        
        const isModified = newContent !== oldContent;
        file.modified = isModified;
        
        if (isModified) {
            this.modifiedFiles.add(path);
        } else {
            this.modifiedFiles.delete(path);
        }
        
        // Update tab
        this.updateTab(path);
    },

    renderTabs() {
        const container = document.getElementById('editor-tabs');
        if (!container) return;
        
        container.innerHTML = this.openFiles.map(file => `
            <button class="editor-tab ${file.path === this.activeFile ? 'active' : ''}"
                    data-path="${this.escapeHtml(file.path)}">
                <i class="${App.getFileIcon(file.name)}"></i>
                <span>${this.escapeHtml(file.name)}</span>
                ${file.modified ? '<span class="modified-indicator">●</span>' : ''}
                <span class="close-btn" onclick="event.stopPropagation(); Workspace.closeFile('${this.escapeHtml(file.path)}')">
                    <i class="fas fa-times"></i>
                </span>
            </button>
        `).join('');
        
        // Add click handlers
        container.querySelectorAll('.editor-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const path = tab.dataset.path;
                this.activateFile(path);
            });
        });
    },

    updateTab(path) {
        const tab = document.querySelector(`.editor-tab[data-path="${CSS.escape(path)}"]`);
        if (!tab) return;
        
        const file = this.openFiles.find(f => f.path === path);
        if (!file) return;
        
        const indicator = tab.querySelector('.modified-indicator');
        if (file.modified && !indicator) {
            const closeBtn = tab.querySelector('.close-btn');
            if (closeBtn) {
                closeBtn.insertAdjacentHTML('beforebegin', '<span class="modified-indicator">●</span>');
            }
        } else if (!file.modified && indicator) {
            indicator.remove();
        }
    },

    async closeFile(path) {
        const file = this.openFiles.find(f => f.path === path);
        if (!file) return;
        
        if (file.modified) {
            const save = await App.confirmAction(
                'Unsaved Changes',
                `Save changes to ${file.name} before closing?`
            );
            
            if (save) {
                await this.saveFile(path);
            }
        }
        
        // Remove from open files
        this.openFiles = this.openFiles.filter(f => f.path !== path);
        this.fileContents.delete(path);
        this.modifiedFiles.delete(path);
        
        // Update UI
        this.renderTabs();
        
        // Activate another file if this was active
        if (this.activeFile === path) {
            if (this.openFiles.length > 0) {
                this.activateFile(this.openFiles[this.openFiles.length - 1].path);
            } else {
                const editorContent = document.getElementById('editor-content');
                if (editorContent) {
                    editorContent.innerHTML = `
                        <div class="welcome-screen">
                            <i class="fas fa-folder-open fa-3x"></i>
                            <h3>No files open</h3>
                        </div>
                    `;
                }
            }
        }
    },

    async saveFile(path) {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        const content = document.getElementById('editor-code')?.textContent;
        
        if (content === undefined) return;
        
        try {
            await API.workspace.writeFile(connection_id, repo_name, path, content);
            
            // Update stored content
            this.fileContents.set(path, content);
            
            // Mark as not modified
            const file = this.openFiles.find(f => f.path === path);
            if (file) {
                file.modified = false;
                this.modifiedFiles.delete(path);
                this.updateTab(path);
            }
            
            App.showToast('success', 'File Saved', `${path} saved successfully`);
            
            // Refresh Git status
            await this.loadGitStatus();
        } catch (error) {
            App.showToast('error', 'Save Failed', error.message);
        }
    },

    async saveCurrentFile() {
        if (this.activeFile) {
            await this.saveFile(this.activeFile);
        }
    },

    async viewDiff(file, staged = false) {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            const result = await API.git.diff(connection_id, repo_name, file, staged);
            
            // Show diff modal
            if (typeof App.openModal === 'function') {
                App.openModal('diff-modal');
            }
            
            const titleEl = document.getElementById('diff-title');
            if (titleEl) titleEl.textContent = `Diff: ${file}`;
            
            const contentEl = document.getElementById('diff-content');
            if (contentEl) {
                contentEl.innerHTML = `
                    <pre class="diff-content"><code class="language-diff">${this.escapeHtml(result.diff)}</code></pre>
                `;
            }
            
            // Syntax highlighting for diff
            if (typeof Prism !== 'undefined') {
                Prism.highlightAll();
            }
        } catch (error) {
            App.showToast('error', 'Diff Failed', error.message);
        }
    },

    async stageFile(file) {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            await API.git.stage(connection_id, repo_name, [file]);
            App.showToast('success', 'File Staged', `${file} added to staging area`);
            await this.loadGitStatus();
        } catch (error) {
            App.showToast('error', 'Stage Failed', error.message);
        }
    },

    async unstageFile(file) {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            await API.git.unstage(connection_id, repo_name, [file]);
            App.showToast('success', 'File Unstaged', `${file} removed from staging area`);
            await this.loadGitStatus();
        } catch (error) {
            App.showToast('error', 'Unstage Failed', error.message);
        }
    },

    showCommitModal() {
        if (!this.currentRepo) return;
        
        // Load staged files
        this.loadCommitFiles();
        
        if (typeof App.openModal === 'function') {
            App.openModal('commit-modal');
        }
    },

    async loadCommitFiles() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            const status = await API.repos.status(connection_id, repo_name);
            const staged = status.status?.staged || [];
            const modified = status.status?.modified || [];
            
            const container = document.getElementById('commit-files-list');
            if (!container) return;
            
            const allFiles = [...new Set([...staged, ...modified])];
            
            container.innerHTML = allFiles.map(file => `
                <div class="form-check">
                    <input type="checkbox" 
                           class="form-check-input" 
                           id="commit-file-${this.escapeHtml(file)}"
                           value="${this.escapeHtml(file)}"
                           ${staged.includes(file) ? 'checked' : ''}>
                    <label class="form-check-label" for="commit-file-${this.escapeHtml(file)}">
                        <i class="${App.getFileIcon(file)}"></i>
                        ${this.escapeHtml(file)}
                    </label>
                </div>
            `).join('');
        } catch (error) {
            console.error('Failed to load commit files:', error);
        }
    },

    async generateCommitMessage() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            App.showLoading('Generating commit message...');
            
            const result = await API.ai.generateCommitMessage(connection_id, repo_name);
            
            if (result.message) {
                const msgEl = document.getElementById('commit-message');
                if (msgEl) msgEl.value = result.message;
            }
            
            App.hideLoading();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Generation Failed', error.message);
        }
    },

    async commitChanges() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        const msgEl = document.getElementById('commit-message');
        const descEl = document.getElementById('commit-description');
        const amendEl = document.getElementById('commit-amend');
        
        const message = msgEl?.value;
        const description = descEl?.value;
        const amend = amendEl?.checked;
        
        if (!message) {
            App.showToast('error', 'Missing Message', 'Please enter a commit message');
            return;
        }
        
        // Get selected files
        const selectedFiles = [];
        document.querySelectorAll('#commit-files-list input:checked').forEach(input => {
            selectedFiles.push(input.value);
        });
        
        if (selectedFiles.length === 0 && !amend) {
            App.showToast('error', 'No Files', 'Please select files to commit');
            return;
        }
        
        try {
            App.showLoading('Committing changes...');
            
            // Stage selected files
            if (selectedFiles.length > 0) {
                await API.git.stage(connection_id, repo_name, selectedFiles);
            }
            
            // Commit
            const result = await API.git.commit(connection_id, repo_name, {
                message,
                description,
                amend
            });
            
            App.hideLoading();
            
            if (typeof App.closeModal === 'function') {
                App.closeModal('commit-modal');
            }
            
            App.showToast('success', 'Commit Created', `Commit ${result.commit} created`);
            
            // Clear form
            const formEl = document.getElementById('commit-form');
            if (formEl) formEl.reset();
            
            // Refresh status
            await this.loadGitStatus();
            await this.loadRecentCommits();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Commit Failed', error.message);
        }
    },

    async pullChanges() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            // Preview first
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
            
            App.showLoading('Pulling changes...');
            
            const result = await API.git.pull(connection_id, repo_name, { stash: true });
            
            App.hideLoading();
            
            if (result.summary) {
                App.showToast('success', 'Pull Complete', result.summary);
            } else {
                App.showToast('success', 'Pull Complete', `Pulled ${result.result.changes} changes`);
            }
            
            // Refresh everything
            await this.loadFileTree();
            await this.loadGitStatus();
            await this.loadRecentCommits();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Pull Failed', error.message);
        }
    },

    async pushChanges() {
        if (!this.currentRepo) return;
        
        const { connection_id, repo_name } = this.currentRepo;
        
        try {
            // Preview and quality check
            const preview = await API.git.push(connection_id, repo_name, { preview: true, check_quality: true });
            
            if (!preview.wouldPush) {
                App.showToast('info', 'Up to Date', 'No changes to push');
                return;
            }
            
            // Show quality check results if issues found
            if (preview.qualityCheck && preview.qualityCheck.issues.length > 0) {
                const issues = preview.qualityCheck.issues
                    .filter(i => i.severity === 'error')
                    .map(i => `• ${i.message}`)
                    .join('\n');
                
                if (issues) {
                    const stillPush = await App.confirmAction(
                        'Quality Issues Found',
                        `The following issues were detected:\n\n${issues}\n\nDo you want to push anyway?`
                    );
                    
                    if (!stillPush) return;
                }
            }
            
            const confirm = await App.confirmAction(
                'Push Changes',
                `Push ${preview.commits.length} commits to remote?`
            );
            
            if (!confirm) return;
            
            App.showLoading('Pushing changes...');
            
            await API.git.push(connection_id, repo_name);
            
            App.hideLoading();
            App.showToast('success', 'Push Complete', 'Changes pushed successfully');
            
            await this.loadGitStatus();
        } catch (error) {
            App.hideLoading();
            App.showToast('error', 'Push Failed', error.message);
        }
    },

    async executeCommand(command) {
        const output = document.getElementById('terminal-output');
        if (!output) return;
        
        // Add command to output
        output.innerHTML += `<div class="terminal-line">$ ${this.escapeHtml(command)}</div>`;
        
        // Execute based on command
        // This is a simplified terminal - you can expand with more commands
        if (command === 'clear') {
            output.innerHTML = '';
        } else if (command.startsWith('git ')) {
            output.innerHTML += '<div class="terminal-line">Executing Git command...</div>';
            // You could implement actual git command execution here
        } else {
            output.innerHTML += `<div class="terminal-line">Command not recognized: ${this.escapeHtml(command)}</div>`;
        }
        
        // Scroll to bottom
        output.scrollTop = output.scrollHeight;
    },

    switchPanel(panelName) {
        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.panel === panelName);
        });
        
        document.querySelectorAll('.panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === `${panelName}-panel`);
        });
    },

    handleFileChange(data) {
        // Handle file change events
        if (data.type === 'file:changed') {
            // Reload file if it's open
            if (this.openFiles.find(f => f.path === data.file)) {
                // Show notification
                App.showToast('info', 'File Changed', `${data.file} was modified externally`);
            }
        }
        
        // Refresh file tree
        this.loadFileTree();
    },

    handleLockChange(data) {
        // Update lock status for files
        if (data.type === 'lock:acquired') {
            this.locks.set(data.file, data);
        } else if (data.type === 'lock:released') {
            this.locks.delete(data.file);
        }
    },

    handleGitEvent(data) {
        // Refresh Git status on any git event
        this.loadGitStatus();
        this.loadRecentCommits();
    },

    handleFileModified(file) {
        // File was modified externally
        if (this.openFiles.find(f => f.path === file)) {
            App.showToast('warning', 'External Change', `${file} was modified externally`);
        }
    },

    escapeHtml(text) {
        if (typeof text !== 'string') return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    },

    onShow() {
        // Called when workspace view is shown
        if (!this.currentRepo && typeof Repositories !== 'undefined' && Repositories.repos && Repositories.repos.length > 0) {
            // Auto-load first repo
            const firstRepo = Repositories.repos[0];
            const [connection_id, repo_name] = firstRepo.id.split('/');
            this.loadRepository(connection_id, repo_name);
        }
    }
};

// Export for global use
window.Workspace = Workspace;