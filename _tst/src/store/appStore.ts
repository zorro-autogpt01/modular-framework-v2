import { create } from 'zustand';
import type { Branch, Goal, Message, Personality, SchemaDef, SmartAction, ID } from '@types';
import { persist } from 'zustand/middleware';

export type TabKey = 'tree' | 'advisor' | 'actions' | 'context' | 'schemas';

interface AppState {
  conversationId: ID | null;
  activeBranchId: ID | null;
  activeTab: TabKey;
  selectedPersonalityId: number | null;
  selectedModelKey: string;
  structuredOutputEnabled: boolean;
  activeSchemaId: number | null;
  messages: Message[];
  branches: Branch[];
  goal: Goal | null;
  personalities: Personality[];
  schemas: SchemaDef[];
  actions: SmartAction[];
  isLoading: boolean;
  isSending: boolean;
  error: string | null;
  setActiveTab: (t: TabKey) => void;
  setState: (partial: Partial<AppState>) => void;
  resetError: () => void;
}

export const useAppStore = create<AppState>()(persist((set) => ({
  conversationId: null,
  activeBranchId: null,
  activeTab: 'tree',
  selectedPersonalityId: null,
  selectedModelKey: 'gpt-4o-mini',
  structuredOutputEnabled: false,
  activeSchemaId: null,
  messages: [],
  branches: [],
  goal: null,
  personalities: [],
  schemas: [],
  actions: [],
  isLoading: false,
  isSending: false,
  error: null,
  setActiveTab: (activeTab) => set({ activeTab }),
  setState: (partial) => set(partial),
  resetError: () => set({ error: null })
}), {
  name: 'llm-chat-state',
  partialize: (s) => ({
    conversationId: s.conversationId,
    activeBranchId: s.activeBranchId,
    selectedPersonalityId: s.selectedPersonalityId,
    selectedModelKey: s.selectedModelKey,
    activeSchemaId: s.activeSchemaId
  })
}));
