import { useState } from 'react';
import { useAppStore } from '@store/appStore';
import Button from '@components/shared/Button';

export default function GoalBanner() {
  const { goal, setActiveTab } = useAppStore();
  const [collapsed, setCollapsed] = useState(false);
  if (!goal) {
    return (
      <div className="border border-blue-600/60 bg-blue-950/30 rounded-xl p-4 flex items-center justify-between">
        <div className="text-sm text-blue-200">💡 Set a goal to get AI-suggested next steps</div>
        <Button variant="primary" size="sm" onClick={() => setActiveTab('advisor')}>Set Goal →</Button>
      </div>
    );
  }
  if (collapsed) {
    return (
      <div className="border border-blue-600/60 bg-blue-950/30 rounded-xl px-3 py-1 text-sm flex items-center justify-between">
        <span>🎯 Goal set</span>
        <button className="text-blue-300 hover:underline" onClick={() => setCollapsed(false)}>Expand</button>
      </div>
    );
  }
  return (
    <div className="border border-blue-600 bg-blue-950/30 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-medium">🎯 Goal: {goal.goal_text}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setActiveTab('advisor')}>View Details</Button>
          <Button size="sm" variant="ghost" onClick={() => setCollapsed(true)}>△ Collapse</Button>
        </div>
      </div>
      <div className="text-sm text-slate-300 flex items-center gap-3">
        <span>Progress:</span>
        <div className="flex-1 h-3 bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full bg-blue-600" style={{ width: `${goal.progress}%` }} />
        </div>
        <span>{goal.progress}%</span>
      </div>
    </div>
  );
}
