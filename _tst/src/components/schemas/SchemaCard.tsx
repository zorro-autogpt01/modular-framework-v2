import Button from '@components/shared/Button';
import SchemaViewer from './SchemaViewer';
import { useState } from 'react';
import { api } from '@services/api';
import { useAppStore } from '@store/appStore';

export default function SchemaCard({ schema, onChanged }: { schema: any; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const s = useAppStore();

  return (
    <div className="w-[280px] h-[180px] bg-slate-800 border border-slate-700 rounded-lg p-5">
      <div className="font-semibold">📋 {schema.name}</div>
      <div className="text-[13px] text-slate-400 mt-2 line-clamp-3">{schema.description}</div>
      <div className="text-[11px] text-slate-500 mt-2">Category: {schema.category || 'N/A'}</div>
      <div className="text-[11px] text-slate-500">Used {schema.usage_count || 0} times</div>
      <div className="flex gap-2 mt-3">
        <Button size="sm" onClick={() => setOpen(true)}>View Schema</Button>
        <Button size="sm" variant="primary" onClick={() => { s.setState({ structuredOutputEnabled: true, activeSchemaId: schema.id }); s.setActiveTab('tree'); }}>Use in Chat</Button>
      </div>
      <SchemaViewer open={open} onClose={() => setOpen(false)} schemaId={schema.id} onDelete={async () => { await api.deleteSchema(schema.id); setOpen(false); onChanged(); }} />
    </div>
  );
}
