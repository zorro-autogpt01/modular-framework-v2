import { createContext, PropsWithChildren, useContext, useMemo, useState } from 'react';

type ToastType = 'error' | 'warning' | 'success' | 'info';
interface ToastItem { id: number; type: ToastType; title: string; message?: string; action?: { label: string; onClick: () => void } }

const Ctx = createContext<{ show: (type: ToastType, title: string, message?: string, action?: ToastItem['action']) => void } | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
  const [list, setList] = useState<ToastItem[]>([]);
  const api = useMemo(() => ({
    show: (type: ToastType, title: string, message?: string, action?: ToastItem['action']) => {
      const id = Date.now();
      setList(prev => [...prev, { id, type, title, message, action }]);
      setTimeout(() => setList(prev => prev.filter(t => t.id !== id)), 5000);
    }
  }), []);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {list.map(t => (
          <div key={t.id} className={`min-w-[280px] max-w-[360px] p-4 rounded-lg shadow-lg border ${t.type==='error'?'border-red-500 bg-red-950/50': t.type==='warning'?'border-amber-500 bg-amber-950/50': t.type==='success'?'border-emerald-500 bg-emerald-950/50':'border-blue-500 bg-blue-950/50'}`}>
            <div className="font-semibold mb-1">{t.title}</div>
            {t.message && <div className="text-sm text-slate-300">{t.message}</div>}
            {t.action && <button className="mt-2 text-sm text-blue-400 hover:underline" onClick={t.action.onClick}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ToastProvider missing');
  return ctx;
}
