import Modal from '@components/shared/Modal';
import Button from '@components/shared/Button';
import { api } from '@services/api';
import { useEffect, useState } from 'react';

export default function SchemaViewer({ open, onClose, schemaId, onDelete }: { open: boolean; onClose: () => void; schemaId: number; onDelete: () => Promise<void> }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { (async () => { if(open){ const res = await (await api.getSchema(schemaId)).json(); setData(res.schema || null); } })(); }, [open, schemaId]);
  return (
    <Modal open={open} onClose={onClose} title={`📋 Schema #${schemaId}`}>
      <pre className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs overflow-auto max-h-[50vh]">{JSON.stringify(data, null, 2)}</pre>
      <div className="flex justify-end gap-2 mt-3">
        <Button onClick={() => { navigator.clipboard.writeText(JSON.stringify(data, null, 2)); }}>Copy Schema</Button>
        <Button variant="ghost">Edit</Button>
        <Button variant="primary" onClick={onDelete}>Delete</Button>
      </div>
    </Modal>
  );
}
