import Button from '@components/shared/Button';
import Modal from '@components/shared/Modal';
import { useState } from 'react';
import { api } from '@services/api';
import { useAppStore } from '@store/appStore';

const strategies = [
  { key: 'auto-summarize', title: '📄 Auto-summarize old messages', desc: 'Compress messages older than 20 exchanges' },
  { key: 'pinned-only', title: '📌 Keep pinned only', desc: 'Remove all unpinned messages' },
  { key: 'sliding-window', title: '🔁 Sliding window (last 10)', desc: 'Keep only most recent 10 messages' },
  { key: 'smart-context', title: '🎯 Smart context (AI-driven)', desc: 'Let AI decide what to keep' },
];

export default function OptimizationStrategies() {
  const s = useAppStore();
  const [open, setOpen] = useState<string | null>(null);
  const apply = async (key: string) => {
    if (!s.activeBranchId) return;
    await api.optimizeContext({ branch_id: s.activeBranchId, max_tokens: 16000, strategy: key });
    setOpen(null);
  };

  return (
    <div className="border border-slate-700 rounded-lg p-5">
      <div className="text-lg font-semibold mb-3">⚙️ Optimization Strategies</div>
      <div className="grid grid-cols-1 gap-3">
        {strategies.map(st => (
          <div key={st.key} className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex items-center justify-between">
            <div>
              <div className="font-medium">{st.title}</div>
              <div className="text-sm text-slate-300">{st.desc}</div>
            </div>
            <Button onClick={() => setOpen(st.key)}>Apply Strategy</Button>
          </div>
        ))}
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title="Apply Strategy">
        <div className="text-sm text-slate-300">Preview not available in this stub. Apply strategy now?</div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => apply(open!)}>Apply</Button>
        </div>
      </Modal>
    </div>
  );
}
