import Button from '@components/shared/Button';
import { useAppStore } from '@store/appStore';

export default function SuggestionCard({ item }: { item: any }) {
  const s = useAppStore();
  const badgeClass = (type?: string) => {
    switch(type){
      case 'direct': return 'bg-green-900 text-green-300';
      case 'thorough': return 'bg-blue-900 text-blue-300';
      case 'validate': return 'bg-yellow-900 text-yellow-300';
      default: return 'bg-purple-900 text-purple-300';
    }
  };
  return (
    <div className="w-full min-h-[160px] p-5 bg-slate-800 border border-slate-700 rounded-lg hover:border-blue-500 transition-colors">
      <div className="flex items-center justify-between">
        <div className="font-semibold">{item.title}</div>
        <span className={`text-xs px-2 py-1 rounded ${badgeClass(item.path_type)}`}>{item.path_type || 'alternative'}</span>
      </div>
      <div className="text-slate-300 mt-3">"{item.prompt}"</div>
      {item.rationale && <div className="text-sm text-slate-400 mt-2">Why: {item.rationale}</div>}
      {item.estimated_exchanges && <div className="text-xs text-slate-500 mt-1">Est: {item.estimated_exchanges} exchanges</div>}
      <div className="mt-4">
        <Button variant="primary" onClick={() => { const el = document.getElementById('message-input') as HTMLTextAreaElement | null; if (el) { el.value = item.prompt; el.focus(); } s.setActiveTab('tree'); }}>
          Use This Prompt
        </Button>
      </div>
    </div>
  );
}
