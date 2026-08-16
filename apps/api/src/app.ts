import Fastify from 'fastify';

import type {
  AccountCoverageState,
  ApiProblem,
  CsvImportRequest,
  HealthResponse,
  WorkspaceCommandRequest,
} from '@serein/contracts';

import {
  createAuth0AccessTokenVerifier,
  getAuth0AccessTokenConfig,
  type AccessTokenVerifier,
  type AuthenticatedIdentity,
} from './auth.js';
import { ConvexWorkspaceStore, getConvexUrl } from './convex-workspace-store.js';
import { ConvexFinanceImportStore, type FinanceImportStore } from './finance-import-store.js';
import {
  IdempotencyKeyConflictError,
  WorkspaceAlreadyInitializedError,
  WorkspaceVersionConflictError,
  type WorkspaceStore,
} from './workspace-store.js';

const API_VERSION = 'v1' as const;

export interface BuildAppOptions {
  accessTokenVerifier?: AccessTokenVerifier;
  financeImportStore?: FinanceImportStore;
  workspaceStore?: WorkspaceStore;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const convexUrl = getConvexUrl();
  const workspaceStore =
    options.workspaceStore ?? (convexUrl ? new ConvexWorkspaceStore(convexUrl) : undefined);
  const financeImportStore =
    options.financeImportStore ?? (convexUrl ? new ConvexFinanceImportStore(convexUrl) : undefined);
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
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);

    if (!authenticatedRequest) {
      return;
    }

    if (!requireScope(authenticatedRequest.identity, 'read:workspace', reply)) {
      return;
    }

    if (!workspaceStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }

    return workspaceStore.getProjection(
      authenticatedRequest.identity.subject,
      authenticatedRequest.accessToken,
    );
  });

  app.post('/v1/workspace/commands', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);

    if (!authenticatedRequest) {
      return;
    }

    if (!requireScope(authenticatedRequest.identity, 'write:workspace', reply)) {
      return;
    }

    const command = parseWorkspaceCommand(request.body);

    if (!command) {
      return reply
        .code(400)
        .send(problem('invalid_command', 'Provide a valid versioned workspace command.'));
    }

    if (!workspaceStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }

    try {
      const result = await workspaceStore.execute(
        authenticatedRequest.identity.subject,
        command,
        authenticatedRequest.accessToken,
      );
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

  app.get('/v1/imports/coverage', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'read:workspace', reply)
    ) {
      return;
    }
    if (!financeImportStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }
    return financeImportStore.getAllowanceCoverage(
      authenticatedRequest.identity.subject,
      authenticatedRequest.accessToken,
    );
  });

  app.post('/v1/imports/csv', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    ) {
      return;
    }
    const importRequest = parseCsvImport(request.body);
    if (!importRequest) {
      return reply
        .code(400)
        .send(problem('invalid_import_request', 'Provide a valid CSV import request.'));
    }
    if (!financeImportStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }
    try {
      const result = await financeImportStore.importCsv(
        authenticatedRequest.identity.subject,
        importRequest,
        authenticatedRequest.accessToken,
      );
      return reply.code(result.outcome === 'applied' ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) {
        return reply.code(409).send(problem('idempotency_key_conflict', error.message));
      }
      throw error;
    }
  });

  app.post('/v1/accounts/manual', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    ) {
      return;
    }
    const account = parseAccount(request.body);
    if (!account) {
      return reply.code(400).send(problem('invalid_account', 'Provide a valid manual account.'));
    }
    if (!financeImportStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }
    return reply
      .code(201)
      .send(
        await financeImportStore.upsertManualAccount(
          authenticatedRequest.identity.subject,
          account,
          authenticatedRequest.accessToken,
        ),
      );
  });

  app.post('/v1/accounts/coverage', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    ) {
      return;
    }
    const account = parseCoverageAccount(request.body);
    if (!account) {
      return reply
        .code(400)
        .send(problem('invalid_account_coverage', 'Provide a valid account coverage state.'));
    }
    if (!financeImportStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }
    return financeImportStore.setAccountCoverageState(
      authenticatedRequest.identity.subject,
      account,
      authenticatedRequest.accessToken,
    );
  });

  async function authenticate(
    authorization: string | undefined,
    reply: { code(statusCode: number): { send(payload: ApiProblem): unknown } },
  ): Promise<{ accessToken: string; identity: AuthenticatedIdentity } | undefined> {
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
      return { accessToken, identity: await accessTokenVerifier.verify(accessToken) };
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

function parseCsvImport(body: unknown): CsvImportRequest | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const { accountExternalId, accountName, csv, idempotencyKey } = body;
  if (
    !isValidAccountFields(body) ||
    typeof accountExternalId !== 'string' ||
    typeof accountName !== 'string' ||
    typeof csv !== 'string' ||
    csv.length === 0 ||
    typeof idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
  ) {
    return undefined;
  }
  if (body.mapping === undefined) {
    return { accountExternalId, accountName, csv, idempotencyKey };
  }
  if (!isRecord(body.mapping) || Object.keys(body.mapping).length !== 3) {
    return undefined;
  }
  const { amountColumn, dateColumn, descriptionColumn } = body.mapping;
  if (
    typeof amountColumn !== 'string' ||
    typeof dateColumn !== 'string' ||
    typeof descriptionColumn !== 'string'
  ) {
    return undefined;
  }
  return {
    accountExternalId,
    accountName,
    csv,
    idempotencyKey,
    mapping: { amountColumn, dateColumn, descriptionColumn },
  };
}

function parseAccount(
  body: unknown,
): { accountExternalId: string; accountName: string } | undefined {
  if (!isRecord(body) || !isValidAccountFields(body) || Object.keys(body).length !== 2) {
    return undefined;
  }
  return {
    accountExternalId: body.accountExternalId as string,
    accountName: body.accountName as string,
  };
}

function parseCoverageAccount(body: unknown):
  | {
      accountExternalId: string;
      accountName: string;
      state: Exclude<AccountCoverageState, 'imported'>;
    }
  | undefined {
  if (!isRecord(body) || !isValidAccountFields(body) || Object.keys(body).length !== 3) {
    return undefined;
  }
  if (body.state !== 'manual' && body.state !== 'excluded' && body.state !== 'missing') {
    return undefined;
  }
  return {
    accountExternalId: body.accountExternalId as string,
    accountName: body.accountName as string,
    state: body.state,
  };
}

function isValidAccountFields(body: Record<string, unknown>): boolean {
  return (
    typeof body.accountExternalId === 'string' &&
    body.accountExternalId.trim().length > 0 &&
    body.accountExternalId.length <= 128 &&
    typeof body.accountName === 'string' &&
    body.accountName.trim().length > 0 &&
    body.accountName.length <= 256
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problem(code: string, detail: string, meta?: Record<string, string | number>): ApiProblem {
  return { error: { code, detail, ...(meta ? { meta } : {}) } };
}
