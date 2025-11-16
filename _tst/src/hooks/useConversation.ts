import { useEffect } from 'react';
import { useAppStore } from '@store/appStore';
import { api } from '@services/api';

export function useConversationBootstrap() {
  const { conversationId, activeBranchId, setState } = useAppStore();

  useEffect(() => {
    async function init() {
      try {
        if (!conversationId) {
          const id = `conv-${Date.now()}`;
          const res = await api.createConversation({ id, title: 'New Conversation' });
          await res.json();
          const branchId = `branch-main-${Date.now()}`;
          await (await api.createBranch({ id: branchId, conversation_id: id, name: 'main' })).json();
          setState({ conversationId: id, activeBranchId: branchId });
        } else {
          // Load conversation
          const full = await (await api.getConversationFull(conversationId)).json();
          setState({
            branches: full.branches || [],
            goal: full.goal || null,
          });
          const active = activeBranchId || full.branches?.[0]?.id || null;
          if (active) {
            setState({ activeBranchId: active });
            const msgs = await (await api.getBranchMessages(active, { limit: 50 })).json();
            setState({ messages: msgs.messages || [] });
          }
        }
      } catch (e: any) {
        setState({ error: e.message || 'Failed to initialize' });
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
