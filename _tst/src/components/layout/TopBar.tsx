import { Bell, Settings, User, ChevronDown } from 'lucide-react';
import Dropdown from '@components/shared/Dropdown';
import Button from '@components/shared/Button';
import { api } from '@services/api';
import { useAppStore } from '@store/appStore';
import { useToast } from '@components/shared/Toast';
import { useState } from 'react';

export default function TopBar() {
  const s = useAppStore();
  const toast = useToast();
  const [personalities, setPersonalities] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);

  const openPersonalities = async () => {
    try { const data = await (await api.listPersonalities()).json(); setPersonalities(data.personalities || []); }
    catch { toast.show('error', 'Failed to load personalities'); }
  };
  const openModels = async () => {
    try { const data = await (await api.listModels()).json(); setModels(data.items || []); }
    catch { toast.show('error', 'Failed to load models'); }
  };

  return (
    <div className="h-16 border-b border-slate-600 flex items-center justify-between px-4 bg-slate-900 sticky top-0 z-20">
      <div className="flex items-center gap-4">
        <div className="text-blue-400 text-2xl font-bold pl-2 select-none">LLM Chat Pro</div>
      </div>
      <div className="flex items-center gap-2">
        <Dropdown
          label={s.selectedPersonalityId ? `Personality #${s.selectedPersonalityId}` : 'Personality'}
          width={240}
          onOpen={openPersonalities}
          items={personalities.map((p: any) => ({ id: p.id, name: p.name, description: p.description, selected: p.id === s.selectedPersonalityId }))}
          onSelect={(it) => s.setState({ selectedPersonalityId: Number(it.id) })}
        />
        <Dropdown
          label={s.selectedModelKey}
          width={200}
          onOpen={openModels}
          items={models.map((m: any) => ({ id: m.id || m.key || m.name, name: m.name || m.id || m.key, description: m.provider || '', selected: (m.id||m.key||m.name) === s.selectedModelKey }))}
          onSelect={(it) => s.setState({ selectedModelKey: String(it.id) })}
        />
        <button aria-label="Notifications" className="w-10 h-10 rounded-lg hover:bg-slate-700 grid place-items-center relative">
          <Bell size={18} />
          {/* Badge example: */}
          {/* <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" /> */}
        </button>
        <button aria-label="Settings" className="w-10 h-10 rounded-lg hover:bg-slate-700 grid place-items-center">
          <Settings size={18} />
        </button>
        <button aria-label="User menu" className="w-10 h-10 rounded-full hover:bg-slate-700 grid place-items-center bg-slate-800">
          <User size={18} />
        </button>
      </div>
    </div>
  );
}
