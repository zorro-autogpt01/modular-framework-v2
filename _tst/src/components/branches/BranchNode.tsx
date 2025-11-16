import { useBranches } from '@hooks/useBranches';
import { useAppStore } from '@store/appStore';
import type { Branch } from '@types';
import { Pencil, Trash2, BarChart } from 'lucide-react';
import { useState } from 'react';

export default function BranchNode({ branch, depth = 0 }: { branch: Branch; depth?: number }) {
  const s = useAppStore();
  const { activate } = useBranches();
  const active = s.activeBranchId === branch.id;
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(branch.name);


  return (
    <div className={`rounded-lg ${active ? 'bg-blue-950/30 border-l-4 border-blue-500' : 'hover:bg-slate-800'} cursor-pointer`} style={{ marginLeft: depth * 20 }} onClick={() => activate(branch.id)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full border-2 ${active ? 'border-blue-500 bg-blue-500':'border-slate-500'}`} />
            {!editing ? (
              <div className="text-sm font-medium text-slate-200">{branch.name} {active && <span className="ml-1 text-emerald-500">✓</span>}</div>
            ) : (
              <input className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm" value={name} onChange={e=>setName(e.target.value)} onBlur={async ()=>{ await fetch(`/api/branches/${branch.id}`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name })}); setEditing(false); }} autoFocus />
            )}
          </div>
          {hover && (
            <div className="flex items-center gap-1">
              <button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700" onClick={(e)=>{ e.stopPropagation(); setEditing(true); }}><Pencil size={16} /></button>
              <button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700" onClick={async (e)=>{ e.stopPropagation(); if (confirm('Delete this branch and children?')) { await fetch(`/api/branches/${branch.id}`, { method: 'DELETE' }); location.reload(); } }}><Trash2 size={16} /></button>
              <button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700"><BarChart size={16} /></button>
            </div>
          )}
        </div>
        <div className="text-xs text-slate-400 mt-1">{branch.stats?.message_count ?? 0} messages · {branch.stats?.token_count ?? 0} tokens</div>
      </div>

          </div>
          {hover && (
            <div className="flex items-center gap-1">
              <button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700"><Pencil size={16} /></button>
              <button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700"><Trash2 size={16} /></button>
              <button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700"><BarChart size={16} /></button>
            </div>
          )}
        </div>
        <div className="text-xs text-slate-400 mt-1">{branch.stats?.message_count ?? 0} messages · {branch.stats?.token_count ?? 0} tokens</div>
      </div>
    </div>
  );
}
