export type Profile = {
  repo_root: string;
  ignore_globs_effective: string[];
  languages: string[];
  counts: Record<string, number>;
  services: Array<{
    name: string;
    root: string;
    entrypoints: string[];
    frameworks: string[];
    http_base_prefixes: string[];
    routes_index_hint: Record<string, string[]>;
    artifacts: { openapi: string[]; graphql: string[]; grpc_protos: string[] };
    javascript?: {
      tsconfig?: string | null;
      paths?: Record<string, string[]>;
    };
  }>;
};

export type Edges = Record<string, Set<string>>;
