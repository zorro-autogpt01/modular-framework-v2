import { useAppStore } from '@store/appStore';
import Button from '@components/shared/Button';
import GoalEditor from './GoalEditor';
import { useState } from 'react';

export default function GoalCard() {
  const s = useAppStore();
  const [edit, setEdit] = useState(false);
  if (!s.goal && !edit) {
    return (
      <div className="border border-slate-700 rounded-lg p-6 flex items-center justify-between">
        <div className="text-lg">🎯 Set Conversation Goal</div>
        <Button variant="primary" onClick={() => setEdit(true)}>Set Goal →</Button>
      </div>
    );
  }
  if (edit) return <GoalEditor onClose={() => setEdit(false)} />;
  const g = s.goal!;
  return (
    <div className="border border-slate-700 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="text-lg font-semibold">🎯 Goal: {g.goal_text}</div>
        <Button size="sm" onClick={() => setEdit(true)}>✏️ Edit</Button>
      </div>
      <div className="text-sm text-slate-300">Type: {g.goal_type}</div>
      <div className="mt-3">
        <div className="text-sm mb-1">Progress: {g.progress}%</div>
        <div className="h-4 bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full bg-blue-600" style={{ width: `${g.progress}%` }} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-6 mt-4">
        <div>
          <div className="font-medium mb-2">Success Criteria</div>
          <ul className="space-y-1 text-sm">
            {g.success_criteria.map((c, i) => (
              <li key={i}>{c.checked ? '✅' : '☐'} {c.text}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="font-medium mb-2">Constraints</div>
          <ul className="space-y-1 text-sm list-disc list-inside">
            {g.constraints.map((c, i) => (<li key={i}>{c}</li>))}
          </ul>
        </div>
      </div>
    </div>
  );
}
