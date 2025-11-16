let currentTab = 0;
let tabs = [{ url: '', title: 'New Tab', history: [], historyIndex: -1 }];
let useProxy = false;
let bookmarks = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadBookmarks();
    
    document.getElementById('urlInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            navigate();
        }
    });
    
    // Default homepage
    navigateToUrl('https://www.google.com/webhp?igu=1');
});

function navigate() {
    const input = document.getElementById('urlInput').value.trim();
    if (!input) return;
    
    let url = input;
    
    // Add protocol if missing
    if (!url.match(/^https?:\/\//)) {
        if (url.includes('.') && !url.includes(' ')) {
            url = 'https://' + url;
        } else {
            // Treat as search
            url = `https://www.google.com/search?q=${encodeURIComponent(url)}&igu=1`;
        }
    }
    
    navigateToUrl(url);
}

function navigateToUrl(url) {
    const frame = document.getElementById('browserFrame');
    const proxyView = document.getElementById('proxyView');
    
    document.getElementById('urlInput').value = url;
    document.getElementById('statusText').textContent = `Loading ${url}...`;
    
    if (useProxy) {
        // Use proxy mode
        frame.style.display = 'none';
        proxyView.style.display = 'block';
        
        fetch(`/api/proxy?url=${encodeURIComponent(url)}`)
            .then(res => res.text())
            .then(html => {
                proxyView.innerHTML = html;
                document.getElementById('statusText').textContent = `Loaded via proxy: ${url}`;
            })
            .catch(err => {
                proxyView.innerHTML = `<p>Error loading page: ${err.message}</p>`;
                document.getElementById('statusText').textContent = 'Error loading page';
            });
    } else {
        // Direct iframe mode
        proxyView.style.display = 'none';
        frame.style.display = 'block';
        
        try {
            frame.src = url;
            
            // Update tab
            tabs[currentTab].url = url;
            tabs[currentTab].history.push(url);
            tabs[currentTab].historyIndex = tabs[currentTab].history.length - 1;
            
            // Try to get title (may be blocked by CORS)
            setTimeout(() => {
                try {
                    const title = frame.contentDocument?.title || new URL(url).hostname;
                    tabs[currentTab].title = title;
                    updateTabs();
                } catch (e) {
                    // CORS blocked, use URL as title
                    tabs[currentTab].title = new URL(url).hostname;
                    updateTabs();
                }
            }, 1000);
            
            document.getElementById('statusText').textContent = `Loaded: ${url}`;
        } catch (err) {
            document.getElementById('statusText').textContent = 'Error loading page';
        }
    }
    
    updateNavigationButtons();
}

// create a persistent control id for this browser pane (so you can target it)
const CONTROL_ID = localStorage.getItem('browserControlId') || (self.crypto?.randomUUID?.() || String(Date.now()));
localStorage.setItem('browserControlId', CONTROL_ID);

// show it somewhere handy
document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('statusText');
  status.textContent = `Ready • Control ID: ${CONTROL_ID}`;
});

// connect to WS
function wsUrl(path) {
  const base = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  return `${base}${path}`;
}
const ws = new WebSocket(wsUrl(`/api/browser/api/ui/ws?id=${encodeURIComponent(CONTROL_ID)}`));

ws.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'navigate': navigateToUrl(msg.url); break;
      case 'reload':   reload(); break;
      case 'back':     goBack(); break;
      case 'forward':  goForward(); break;
      case 'proxy':    useProxy = !!msg.enable; if (tabs[currentTab].url) navigateToUrl(tabs[currentTab].url); break;
      case 'eval':
        // only run in proxy mode, since iframe cross-origin cannot be scripted
        if (useProxy) {
          try { /* optionally eval inside proxyView */ } catch {}
        }
        break;
    }
  } catch {}
};

// (optional) let the parent framework know the CONTROL_ID
window.parent?.postMessage({ type: 'MODULE_EVENT', eventName: 'browser:ready', payload: { controlId: CONTROL_ID } }, '*');


function goBack() {
    const tab = tabs[currentTab];
    if (tab.historyIndex > 0) {
        tab.historyIndex--;
        navigateToUrl(tab.history[tab.historyIndex]);
    }
}

function goForward() {
    const tab = tabs[currentTab];
    if (tab.historyIndex < tab.history.length - 1) {
        tab.historyIndex++;
        navigateToUrl(tab.history[tab.historyIndex]);
    }
}

function reload() {
    const frame = document.getElementById('browserFrame');
    if (frame.src) {
        frame.src = frame.src;
    }
}

function goHome() {
    navigateToUrl('https://www.google.com/webhp?igu=1');
}

function newTab() {
    tabs.push({ url: '', title: 'New Tab', history: [], historyIndex: -1 });
    currentTab = tabs.length - 1;
    updateTabs();
    document.getElementById('urlInput').value = '';
    document.getElementById('browserFrame').src = 'about:blank';
}

function updateTabs() {
    const tabBar = document.querySelector('.tab-bar');
    const existingTabs = tabBar.querySelectorAll('.tab');
    existingTabs.forEach(tab => tab.remove());
    
    tabs.forEach((tab, index) => {
        const tabEl = document.createElement('div');
        tabEl.className = `tab ${index === currentTab ? 'active' : ''}`;
        tabEl.dataset.tab = index;
        tabEl.innerHTML = `
            <span>${tab.title}</span>
            <button class="tab-close" onclick="closeTab(event, ${index})">×</button>
        `;
        tabEl.onclick = (e) => {
            if (!e.target.classList.contains('tab-close')) {
                switchTab(index);
            }
        };
        tabBar.insertBefore(tabEl, tabBar.querySelector('.new-tab'));
    });
}

function switchTab(index) {
    currentTab = index;
    const tab = tabs[index];
    if (tab.url) {
        navigateToUrl(tab.url);
    } else {
        document.getElementById('urlInput').value = '';
        document.getElementById('browserFrame').src = 'about:blank';
    }
    updateTabs();
}

function closeTab(event, index) {
    event.stopPropagation();
    if (tabs.length > 1) {
        tabs.splice(index, 1);
        if (currentTab >= tabs.length) {
            currentTab = tabs.length - 1;
        }
        switchTab(currentTab);
    }
}

function updateNavigationButtons() {
    const tab = tabs[currentTab];
    document.getElementById('backBtn').disabled = tab.historyIndex <= 0;
    document.getElementById('forwardBtn').disabled = tab.historyIndex >= tab.history.length - 1;
}

function toggleProxy() {
    useProxy = !useProxy;
    document.getElementById('securityStatus').textContent = useProxy ? '🔓 Proxy Mode' : '🔒 Secure';
    if (tabs[currentTab].url) {
        navigateToUrl(tabs[currentTab].url);
    }
}

function toggleBookmark() {
    const url = document.getElementById('urlInput').value;
    if (!url) return;
    
    const existing = bookmarks.find(b => b.url === url);
    if (existing) {
        removeBookmark(existing.id);
    } else {
        addBookmark();
    }
}

function addBookmark() {
    const url = document.getElementById('urlInput').value;
    const title = tabs[currentTab].title || 'Untitled';
    
    fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, url })
    })
    .then(res => res.json())
    .then(bookmark => {
        bookmarks.push(bookmark);
        updateBookmarksBar();
    });
}

function removeBookmark(id) {
    fetch(`/api/bookmarks/${id}`, { method: 'DELETE' })
    .then(() => {
        bookmarks = bookmarks.filter(b => b.id !== id);
        updateBookmarksBar();
    });
}

function loadBookmarks() {
    fetch('/api/bookmarks')
    .then(res => res.json())
    .then(data => {
        bookmarks = data;
        updateBookmarksBar();
    });
}

function updateBookmarksBar() {
    const bar = document.getElementById('bookmarksBar');
    bar.innerHTML = bookmarks.map(b => `
        <div class="bookmark" onclick="navigateToUrl('${b.url}')">
            ${b.title}
        </div>
    `).join('');
}

// Message passing with framework
window.addEventListener('message', (event) => {
    if (event.data.type === 'NAVIGATE') {
        navigateToUrl(event.data.url);
    }
});

// Notify parent frame
window.parent?.postMessage({ 
    type: 'MODULE_EVENT', 
    eventName: 'browser:ready', 
    payload: {} 
}, '*');