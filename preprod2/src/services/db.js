import { showNotification } from '../ui/notifications.js';

export function testConnection(){ showNotification('🔗 Testing database connection...', 'info'); setTimeout(()=> showNotification('✅ Connection successful', 'success'), 800); }
export function saveConnection(){ showNotification('✅ Database connection saved', 'success'); document.querySelector('#databaseModal')?.classList.add('hidden'); }
export function connect(name){ showNotification(`🔗 Connecting to ${name}...`, 'info'); }
export function executeQuery(){
  const q = document.getElementById('sqlQuery')?.value || '';
  if (!q.trim()){ showNotification('⚠️ Please enter a SQL query', 'warning'); return; }
  showNotification('⚡ Executing query...', 'info');
}
export function clearQuery(){ const el = document.getElementById('sqlQuery'); if (el) el.value=''; }
