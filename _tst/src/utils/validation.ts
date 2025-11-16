export function requireText(v: string, field = 'Field') {
  if (!v || !v.trim()) throw new Error(`${field} is required`);
  return v.trim();
}
