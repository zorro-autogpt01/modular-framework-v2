export function joinRemotePath(base, relPath) {
  const b = (base || '/');
  const r = String(relPath || '');
  if (!r) return b || '/';
  if (r.startsWith('/')) return r; // already absolute on remote host
  const cleanBase = b.replace(/\/+$/, '');
  const cleanRel = r.replace(/^\/+/, '');
  return cleanBase === '/' ? '/' + cleanRel : cleanBase + '/' + cleanRel;
}
