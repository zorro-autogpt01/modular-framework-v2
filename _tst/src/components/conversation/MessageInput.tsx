import { useRef, useState } from 'react';
import { TextArea } from '@components/shared/Input';
import Button from '@components/shared/Button';
import Tooltip from '@components/shared/Tooltip';
import Dropdown from '@components/shared/Dropdown';
import { useAppStore } from '@store/appStore';
import { useMessages } from '@hooks/useMessages';
import { api } from '@services/api';
import { Paperclip, Mic, Send, ClipboardList, Target } from 'lucide-react';

export default function MessageInput() {
  const s = useAppStore();
  const { send } = useMessages();
  const [text, setText] = useState('');
  const [schemas, setSchemas] = useState<any[]>([]);
  const [showSchemaDD, setShowSchemaDD] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const onSend = async () => {
    if (!text.trim() || s.isSending) return;
    await send(text);
    setText('');
    taRef.current?.focus();
  };

  const loadSchemas = async () => {
    const data = await (await api.listSchemas()).json();
    setSchemas(data.schemas || []);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {s.structuredOutputEnabled && (
          <Dropdown
            label={s.activeSchemaId ? `Schema #${s.activeSchemaId}`: 'Schema: Select'}
            width={260}
            onOpen={() => { loadSchemas(); setShowSchemaDD(true); }}
            items={schemas.map((sc: any) => ({ id: sc.id, name: sc.name, description: sc.description, selected: sc.id === s.activeSchemaId }))}
            onSelect={(it) => s.setState({ activeSchemaId: Number(it.id) })}
          />
        )}
        <Tooltip content={s.structuredOutputEnabled ? 'Disable schema mode' : 'Enable schema mode'}>
          <button className={`w-10 h-10 rounded-lg border border-slate-700 grid place-items-center ${s.structuredOutputEnabled ? 'bg-blue-600' : 'bg-transparent hover:bg-slate-800'}`} onClick={() => s.setState({ structuredOutputEnabled: !s.structuredOutputEnabled })}>
            <ClipboardList size={18} />
          </button>
        </Tooltip>
        <Tooltip content="Smart actions">
          <button className="w-10 h-10 rounded-lg border border-slate-700 grid place-items-center hover:bg-slate-800" onClick={() => s.setActiveTab('actions')}>
            <Target size={18} />
          </button>
        </Tooltip>
      </div>

      <TextArea
        id="message-input"
        ref={taRef as any}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        }}
        placeholder="Type your message... (Shift+Enter for new line)"
        className="text-sm"
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-400 text-xs">
          <Tooltip content="Attach file (coming soon)"><button className="w-9 h-9 rounded-md hover:bg-slate-800 grid place-items-center"><Paperclip size={16} /></button></Tooltip>
          <Tooltip content="Voice input (coming soon)"><button className="w-9 h-9 rounded-md hover:bg-slate-800 grid place-items-center"><Mic size={16} /></button></Tooltip>
          <span className="ml-2">Shift+Enter for new line</span>
        </div>
        <Button variant="primary" className="w-[120px] h-10" disabled={!text.trim() || s.isSending} onClick={onSend}>
          {s.isSending ? 'Sending...' : (<span className="inline-flex items-center gap-2">Send <Send size={16} /></span>)}
        </Button>
      </div>
    </div>
  );
}
