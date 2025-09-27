export const localTree = {
  'src': { type:'folder', children: {
    'components': { type:'folder', children: {
      'App.tsx': { type:'file', content: "import React from 'react';\n\nfunction App() {\n  return (\n    <div className=\"App\">\n      <h1>Advanced Web IDE Pro</h1>\n      <p>A comprehensive development environment</p>\n    </div>\n  );\n}\n\nexport default App;" },
      'Header.tsx': { type:'file', content: "import React from 'react';\n\nconst Header: React.FC = () => {\n  return (\n    <header className=\"header\">\n      <h1>My Application</h1>\n      <nav>\n        <a href=\"/\">Home</a>\n        <a href=\"/about\">About</a>\n      </nav>\n    </header>\n  );\n};\n\nexport default Header;" }
    }},
    'utils': { type:'folder', children: {
      'helpers.ts': { type:'file', content: "export const formatDate = (date: Date): string => {\n  return new Intl.DateTimeFormat('en-US').format(date);\n};\n\nexport const debounce = <T extends (...args: any[]) => any>(\n  func: T,\n  wait: number\n): ((...args: Parameters<T>) => void) => {\n  let timeout: any;\n  return (...args: Parameters<T>) => {\n    clearTimeout(timeout);\n    timeout = setTimeout(() => func(...args), wait);\n  };\n};" }
    }},
    'index.tsx': { type:'file', content: "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './components/App';\nimport './styles.css';\n\nconst root = ReactDOM.createRoot(\n  document.getElementById('root') as HTMLElement\n);\n\nroot.render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);" },
    'styles.css': { type:'file', content: "/* Global styles */\nbody {\n  margin: 0;\n  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;\n  background-color: #f5f5f5;\n}\n\n.App {\n  text-align: center;\n  padding: 40px 20px;\n}\n\nh1 {\n  color: #333;\n  margin-bottom: 20px;\n}" }
  }},
  'package.json': { type:'file', content: `{"name":"advanced-web-ide-demo","version":"1.0.0","description":"Demo project for Advanced Web IDE Pro","main":"src/index.tsx","dependencies":{"react":"^18.2.0","react-dom":"^18.2.0","typescript":"^4.9.0"},"scripts":{"start":"react-scripts start","build":"react-scripts build","test":"react-scripts test"}}` },
  'README.md': { type:'file', content: "# Advanced Web IDE Pro\n\nA comprehensive, cloud-based integrated development environment with advanced features for modern web development.\n\n## Features\n\n- **Multi-file Editor**: Monaco Editor with IntelliSense\n- **SSH Connectivity**: Connect to remote servers\n- **Git Integration**: Complete version control\n- **Docker Support**: Container management\n- **Database Browser**: Multi-database support\n- **Built-in Terminal**: Execute commands\n\n## Quick Start\n\n1. Connect to a remote server via SSH\n2. Clone a repository from GitHub\n3. Start editing files with full IDE features\n4. Build and deploy your application\n\n## Keyboard Shortcuts\n\n- Ctrl+S - Save file\n- Ctrl+N - New file\n- Ctrl+` - Toggle terminal\n- Ctrl+Shift+F - Global search\n\nEnjoy coding! 🚀" }
};

export const remoteTree = {
  'var': { type:'folder', children: { 'www': { type:'folder', children: { 'html': { type:'folder', children: {
    'index.php': { type:'file', content: "<?php\necho 'Hello from remote server!';\nphpinfo();\n?>" },
    'config.php': { type:'file', content: "<?php\ndefine('DB_HOST','localhost');\ndefine('DB_NAME','production_db');\n?>" }
  }}}}}},
  'home': { type:'folder', children: { 'developer': { type:'folder', children: { 'projects': { type:'folder', children: {
    'my-app': { type:'folder', children: { 'app.js': { type:'file', content: "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => {\n  res.send('Hello from remote server!');\n});\napp.listen(3000);" } } }
  }}}}}
};
