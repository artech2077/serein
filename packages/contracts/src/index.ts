export const API_VERSION = 'v1' as const;

export interface HealthResponse {
  service: 'serein-api';
  version: typeof API_VERSION;
  status: 'ok';
}

export interface WorkspaceProjection {
  initialized: boolean;
  version: number;
  workspaceId: string;
}

export interface WorkspaceInitializeCommand {
  type: 'workspace.initialize';
}

export interface WorkspaceCommandRequest {
  command: WorkspaceInitializeCommand;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface WorkspaceCommandResponse {
  outcome: 'applied' | 'replayed';
  projection: WorkspaceProjection;
}

export interface ApiProblem {
  error: {
    code: string;
    detail: string;
    meta?: Record<string, string | number>;
  };
}
