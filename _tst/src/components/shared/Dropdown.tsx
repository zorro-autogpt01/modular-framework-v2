import { useEffect, useRef, useState } from 'react';
import { clsx } from '@utils/helpers';

interface Item { id: string | number; name: string; description?: string; selected?: boolean; }
interface Props {
  label: string;
  items: Item[];
  onOpen?: () => void;
  onSelect: (item: Item) => void;
  width?: number;
}

export default function Dropdown({ label, items, onOpen, onSelect, width = 240 }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (!ref.current?.contains(e.target as any)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => { if (!open) onOpen?.(); setOpen(v => !v); }} className="h-10 px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm flex items-center gap-2">
        <span>{label}</span>
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 max-h-[400px] overflow-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-10" style={{ width }}>
          {items.map((it, idx) => (
            <div key={idx} onClick={() => { onSelect(it); setOpen(false); }} className={clsx('p-3 cursor-pointer hover:bg-slate-800', it.selected && 'bg-blue-600 hover:bg-blue-600')}>
              <div className="text-sm font-semibold">{it.name}</div>
              {it.description && <div className="text-xs text-slate-400">{it.description}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
