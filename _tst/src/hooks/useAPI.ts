import { useEffect, useRef, useState } from 'react';

const cache = new Map<string, any>();

export function useGET<T>(key: string, fetcher: () => Promise<Response>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(cache.get(key) ?? null);
  const [loading, setLoading] = useState(!cache.has(key));
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<any> | null>(null);

  useEffect(() => {
    let mounted = true;
    async function run() {
      if (cache.has(key)) { setData(cache.get(key)); setLoading(false); return; }
      if (inflight.current) return;
      setLoading(true);
      try {
        inflight.current = fetcher();
        const res = await inflight.current;
        const json = await res.json();
        cache.set(key, json);
        if (mounted) setData(json);
      } catch (e: any) { if (mounted) setError(e.message || 'Error'); }
      finally { if (mounted) setLoading(false); inflight.current = null; }
    }
    run();
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error } as const;
}
