import Button from '@components/shared/Button';
import { useAppStore } from '@store/appStore';
import { api } from '@services/api';
import Modal from '@components/shared/Modal';
import { useState } from 'react';


export default function ActionCard({ action }: { action: any }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const s = useAppStore();

  const onUse = async () => {
    await api.trackActionUse(action.id);
    const template: string = action.prompt_template;
    const needsSelection = template.includes('{{selected_text}}');
    let prompt = template;
    if (needsSelection) {
      setConfirmOpen(true);
      return;
    }
    const el = document.getElementById('message-input') as HTMLTextAreaElement | null;
    if (el) { el.value = prompt; el.focus(); }
    s.setActiveTab('tree');
  };


  return (
    <div className="w-[280px] h-[180px] bg-slate-800 border border-slate-700 rounded-lg p-5 hover:border-blue-500 transition-transform hover:-translate-y-1">
      <div className="text-base font-semibold">{action.icon || '📝'} {action.name}</div>
      <div className="text-[13px] text-slate-400 leading-5 mt-2 line-clamp-3">{action.description}</div>
      <div className="text-[11px] text-slate-500 mt-2">Category: {action.category}</div>
      <div className="text-[11px] text-slate-500">Used {action.usage_count || 0} times</div>
      <div className="mt-3"><Button variant="primary" className="w-full h-9" onClick={onUse}>Use Action</Button></div>
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Select text first or use last message?">
        <div className="text-sm text-slate-300">No selection detected. Use the last message as input?</div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            const lastMsg = s.messages.slice().reverse().find(m => m.role==='assistant' || m.role==='user');
            if (!lastMsg) return setConfirmOpen(false);
            const filled = action.prompt_template.replace('{{selected_text}}', lastMsg.content).replace('{{conversation_context}}', s.messages.map(m=>`${m.role}: ${m.content}`).join('\n'));
            const el = document.getElementById('message-input') as HTMLTextAreaElement | null;
            if (el) { el.value = filled; el.focus(); }
            s.setActiveTab('tree');
            setConfirmOpen(false);
          }}>Use Last Message</Button>
        </div>
      </Modal>

    </div>
  );
}
