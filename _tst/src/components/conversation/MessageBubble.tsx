import { useMessages } from '@hooks/useMessages';
import { useBranches } from '@hooks/useBranches';
import Modal from '@components/shared/Modal';

export default function MessageBubble({ message }: { message: Message }) {
  const { create } = useBranches();
  const [showRate, setShowRate] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showBranch, setShowBranch] = useState(false);
  const [branchName, setBranchName] = useState('alternative-approach');
  const [branchDesc, setBranchDesc] = useState('');

  const isUser = message.role === 'user';
  const [hover, setHover] = useState(false);
  const { updateMeta } = useMessages();

  const actions = (
    <div className={`flex items-center gap-1 mt-1 ${hover ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
      <Tooltip content="Copy"><button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700" onClick={() => navigator.clipboard.writeText(message.content)}><Clipboard size={16} /></button></Tooltip>
      <Tooltip content="Pin"><button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700" onClick={() => updateMeta(message.id, { is_pinned: !message.metadata?.is_pinned })}><Pin size={16} /></button></Tooltip>
      <div className="relative">
        <Tooltip content="Rate"><button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700" onClick={() => setShowRate(v=>!v)}><Star size={16} /></button></Tooltip>
        {showRate && (
          <div className="absolute right-0 mt-2 bg-slate-900 border border-slate-700 rounded-lg p-2 z-10">
            <div className="flex gap-1">
              {[1,2,3,4,5].map(n => (
                <button key={n} className="px-2 py-1 hover:bg-slate-800 rounded" onClick={() => { updateMeta(message.id, { rating: n }); setShowRate(false); }}>{'⭐'.repeat(n)}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      <Tooltip content="Branch"><button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700" onClick={() => setShowBranch(true)}><Leaf size={16} /></button></Tooltip>
      <div className="relative">
        <Tooltip content="More"><button className="w-8 h-8 grid place-items-center rounded-md hover:bg-slate-700" onClick={() => setShowMore(v=>!v)}><MoreHorizontal size={16} /></button></Tooltip>
        {showMore && (
          <div className="absolute right-0 mt-2 bg-slate-900 border border-slate-700 rounded-lg p-2 z-10 w-48">
            <button className="w-full text-left px-2 py-2 hover:bg-slate-800 text-sm">✏️ Edit Message</button>
            <button className="w-full text-left px-2 py-2 hover:bg-slate-800 text-sm">🔄 Regenerate</button>
            <button className="w-full text-left px-2 py-2 hover:bg-slate-800 text-sm">🗑️ Delete</button>
            <button className="w-full text-left px-2 py-2 hover:bg-slate-800 text-sm">📊 View Context Impact</button>
            <button className="w-full text-left px-2 py-2 hover:bg-slate-800 text-sm" onClick={() => { navigator.clipboard.writeText(window.location.href + '#' + message.id); setShowMore(false); }}>🔗 Copy Message Link</button>
          </div>
        )}
      </div>
    </div>
  );


  const meta = message.metadata;
  const badges = (
    <div className="text-[11px] text-slate-400 flex items-center gap-3 mt-2">
      {meta?.cost != null && <span>💰 {fmt.costUSD(meta.cost)}</span>}
      {meta?.tokens != null && <span>🔢 {meta.tokens}</span>}
      {meta?.durationSec != null && <span>⏱️ {fmt.seconds(meta.durationSec)}</span>}
      {meta?.rating != null && <span>{'⭐'.repeat(Math.round(meta.rating||0))}</span>}
    </div>
  );

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {!isUser && <div className="w-8 h-8 mr-3 rounded-full bg-slate-700 grid place-items-center">🤖</div>}
      <div className={`${isUser ? 'bg-blue-600 text-white rounded-2xl rounded-br-sm':'bg-slate-800 border border-slate-700 text-slate-50 rounded-2xl rounded-bl-sm'} max-w-[85%] p-4`}> 
        <div className="whitespace-pre-wrap leading-6 text-sm">{message.content}</div>
        {badges}
        {actions}
        <Modal open={showBranch} onClose={() => setShowBranch(false)} title="Create New Branch">
          <div className="space-y-3">
            <div>
              <label className="text-sm mb-1 block">Branch Name</label>
              <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" value={branchName} onChange={e => setBranchName(e.target.value)} />
            </div>
            <div>
              <label className="text-sm mb-1 block">Description (optional)</label>
              <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" value={branchDesc} onChange={e => setBranchDesc(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="px-3 py-2 rounded bg-slate-800 border border-slate-700" onClick={() => setShowBranch(false)}>Cancel</button>
              <button className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-700" onClick={async () => {
                await create({ id: `branch-${Date.now()}`, conversation_id: (window as any).conversationId || '', parent_branch_id: undefined, branch_point_message_id: message.id, name: branchName, description: branchDesc });
                setShowBranch(false);
              }}>Create Branch</button>
            </div>
          </div>
        </Modal>

      </div>
      {isUser && <div className="w-8 h-8 ml-3 rounded-full bg-blue-500 grid place-items-center text-white">U</div>}
    </div>
  );
}
