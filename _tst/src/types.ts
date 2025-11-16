export type ID = string;

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageMeta {
  cost?: number;
  tokens?: number;
  durationSec?: number;
  rating?: number;
  is_pinned?: boolean;
  priority_level?: 0 | 1 | 2 | 3 | 4;
}

export interface Message {
  id: ID;
  role: MessageRole;
  content: string;
  created_at: string;
  metadata?: MessageMeta;
}

export interface Branch {
  id: ID;
  conversation_id: ID;
  parent_branch_id?: ID | null;
  branch_point_message_id?: ID | null;
  name: string;
  description?: string;
  stats?: { message_count: number; token_count: number; updated_at?: string };
}

export interface GoalCriterion { text: string; checked: boolean; }
export interface Goal {
  id: ID;
  conversation_id: ID;
  goal_text: string;
  goal_type: string;
  success_criteria: GoalCriterion[];
  constraints: string[];
  progress: number; // 0 - 100
}

export interface Personality {
  id: number;
  name: string;
  description?: string;
}

export interface SchemaDef {
  id: number;
  name: string;
  description?: string;
  category?: string;
  usage_count?: number;
  schema_definition: unknown;
}

export interface SmartAction {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category: 'Content' | 'Code' | 'Analysis' | 'Workflow' | string;
  prompt_template: string;
  usage_count?: number;
}

export type Suggestion = {
  title: string;
  prompt: string;
  rationale?: string;
  estimated_exchanges?: number;
  path_type?: 'direct' | 'thorough' | 'alternative' | 'validate' | string;
};
