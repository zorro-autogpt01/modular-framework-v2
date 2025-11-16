import { useEffect } from 'react';
import TopBar from '@components/layout/TopBar';
import LeftPanel from '@components/layout/LeftPanel';
import RightPanel from '@components/layout/RightPanel';
import { useAppStore } from '@store/appStore';
import { ToastProvider } from '@components/shared/Toast';
import { useConversationBootstrap } from '@hooks/useConversation';

export default function App() {
  const activeTab = useAppStore(s => s.activeTab);
  useConversationBootstrap();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('message-input')?.focus();
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        const el = document.getElementById('message-input') as HTMLTextAreaElement | null;
        if (el) el.value = '';
      }
      if (mod && ['1','2','3','4','5'].includes(e.key)) {
        e.preventDefault();
        const map = ['tree','advisor','actions','context','schemas'] as const;
        useAppStore.getState().setActiveTab(map[Number(e.key)-1]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <ToastProvider>
      <div className="h-screen w-screen flex flex-col bg-slate-900 text-slate-50">
        <TopBar />
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row" style={{height: `calc(100vh - var(--topbar-height))`}}>
          <div className="border-b md:border-b-0 md:border-r border-slate-600 bg-slate-900 w-full md:w-full lg:w-1/2 xl:w-[40%] 2xl:w-[33%]">
            <LeftPanel />
          </div>
          <div className="flex-1 bg-slate-900">
            <RightPanel activeTab={activeTab} />
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
