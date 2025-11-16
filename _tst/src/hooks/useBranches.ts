import { api } from '@services/api';
import { useAppStore } from '@store/appStore';
import type { Branch } from '@types';

export function useBranches() {
  const s = useAppStore();
  const reload = async () => {
    if (!s.conversationId) return;
    const res = await (await api.listBranches(s.conversationId)).json();
    s.setState({ branches: res.branches || [] });
  };
  const activate = async (branchId: string) => {
    await api.activateBranch(branchId);
    s.setState({ activeBranchId: branchId, messages: [] });
    const msgs = await (await api.getBranchMessages(branchId, { limit: 50 })).json();
    s.setState({ messages: msgs.messages || [] });
  };
  const create = async (payload: Partial<Branch>) => {
    const res = await (await api.createBranch(payload)).json();
    await api.activateBranch(res.branch.id);
    await reload();
    await activate(res.branch.id);
  };
  return { reload, activate, create };
}
