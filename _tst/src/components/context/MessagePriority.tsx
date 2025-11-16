import { useAppStore } from '@store/appStore';
import { useMessages } from '@hooks/useMessages';

export default function MessagePriority() {
  const s = useAppStore();
  const { updateMeta } = useMessages();

  const cycle = (mId: string, current?: number) => {
    const next = ((current ?? 2) + 1) % 4 as 0|1|2|3;
    updateMeta(mId, { priority_level: next });
  };

  return (
    <div className="border border-slate-700 rounded-lg p-5">
      <div className="text-lg font-semibold mb-3">📌 Message Priority</div>
      <div className="divide-y divide-slate-700 border border-slate-700 rounded-lg">
        {s.messages.map(m => (
          <div key={m.id} className="flex items-center justify-between px-3 py-2 hover:bg-slate-800">
            <div className="text-sm truncate max-w-[70%]">{m.role === 'system' ? 'System Prompt' : `"${m.content.slice(0,60)}${m.content.length>60?'…':''}"`}</div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">{m.metadata?.tokens || 0}t</span>
              <button className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs" onClick={() => cycle(m.id, m.metadata?.priority_level)}>
                {iconFor(m.metadata?.priority_level)}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-3">
        <button className="px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm">Pin Selected</button>
        <button className="px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm" onClick={async ()=>{ for (const m of s.messages) { await updateMeta(m.id, { is_pinned: false }); } }}>Unpin All</button>
      </div>

    </div>
  );
}

function iconFor(level?: number) {
  return level === 3 ? '📌' : level === 2 ? '🔼' : level === 1 ? '–' : '🔽';
}
