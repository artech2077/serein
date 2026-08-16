import { createHash } from 'node:crypto';

import type {
  WorkspaceCommandRequest,
  WorkspaceCommandResponse,
  WorkspaceProjection,
} from '@serein/contracts';

export class IdempotencyKeyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`The idempotency key ${idempotencyKey} was already used for a different command.`);
  }
}

export class WorkspaceAlreadyInitializedError extends Error {
  constructor() {
    super('The finance workspace has already been initialized.');
  }
}

export class WorkspaceVersionConflictError extends Error {
  constructor(
    readonly actualVersion: number,
    readonly expectedVersion: number,
  ) {
    super(`Expected workspace version ${expectedVersion}, but found ${actualVersion}.`);
  }
}

export interface WorkspaceStore {
  execute(
    subject: string,
    request: WorkspaceCommandRequest,
    accessToken?: string,
  ): WorkspaceCommandResponse | Promise<WorkspaceCommandResponse>;
  getProjection(
    subject: string,
    accessToken?: string,
  ): WorkspaceProjection | Promise<WorkspaceProjection>;
}

interface AppliedCommand {
  fingerprint: string;
  response: WorkspaceCommandResponse;
}

interface StoredWorkspace {
  commands: Map<string, AppliedCommand>;
  initialized: boolean;
  version: number;
  workspaceId: string;
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, StoredWorkspace>();

  execute(subject: string, request: WorkspaceCommandRequest): WorkspaceCommandResponse {
    const workspace = this.getWorkspace(subject);
    const fingerprint = JSON.stringify({
      command: request.command,
      expectedVersion: request.expectedVersion,
    });
    const appliedCommand = workspace.commands.get(request.idempotencyKey);

    if (appliedCommand) {
      if (appliedCommand.fingerprint !== fingerprint) {
        throw new IdempotencyKeyConflictError(request.idempotencyKey);
      }

      return { ...appliedCommand.response, outcome: 'replayed' };
    }

    if (workspace.version !== request.expectedVersion) {
      throw new WorkspaceVersionConflictError(workspace.version, request.expectedVersion);
    }

    if (workspace.initialized) {
      throw new WorkspaceAlreadyInitializedError();
    }

    workspace.initialized = true;
    workspace.version += 1;

    const response: WorkspaceCommandResponse = {
      outcome: 'applied',
      projection: this.toProjection(workspace),
    };

    workspace.commands.set(request.idempotencyKey, { fingerprint, response });

    return response;
  }

  getProjection(subject: string): WorkspaceProjection {
    return this.toProjection(this.getWorkspace(subject));
  }

  private getWorkspace(subject: string): StoredWorkspace {
    const existing = this.workspaces.get(subject);

    if (existing) {
      return existing;
    }

    const workspace: StoredWorkspace = {
      commands: new Map(),
      initialized: false,
      version: 0,
      workspaceId: `workspace_${createHash('sha256')
        .update(subject)
        .digest('base64url')
        .slice(0, 22)}`,
    };
    this.workspaces.set(subject, workspace);

    return workspace;
  }

  private toProjection(workspace: StoredWorkspace): WorkspaceProjection {
    return {
      initialized: workspace.initialized,
      version: workspace.version,
      workspaceId: workspace.workspaceId,
    };
  }
}
