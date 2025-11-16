import { PropsWithChildren, useState } from 'react';

export default function Tooltip({ content, children }: PropsWithChildren<{ content: string }>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {children}
      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 text-xs text-slate-200 px-2 py-1 rounded shadow-md whitespace-nowrap z-40">
          {content}
        </div>
      )}
    </div>
  );
}
