import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

import type {
  WorkspaceCommandRequest,
  WorkspaceCommandResponse,
  WorkspaceProjection,
} from '@serein/contracts';

import {
  IdempotencyKeyConflictError,
  WorkspaceAlreadyInitializedError,
  WorkspaceVersionConflictError,
  type WorkspaceStore,
} from './workspace-store.js';

type ConvexCommandResult =
  | {
      outcome: 'applied' | 'replayed';
      projection: WorkspaceProjection;
      type: 'success';
    }
  | {
      actualVersion: number;
      expectedVersion: number;
      type: 'version_conflict';
    }
  | { type: 'idempotency_key_conflict' }
  | { type: 'workspace_already_initialized' };

type ConvexWorkspaceCommand = {
  command: { type: 'workspace.initialize' };
  expectedVersion: number;
  idempotencyKey: string;
};

const getWorkspace = makeFunctionReference<'query', Record<string, never>, WorkspaceProjection>(
  'workspaces:get',
);
const initializeWorkspace = makeFunctionReference<
  'mutation',
  ConvexWorkspaceCommand,
  ConvexCommandResult
>('workspaces:initialize');

export class ConvexWorkspaceStore implements WorkspaceStore {
  constructor(private readonly convexUrl: string) {}

  async execute(
    _subject: string,
    request: WorkspaceCommandRequest,
    accessToken: string,
  ): Promise<WorkspaceCommandResponse> {
    const result = await this.client(accessToken).mutation(initializeWorkspace, request);

    if (result.type === 'success') {
      return { outcome: result.outcome, projection: result.projection };
    }

    if (result.type === 'version_conflict') {
      throw new WorkspaceVersionConflictError(result.actualVersion, result.expectedVersion);
    }

    if (result.type === 'idempotency_key_conflict') {
      throw new IdempotencyKeyConflictError(request.idempotencyKey);
    }

    throw new WorkspaceAlreadyInitializedError();
  }

  getProjection(_subject: string, accessToken: string): Promise<WorkspaceProjection> {
    return this.client(accessToken).query(getWorkspace, {});
  }

  private client(accessToken: string): ConvexHttpClient {
    return new ConvexHttpClient(this.convexUrl, { auth: accessToken, logger: false });
  }
}

export function getConvexUrl(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = environment.CONVEX_URL?.trim();
  return url || undefined;
}
