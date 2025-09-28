export const qs = (sel, root=document) => root.querySelector(sel);
export const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));
export function el(tag, attrs={}, ...children){
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v])=>{
    if (k === 'className') node.className = v; else if (k.startsWith('on') && typeof v==='function') node.addEventListener(k.slice(2).toLowerCase(), v); else node.setAttribute(k, v);
  });
  children.forEach(c=>{ if(c==null) return; if (typeof c==='string') node.appendChild(document.createTextNode(c)); else node.appendChild(c); });
  return node;
}
