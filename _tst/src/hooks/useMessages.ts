import { api } from '@services/api';
import { useAppStore } from '@store/appStore';
import type { Message } from '@types';

export function useMessages() {
  const s = useAppStore();
  const send = async (text: string) => {
    if (!s.conversationId || !s.activeBranchId) return;
    const userMsg: Message = { id: `temp-${Date.now()}`, role: 'user', content: text, created_at: new Date().toISOString() };
    s.setState({ isSending: true, messages: [...s.messages, userMsg] });
    try {
      const payload = {
        conversation_id: s.conversationId,
        branch_id: s.activeBranchId,
        personality_id: s.selectedPersonalityId ?? undefined,
        schema_id: s.structuredOutputEnabled ? s.activeSchemaId : undefined,
        message: text,
        model: s.selectedModelKey,
        stream: false,
      };
      const res = await (await api.chat(payload)).json();
      const aiMsg: Message = { id: `temp-ai-${Date.now()}`, role: 'assistant', content: res.content, created_at: new Date().toISOString(), metadata: { tokens: res.tokens, cost: res.cost } };
      s.setState({ messages: [...s.messages, userMsg, aiMsg] });
      const fresh = await (await api.getBranchMessages(s.activeBranchId, { limit: 100 })).json();
      s.setState({ messages: fresh.messages || [] });
    } catch (e: any) {
      s.setState({ error: e.message || 'Failed to send message' });
    } finally {
      s.setState({ isSending: false });
    }
  };
  const updateMeta = async (id: string, meta: any) => {
    await api.updateMessageMeta(id, meta);
  };
  return { send, updateMeta };
}
