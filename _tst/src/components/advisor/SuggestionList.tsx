import { useEffect, useState } from 'react';
import { useAppStore } from '@store/appStore';
import { api } from '@services/api';
import SuggestionCard from './SuggestionCard';
import Button from '@components/shared/Button';
import { RotateCw } from 'lucide-react';

export default function SuggestionList() {
  const s = useAppStore();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<any[]>([]);

  const load = async () => {
    if (!s.conversationId) return;
    setLoading(true);
    try {
      const payload = {
        conversation_id: s.conversationId,
        goal: s.goal ? { goal_text: s.goal.goal_text, progress: s.goal.progress } : null,
        branches: s.branches,
        current_branch: s.activeBranchId,
        message_history: s.messages.slice(-10)
      };
      const res = await (await api.suggest(payload)).json();
      setItems(res.suggestions || []);
    } catch {
      setItems([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { if (s.goal) load(); }, [s.goal?.goal_text]);

  if (!s.goal) {
    return (
      <div className="border border-slate-700 rounded-lg p-10 text-center">
        <div className="text-4xl mb-4">💡</div>
        <div className="mb-4">Set a goal to get AI-suggested next steps based on your progress</div>
        <Button variant="primary" onClick={() => s.setActiveTab('advisor')}>Set Goal</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">💡 Suggested Next Steps</div>
        <Button size="sm" onClick={load}><span className="inline-flex items-center gap-2"><RotateCw size={16}/> Refresh</span></Button>
      </div>
      {loading ? (
        <div className="border border-slate-700 rounded-lg p-6 text-center">⟳ Generating suggestions...</div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {items.map((it, i) => (<SuggestionCard key={i} item={it} />))}
        </div>
      )}
    </div>
  );
}
