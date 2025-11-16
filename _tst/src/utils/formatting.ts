export const fmt = {
  costUSD: (v?: number) => (v == null ? '' : `$${v.toFixed(4)}`),
  tokens: (v?: number) => (v == null ? '' : `${v.toLocaleString()} tokens`),
  seconds: (v?: number) => (v == null ? '' : `${v.toFixed(1)}s`),
  date: (iso?: string) => (iso ? new Date(iso).toLocaleString() : ''),
};
