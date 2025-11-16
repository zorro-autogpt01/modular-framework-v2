import Button from '@components/shared/Button';
import BranchNode from '@components/branches/BranchNode';
import BranchMinimap from '@components/branches/BranchMinimap';
import { useAppStore } from '@store/appStore';
import { useBranches } from '@hooks/useBranches';
import { Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import Modal from '@components/shared/Modal';

export default function BranchTree() {
  const s = useAppStore();
  const { create } = useBranches();
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('alternative-approach');
  const [desc, setDesc] = useState('Try a different method');
  const [optsOpen, setOptsOpen] = useState(false);


  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="primary" className="w-[140px] h-10" onClick={() => setModal(true)}>
          <span className="inline-flex items-center gap-2"><Plus size={16} /> New Branch</span>
        </Button>
        <div className="relative">
          <button className="w-10 h-10 rounded-lg hover:bg-slate-800 grid place-items-center border border-slate-700" aria-label="Options" onClick={()=>setOptsOpen(v=>!v)}><Settings size={18} /></button>
          {optsOpen && (
            <div className="absolute right-0 mt-2 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-10 w-48">
              {['Collapse All','Expand All','Auto-organize','Export Tree','View as List'].map(opt => (
                <button key={opt} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-800" onClick={()=>setOptsOpen(false)}>{opt}</button>
              ))}
            </div>
          )}
        </div>
      </div>


      <div>
        {s.branches.length === 0 && (
          <div className="border border-slate-700 rounded-xl p-10 text-center text-slate-300">
            <div className="text-4xl mb-4">🌳</div>
            <div className="text-lg font-medium mb-2">No branches yet</div>
            <div className="mb-4">Create your first branch</div>
            <Button variant="primary" onClick={() => setModal(true)}>+ Create Branch</Button>
          </div>
        )}
        <div>
          {s.branches.map((b) => (
            <BranchNode key={b.id} branch={b} depth={b.parent_branch_id ? 1 : 0} />
          ))}
        </div>
      </div>

      <BranchMinimap />

      <Modal open={modal} onClose={() => setModal(false)} title="Create New Branch">
        <div className="space-y-3">
          <div>
            <label className="text-sm mb-1 block">Branch Name</label>
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="text-sm mb-1 block">Description</label>
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" value={desc} onChange={e => setDesc(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={async () => { await create({ id: `branch-${Date.now()}`, conversation_id: s.conversationId!, parent_branch_id: s.activeBranchId!, name, description: desc }); setModal(false); }}>Create Branch</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
