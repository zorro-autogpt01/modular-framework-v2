import Modal from '@components/shared/Modal';
import Button from '@components/shared/Button';
import { TextArea } from '@components/shared/Input';
import { useState } from 'react';
import { api } from '@services/api';

export default function SchemaGenerator({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [desc, setDesc] = useState('');
  const [example, setExample] = useState('');
  const [loading, setLoading] = useState(false);
  const generate = async () => {
    setLoading(true);
    try {
      const res = await (await api.generateSchema({ description: desc, example_data: example ? JSON.parse(example) : undefined })).json();
      if (res.schema) await api.createSchema({ name: 'Generated Schema', description: desc, schema_definition: res.schema, category: 'Generated' });
      onCreated(); onClose();
    } finally { setLoading(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="🤖 AI Generate Schema">
      <div className="space-y-3">
        <div>
          <div className="text-sm mb-1">Describe what you want to extract:</div>
          <TextArea value={desc} onChange={e => setDesc(e.target.value)} />
        </div>
        <div>
          <div className="text-sm mb-1">Example data (optional):</div>
          <TextArea value={example} onChange={e => setExample(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={generate} disabled={loading}>{loading ? 'Generating...' : 'Generate Schema'}</Button>
        </div>
      </div>
    </Modal>
  );
}
