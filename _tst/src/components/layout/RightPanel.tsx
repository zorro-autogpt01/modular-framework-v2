import { useAppStore } from '@store/appStore';
import Button from '@components/shared/Button';
import BranchTree from '@components/branches/BranchTree';
import GoalCard from '@components/advisor/GoalCard';
import SuggestionList from '@components/advisor/SuggestionList';
import ActionGrid from '@components/actions/ActionGrid';
import TokenUsage from '@components/context/TokenUsage';
import MessagePriority from '@components/context/MessagePriority';
import OptimizationStrategies from '@components/context/OptimizationStrategies';
import SchemaGrid from '@components/schemas/SchemaGrid';
import { TreePine, Target, Zap, BarChart2, ClipboardList } from 'lucide-react';

export default function RightPanel({ activeTab }: { activeTab: ReturnType<typeof useAppStore>['activeTab'] }) {
  const { setActiveTab } = useAppStore();
  const tabs = [
    { key: 'tree', label: 'Tree', icon: <TreePine size={18} /> },
    { key: 'advisor', label: 'Advisor', icon: <Target size={18} /> },
    { key: 'actions', label: 'Actions', icon: <Zap size={18} /> },
    { key: 'context', label: 'Context', icon: <BarChart2 size={18} /> },
    { key: 'schemas', label: 'Schemas', icon: <ClipboardList size={18} /> },
  ] as const;

  return (
    <div className="h-full flex flex-col">
      <div className="h-14 border-b border-slate-700 flex items-center px-2 gap-2">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setActiveTab(t.key as any)} className={`min-w-[120px] h-14 px-6 flex flex-col items-center justify-center gap-1 border-b-4 ${activeTab===t.key? 'bg-blue-600 text-white border-blue-400':'text-slate-400 hover:bg-slate-800 hover:text-slate-200 border-transparent'}`}>
            <div>{t.icon}</div>
            <div className="text-xs font-medium">{t.label}</div>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4 scrollbar">
        {activeTab === 'tree' && <BranchTree />}
        {activeTab === 'advisor' && (
          <div className="space-y-4">
            <GoalCard />
            <SuggestionList />
          </div>
        )}
        {activeTab === 'actions' && <ActionGrid />}
        {activeTab === 'context' && (
          <div className="space-y-4">
            <TokenUsage />
            <MessagePriority />
            <OptimizationStrategies />
          </div>
        )}
        {activeTab === 'schemas' && <SchemaGrid />}
      </div>
    </div>
  );
}
