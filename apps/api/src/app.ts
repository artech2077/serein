import Fastify from 'fastify';

import type { ApiProblem, HealthResponse, WorkspaceCommandRequest } from '@serein/contracts';

import {
  createAuth0AccessTokenVerifier,
  getAuth0AccessTokenConfig,
  type AccessTokenVerifier,
  type AuthenticatedIdentity,
} from './auth.js';
import {
  IdempotencyKeyConflictError,
  InMemoryWorkspaceStore,
  WorkspaceAlreadyInitializedError,
  WorkspaceVersionConflictError,
  type WorkspaceStore,
} from './workspace-store.js';

const API_VERSION = 'v1' as const;

export interface BuildAppOptions {
  accessTokenVerifier?: AccessTokenVerifier;
  workspaceStore?: WorkspaceStore;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const workspaceStore = options.workspaceStore ?? new InMemoryWorkspaceStore();
  const accessTokenVerifier =
    options.accessTokenVerifier ??
    (() => {
      const config = getAuth0AccessTokenConfig();
      return config ? createAuth0AccessTokenVerifier(config) : undefined;
    })();

  app.get('/health', async (): Promise<HealthResponse> => ({
    service: 'serein-api',
    status: 'ok',
    version: API_VERSION,
  }));

  app.get('/v1/workspace', async (request, reply) => {
    const identity = await authenticate(request.headers.authorization, reply);

    if (!identity) {
      return;
    }

    if (!requireScope(identity, 'read:workspace', reply)) {
      return;
    }

    return workspaceStore.getProjection(identity.subject);
  });

  app.post('/v1/workspace/commands', async (request, reply) => {
    const identity = await authenticate(request.headers.authorization, reply);

    if (!identity) {
      return;
    }

    if (!requireScope(identity, 'write:workspace', reply)) {
      return;
    }

    const command = parseWorkspaceCommand(request.body);

    if (!command) {
      return reply
        .code(400)
        .send(problem('invalid_command', 'Provide a valid versioned workspace command.'));
    }

    try {
      const result = workspaceStore.execute(identity.subject, command);
      return reply.code(result.outcome === 'applied' ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof WorkspaceVersionConflictError) {
        return reply.code(409).send(
          problem('workspace_version_conflict', error.message, {
            actualVersion: error.actualVersion,
            expectedVersion: error.expectedVersion,
          }),
        );
      }

      if (error instanceof IdempotencyKeyConflictError) {
        return reply.code(409).send(problem('idempotency_key_conflict', error.message));
      }

      if (error instanceof WorkspaceAlreadyInitializedError) {
        return reply.code(409).send(problem('workspace_already_initialized', error.message));
      }

      throw error;
    }
  });

  async function authenticate(
    authorization: string | undefined,
    reply: { code(statusCode: number): { send(payload: ApiProblem): unknown } },
  ): Promise<AuthenticatedIdentity | undefined> {
    const accessToken = getBearerToken(authorization);

    if (!accessToken) {
      reply.code(401).send(problem('authentication_required', 'Provide a Bearer access token.'));
      return undefined;
    }

    if (!accessTokenVerifier) {
      reply
        .code(503)
        .send(problem('authentication_not_configured', 'Configure Auth0 access-token validation.'));
      return undefined;
    }

    try {
      return await accessTokenVerifier.verify(accessToken);
    } catch {
      reply.code(401).send(problem('invalid_access_token', 'The Bearer access token is invalid.'));
      return undefined;
    }
  }

  function requireScope(
    identity: AuthenticatedIdentity,
    scope: string,
    reply: { code(statusCode: number): { send(payload: ApiProblem): unknown } },
  ): boolean {
    if (identity.scopes.has(scope)) {
      return true;
    }

    reply
      .code(403)
      .send(problem('insufficient_scope', `The access token requires the ${scope} scope.`));
    return false;
  }

  return app;
}

function getBearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function parseWorkspaceCommand(body: unknown): WorkspaceCommandRequest | undefined {
  if (!isRecord(body) || !isRecord(body.command)) {
    return undefined;
  }

  const expectedVersion = body.expectedVersion;

  if (
    typeof body.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(body.idempotencyKey) ||
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    body.command.type !== 'workspace.initialize' ||
    Object.keys(body.command).length !== 1
  ) {
    return undefined;
  }

  return {
    command: { type: 'workspace.initialize' },
    expectedVersion,
    idempotencyKey: body.idempotencyKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problem(code: string, detail: string, meta?: Record<string, string | number>): ApiProblem {
  return { error: { code, detail, ...(meta ? { meta } : {}) } };
}
