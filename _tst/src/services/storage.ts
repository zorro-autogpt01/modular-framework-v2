export function save<T>(key: string, value: T) { localStorage.setItem(key, JSON.stringify(value)); }
export function load<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) as T : null;
}
