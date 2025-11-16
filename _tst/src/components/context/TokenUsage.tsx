import { useAppStore } from '@store/appStore';

export default function TokenUsage() {
  const s = useAppStore();
  const messages = s.messages.length;
  const tokens = s.messages.reduce((acc, m) => acc + (m.metadata?.tokens || 0), 0);
  const avg = messages ? Math.round(tokens / messages) : 0;
  const max = 16000;
  const pct = Math.min(100, Math.round((tokens / max) * 100));
  const color = pct < 70 ? 'bg-green-500' : pct < 90 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="border border-slate-700 rounded-lg p-5">
      <div className="text-lg font-semibold mb-4">📊 Token Usage</div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Messages" value={String(messages)} />
        <Stat label="Tokens" value={tokens.toLocaleString()} />
        <Stat label="Avg/Msg" value={String(avg)} />
      </div>
      <div className="mt-4 text-sm">Context Window:</div>
      <div className="h-6 bg-slate-800 rounded overflow-hidden mt-1">
        <div className={`h-full ${color}`} style={{ width: pct + '%' }} />
      </div>
      <div className="text-sm text-slate-300 mt-1">{tokens.toLocaleString()} / {max.toLocaleString()} tokens • Estimated cost ${(tokens * 0.0000019).toFixed(4)}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-center">
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  );
}
