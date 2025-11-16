import { useEffect, useState } from 'react';
import { api } from '@services/api';
import SchemaCard from './SchemaCard';
import Button from '@components/shared/Button';
import SchemaGenerator from './SchemaGenerator';

export default function SchemaGrid() {
  const [items, setItems] = useState<any[]>([]);
  const [openGen, setOpenGen] = useState(false);

  const load = async () => {
    const res = await (await api.listSchemas()).json();
    setItems(res.schemas || []);
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => setOpenGen(true)}>+ Generate Schema</Button>
        <Button>+ Create Manual</Button>
      </div>
      <div className="grid grid-cols-3 xl:grid-cols-3 lg:grid-cols-2 md:grid-cols-2 sm:grid-cols-1 gap-4">
        {items.map(sc => (<SchemaCard key={sc.id} schema={sc} onChanged={load} />))}
      </div>
      <SchemaGenerator open={openGen} onClose={() => setOpenGen(false)} onCreated={load} />
    </div>
  );
}
