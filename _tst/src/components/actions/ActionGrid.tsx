import { useEffect, useState } from 'react';
import { api } from '@services/api';
import ActionCard from './ActionCard';

const FILTERS = ['All','Content','Code','Analysis','Workflow'] as const;

export default function ActionGrid() {
  const [filter, setFilter] = useState<typeof FILTERS[number]>('All');
  const [items, setItems] = useState<any[]>([]);

  const load = async (cat?: string) => {
    const res = await (await api.listActions(cat)).json();
    setItems(res.actions || []);
  };
  useEffect(() => { load(filter==='All'? undefined : filter.toLowerCase()); }, [filter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`px-3 py-2 rounded-lg text-sm border ${filter===f? 'bg-blue-600 border-blue-500':'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}>{f}</button>
        ))}
      </div>
      <div className="grid grid-cols-3 xl:grid-cols-3 lg:grid-cols-2 md:grid-cols-2 sm:grid-cols-1 gap-4">
        {items.map((a: any) => (<ActionCard key={a.id} action={a} />))}
      </div>
    </div>
  );
}
