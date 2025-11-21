tate button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }

        .empty-state button:hover {
            background: #1177bb;
        }

        /* ===============================
           File Monitor panel styling





            color: #e0e0e0;
            font-size: 12px;
        }

        .file-monitor-root .monitor-container {
            display: flex;
            flex-direction: column;
            height: 100%;


        .file-monitor-root .monitor-header {
            background: #2d2d30;
            border-bottom: 1px solid #3e3e42;
            padding: 8px 10px;
            display: flex;

            gap: 8px;
        }

        .file-monitor-root .header-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .file-monitor-root .repo-selector {
            flex: 1;
            background: #1e1e1e;
            border: 1px solid #3e3e42;
            color: #e0e0e0;
            padding: 5px 8px;
            border-radius: 3px;
            font-size: 11px;
        }

        .file-monitor-root .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            animation: pulse 2s ease-in-out infinite;
        }

        .file-monitor-root .status-connected { background: #4ec9b0; }
        .file-monitor-root .status-disconnected { background: #f48771; }
        .file-monitor-root .status-connecting { background: #dcdcaa; }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .file-monitor-root .search-box {
            flex: 1;
            background: #1e1e1e;
            border: 1px solid #3e3e42;
            color: #e0e0e0;
            padding: 5px 8px;
            border-radius: 3px;
            font-size: 11px;
        }

        .file-monitor-root .filter-select {
            background: #1e1e1e;
            border: 1px solid #3e3e42;
            color: #e0e0e0;
            padding: 5px 8px;
            border-radius: 3px;
            font-size: 11px;
        }

        .file-monitor-root .mini-toggle {
            background: #0e639c;
            border: none;
            color: white;
            padding: 5px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }

        .file-monitor-root .mini-toggle:hover {
            background: #1177bb;
        }

        .file-monitor-root .timeline-list {

            overflow-y: auto;
            overflow-x: hidden;
            padding: 4px;
        }

        .file-monitor-root .timeline-list::-webkit-scrollbar {
            width: 8px;
        }

        .file-monitor-root .timeline-list::-webkit-scrollbar-track {

        }

        .file-monitor-root .timeline-list::-webkit-scrollbar-thumb {
            background: #3e3e42;
            border-radius: 4px;
        }

        .file-monitor-root .batch-group {
            margin-bottom: 4px;
            background: #2d2d30;
            border: 1px solid #3e3e42;
            border-radius: 4px;
        }

        .file-monitor-root .batch-header {
            display: flex;
            align-items: center;
            padding: 6px 8px;
            cursor: pointer;
            user-select: none;
            gap: 6px;
        }

        .file-monitor-root .batch-header:hover {
            background: #3e3e42;
        }

        .file-monitor-root .batch-toggle {
            font-size: 10px;
            transition: transform 0.2s;
        }

        .file-monitor-root .batch-group.expanded .batch-toggle {
            transform: rotate(90deg);
        }

        .file-monitor-root .batch-icon {
            font-size: 14px;
        }

        .file-monitor-root .batch-info {
            flex: 1;
            font-size: 11px;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .file-monitor-root .batch-title {
            font-weight: 500;
        }

        .file-monitor-root .batch-meta {
            color: #808080;
            font-size: 10px;
        }

        .file-monitor-root .batch-files {
            display: none;
            border-top: 1px solid #3e3e42;
        }

        .file-monitor-root .batch-group.expanded .batch-files {
            display: block;
        }

        .file-monitor-root .file-item {
            display: flex;
            align-items: center;
            padding: 6px 8px;
            gap: 6px;
            border-bottom: 1px solid #3e3e42;
        }

        .file-monitor-root .file-item:last-child {
            border-bottom: none;
        }

        .file-monitor-root .file-item:hover {
            background: #3e3e42;
        }

        .file-monitor-root .file-timestamp {
            font-size: 10px;
            color: #c8c8c8;
            font-family: Menlo, Consolas, "Roboto Mono", monospace;
            white-space: nowrap;
            flex: 0 0 auto;
            min-width: 145px;
        }

        .file-monitor-root .change-icon {
            font-size: 12px;
            width: 16px;
            text-align: center;
        }

        .file-monitor-root .change-created { color: #4ec9b0; }
        .file-monitor-root .change-modified { color: #569cd6; }
        .file-monitor-root .change-deleted { color: #f48771; }

        .file-monitor-root .file-info {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .file-monitor-root .file-name {
            font-size: 11px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: default;
        }

        .file-monitor-root .file-time {
            font-size: 10px;
            color: #808080;
        }

        .file-monitor-root .file-actions {
            display: flex;
            gap: 4px;
        }

        .file-monitor-root .file-actions button {
            background: #0e639c;
            border: none;
            color: white;
            padding: 3px 6px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            white-space: nowrap;
        }

        .file-monitor-root .file-actions button:hover {
            background: #1177bb;
        }

        .file-monitor-root .file-actions button.btn-restore {
            background: #3e3e42;
        }

        .file-monitor-root .file-actions button.btn-restore:hover {
            background: #4e4e52;
        }

        .file-monitor-root .mini-mode {
            display: none;
        }

        .file-monitor-root .monitor-container.mini .monitor-header,
        .file-monitor-root .monitor-container.mini .timeline-list {
            display: none;
        }

        .file-monitor-root .monitor-container.mini .mini-mode {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            gap: 15px;
        }

        .file-monitor-root .mini-badge {
            position: relative;
            width: 60px;
            height: 60px;
            background: #0e639c;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            cursor: pointer;
        }

        .file-monitor-root .mini-badge:hover {
            background: #1177bb;
        }

        .file-monitor-root .mini-count {
            position: absolute;
            top: -5px;
            right: -5px;
            background: #f48771;
            color: white;
            border-radius: 10px;
            padding: 2px 6px;
            font-size: 11px;
            font-weight: bold;
        }

        .file-monitor-root .mini-label {
            font-size: 11px;
            color: #808080;
        }

        .file-monitor-root .mini-expand {
            background: #0e639c;
            border: none;
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
        }

        .file-monitor-root .mini-expand:hover {
            background: #1177bb;
        }

        .file-monitor-root .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: #808080;
            padding: 20px;
            text-align: center;
        }

        .file-monitor-root .empty-icon {
            font-size: 48px;
            margin-bottom: 10px;
            opacity: 0.5;
        }

        .file-monitor-root .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: #808080;
        }

        .file-monitor-root .spinner {
            border: 3px solid #3e3e42;
            border-top: 3px solid #0e639c;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .diff-preview {
            position: fixed;
            background: #1e1e1e;
            border: 1px solid #3e3e42;
            border-radius: 4px;
            padding: 8px;
            width: 380px;
            max-height: 260px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
            z-index: 1500;
            font-size: 11px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .preview-header {
            font-weight: 500;
            font-size: 11px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .preview-meta {
            display: flex;
            justify-content: space-between;
            font-size: 10px;
            color: #808080;
        }

        .preview-stats {
            display: flex;
            gap: 8px;
            font-size: 10px;
        }

        .stat-added {
            color: #4ec9b0;
        }

        .stat-removed {
            color: #f48771;
        }

        .mini-diff {
            margin-top: 4px;
            padding-top: 4px;
            border-top: 1px solid #3e3e42;
            max-height: 150px;
            overflow: auto;
            font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
            font-size: 11px;
        }

        .mini-diff .diff-line {
            white-space: pre;
        }

        .mini-diff .diff-add {
            background: rgba(76, 201, 176, 0.15);
        }

        .mini-diff .diff-del {
            background: rgba(244, 135, 113, 0.15);
        }

        .mini-diff .diff-context {
            color: #c0c0c0;
        }

        .diff-more {
            text-align: center;
            font-size: 10px;
            color: #808080;
            padding: 2px 0;
        }

        .preview-actions {
            display: flex;
            justify-content: flex-end;
            gap: 6px;
            margin-top: 4px;
        }

        .preview-actions button {
            background: #3e3e42;
            border: none;
            color: #e0e0e0;
            padding: 3px 6px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
        }

        .preview-actions button:hover {
            background: #4e4e52;
        }

        .preview-actions .preview-btn-primary {
            background: #0e639c;
            color: #fff;
        }

        .preview-actions .preview-btn-primary:hover {
            background: #1177bb;
        }
    </style>
</head>
<body>
    <div class="app-container">
        <!-- Header -->
        <div class="header">
            <h1>🚀 Modular Application Framework</h1>
            <button onclick="discoverModules()">🔍 Discover</button>
            <button onclick="exportModules()">⬇️ Export</button>
            <input type="file" id="importFile" style="display:none" accept="application/json" onchange="importModules(this.files[0])"/>
            <button onclick="document.getElementById('importFile').click()">⬆️ Import</button>
            <button onclick="showRegistrationModal()">+ Register Module</button>
            <button onclick="refreshModules()">🔄 Refresh</button>
        </div>

        <!-- GitHub Hub Panel (Fixed Left) -->
        <div class="github-hub-panel">
            <div class="panel-header">
                <div class="side-tabs">
                    <button class="side-tab active" onclick="switchSidePanel('github')">📁 GitHub</button>
                    <button class="side-tab" onclick="switchSidePanel('workspace')">💼 Workspace</button>
                    <button class="side-tab" onclick="switchSidePanel('files')">📊 Files</button>
                </div>
            </div>
            <div class="side-panel-content">
                <iframe id="githubHubFrame" class="side-panel-frame active" src="/api/v1/github/ui/?embed=side"></iframe>
                <iframe id="workspaceFrame" class="side-panel-frame" src="/api/v1/code-workspace/tree.html"></iframe>
                <!-- Inline file monitor panel (no iframe) -->
                <div id="filesPanel" class="side-panel-frame"></div>
            </div>
        </div>

        <!-- Modules Panel (Collapsible) -->
        <div class="modules-panel" id="modulesPanel">
            <button class="modules-toggle" onclick="toggleModulesPanel()">
                <span id="toggleIcon">☰</span>
            </button>
            <div class="modules-content" id="modulesList">
                <!-- Modules will be loaded here -->
            </div>
        </div>

        <!-- Main Tabbed Area -->
        <div class="main-area">
            <div class="tabs-container" id="tabsContainer">
                <button class="add-tab-btn" onclick="showAddTabModal()">+ Add Tab</button>
            </div>
            <div class="tab-content-area" id="tabContentArea">
                <div class="empty-state">
                    <div class="empty-state-icon">📑</div>
                    <div class="empty-state-text">No tabs open. Click "+ Add Tab" to get started.</div>
                    <button onclick="showAddTabModal()">Add Your First Tab</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Registration Modal -->
    <div id="registrationModal" class="modal">
        <div class="modal-content">
            <span class="close" onclick="closeRegistrationModal()">&times;</span>
            <h2 style="margin-bottom: 20px; font-size: 16px;">Register New Module</h2>
            <div class="form-group">
                <label for="moduleName">Module Name</label>
                <input type="text" id="moduleName" placeholder="e.g., SSH Terminal">
            </div>
            <div class="form-group">
                <label for="moduleUrl">Module URL</label>
                <input type="text" id="moduleUrl" placeholder="http://module-host:port">
            </div>
            <div class="form-group">
                <label for="moduleType">Module Type</label>
                <select id="moduleType">
                    <option value="terminal">Terminal</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                    <option value="dashboard">Dashboard</option>
                    <option value="other">Other</option>
                </select>
            </div>
            <div class="form-group">
                <label for="moduleDescription">Description</label>
                <input type="text" id="moduleDescription" placeholder="Brief description">
            </div>
            <div class="form-actions">
                <button class="btn btn-secondary" onclick="closeRegistrationModal()">Cancel</button>
                <button class="btn btn-primary" onclick="registerModule()">Register</button>
            </div>
        </div>
    </div>

    <!-- Add Tab Modal -->
    <div id="addTabModal" class="modal">
        <div class="modal-content">
            <span class="close" onclick="closeAddTabModal()">&times;</span>
            <h2 style="margin-bottom: 20px; font-size: 16px;">Add New Tab</h2>
            <div class="form-group">
                <label for="tabModule">Select Module</label>
                <select id="tabModule">
                    <option value="">Choose a module...</option>
                </select>
            </div>
            <div class="form-group">
                <label for="tabName">Tab Name (optional)</label>
                <input type="text" id="tabName" placeholder="Custom tab name">
            </div>
            <div class="form-actions">
                <button class="btn btn-secondary" onclick="closeAddTabModal()">Cancel</button>
                <button class="btn btn-primary" onclick="addNewTab()">Add Tab</button>
            </div>
        </div>
    </div>

    <!-- File Monitor JS (component) -->
    <script src="/api/v1/file-watcher/file-monitor-panel.js"></script>

    <script>
        // Module Registry
        const moduleRegistry = new Map();
        const tabs = [];
        let tabCounter = 0;
        let editingModuleName = null;
        let modulesExpanded = false;

        // Known modules for one-click discovery
        const knownModules = [
            { name: 'SSH Terminal', url: '/api/v1/ssh-terminal/', type: 'terminal', configUrl: '/api/v1/ssh-terminal/', description: 'SSH connection to remote systems' },
            { name: 'LLM Workflows', url: '/api/v1/workflows/', type: 'dashboard', configUrl: '/api/v1/workflows/', description: 'Build, val
