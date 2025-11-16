import { useState } from 'react';
import Button from '@components/shared/Button';
import { TextArea, TextInput } from '@components/shared/Input';
import { useGoal } from '@hooks/useGoal';
import { useAppStore } from '@store/appStore';

const TYPES = ['Create Deliverable','Learn/Understand','Debug/Solve Problem','Brainstorm/Ideate','Research Topic','Refine/Iterate','Custom'];

export default function GoalEditor({ onClose }: { onClose: () => void }) {
  const s = useAppStore();
  const { save, update } = useGoal();
  const [goal, setGoal] = useState({
    goal_text: s.goal?.goal_text || '',
    goal_type: s.goal?.goal_type || 'Create Deliverable',
    success_criteria: s.goal?.success_criteria || [ { text: 'First milestone', checked: false } ],
    constraints: s.goal?.constraints || [''],
    progress: s.goal?.progress ?? 0
  });

  const onSubmit = async () => {
    if (!goal.goal_text.trim()) return alert('Goal description is required');
    if (s.goal) await update(s.goal.id, goal); else await save(goal);
    onClose();
  };

  return (
    <div className="border border-slate-700 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="text-lg font-semibold">🎯 Edit Conversation Goal</div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕ Close</button>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-sm mb-1 block">Goal Description</label>
          <TextArea value={goal.goal_text} onChange={e => setGoal(g => ({ ...g, goal_text: e.target.value }))} />
        </div>
        <div>
          <label className="text-sm mb-1 block">Goal Type</label>
          <select className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" value={goal.goal_type} onChange={e => setGoal(g => ({ ...g, goal_type: e.target.value }))}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm mb-1 block">Success Criteria</label>
          <div className="space-y-2">
            {goal.success_criteria.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="checkbox" checked={c.checked} onChange={e => setGoal(g => { const sc=[...g.success_criteria]; sc[i] = { ...sc[i], checked: e.target.checked }; return { ...g, success_criteria: sc }; })} />
                <TextInput value={c.text} onChange={e => setGoal(g => { const sc=[...g.success_criteria]; sc[i] = { ...sc[i], text: e.target.value }; return { ...g, success_criteria: sc }; })} />
                <button className="ml-2 text-slate-400 hover:text-slate-200" onClick={() => setGoal(g => ({ ...g, success_criteria: g.success_criteria.filter((_,j)=>j!==i) }))}>🗑️</button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setGoal(g => ({ ...g, success_criteria: [...g.success_criteria, { text: '', checked: false }] }))}>+ Add</Button>
            </div>
          </div>
        </div>
        <div>
          <label className="text-sm mb-1 block">Constraints</label>
          <div className="space-y-2">
            {goal.constraints.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <TextInput value={c} onChange={e => setGoal(g => { const cs=[...g.constraints]; cs[i]=e.target.value; return { ...g, constraints: cs }; })} />
                <button className="ml-2 text-slate-400 hover:text-slate-200" onClick={() => setGoal(g => ({ ...g, constraints: g.constraints.filter((_,j)=>j!==i) }))}>🗑️</button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setGoal(g => ({ ...g, constraints: [...g.constraints, ''] }))}>+ Add</Button>
            </div>
          </div>
        </div>
        <div>
          <label className="text-sm mb-1 block">Progress: {goal.progress}%</label>
          <input type="range" min={0} max={100} value={goal.progress} onChange={e => setGoal(g => ({ ...g, progress: Number(e.target.value) }))} className="w-full" />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onSubmit}>Save Goal</Button>
        </div>
      </div>
    </div>
  );
}
