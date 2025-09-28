export function showNotification(message, type='info', timeout=4000){
  document.querySelectorAll('.notification').forEach(n=>n.remove());
  const n = document.createElement('div');
  n.className = `notification ${type}`;
  n.textContent = message;
  document.body.appendChild(n);
  const rm = () => { if(n.parentNode) n.remove(); };
  setTimeout(rm, timeout);
  n.addEventListener('click', rm);
}
