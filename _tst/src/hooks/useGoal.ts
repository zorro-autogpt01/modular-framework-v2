import { api } from '@services/api';
import { useAppStore } from '@store/appStore';

export function useGoal() {
  const s = useAppStore();
  const load = async () => {
    if (!s.conversationId) return;
    const res = await (await api.getGoal(s.conversationId)).json();
    s.setState({ goal: res.goal || null });
  };
  const save = async (payload: any) => {
    if (!s.conversationId) return;
    const res = await (await api.createGoal(s.conversationId, payload)).json();
    s.setState({ goal: res.goal });
  };
  const update = async (id: string, payload: any) => {
    const res = await (await api.updateGoal(id, payload)).json();
    s.setState({ goal: res.goal });
  };
  return { load, save, update };
}
