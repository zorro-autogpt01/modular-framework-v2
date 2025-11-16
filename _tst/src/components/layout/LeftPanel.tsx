import GoalBanner from '@components/conversation/GoalBanner';
import MessageBubble from '@components/conversation/MessageBubble';
import MessageInput from '@components/conversation/MessageInput';
import { useAppStore } from '@store/appStore';
import { useEffect, useRef } from 'react';

export default function LeftPanel() {
  const { messages, isSending } = useAppStore();
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-slate-700">
        <GoalBanner />
      </div>
      <div ref={containerRef} className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar" aria-live="polite">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {isSending && (
          <div className="flex justify-start">
            <div className="w-8 h-8 mr-3 rounded-full bg-slate-700 grid place-items-center">🤖</div>
            <div className="bg-slate-800 border border-slate-700 text-slate-50 rounded-2xl rounded-bl-sm max-w-[85%] p-4 animate-pulse">
              <div className="text-sm">⋯ Thinking...</div>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-slate-700 p-4">
        <MessageInput />
      </div>
    </div>
  );
}
