import Fastify from 'fastify';

import type {
  AccountCoverageState,
  ApiProblem,
  ConfirmedTransactionClassification,
  CsvImportRequest,
  DeferredCardPurchaseRequest,
  DeferredCardSettlementRequest,
  HealthResponse,
  QuickAddRequest,
  WorkspaceCommandRequest,
} from '@serein/contracts';

import {
  createAuth0AccessTokenVerifier,
  getAuth0AccessTokenConfig,
  type AccessTokenVerifier,
  type AuthenticatedIdentity,
} from './auth.js';
import { ConvexWorkspaceStore, getConvexUrl } from './convex-workspace-store.js';
import { ConvexDeferredCardStore, type DeferredCardStore } from './deferred-card-store.js';
import {
  ConvexFinanceClassificationStore,
  type FinanceClassificationStore,
} from './finance-classification-store.js';
import { ConvexFinanceImportStore, type FinanceImportStore } from './finance-import-store.js';
import { ConvexQuickAddStore, type QuickAddStore } from './quick-add-store.js';
import {
  IdempotencyKeyConflictError,
  WorkspaceAlreadyInitializedError,
  WorkspaceVersionConflictError,
  type WorkspaceStore,
} from './workspace-store.js';

const API_VERSION = 'v1' as const;

export interface BuildAppOptions {
  accessTokenVerifier?: AccessTokenVerifier;
  deferredCardStore?: DeferredCardStore;
  financeClassificationStore?: FinanceClassificationStore;
  financeImportStore?: FinanceImportStore;
  quickAddStore?: QuickAddStore;
  workspaceStore?: WorkspaceStore;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const convexUrl = getConvexUrl();
  const workspaceStore =
    options.workspaceStore ?? (convexUrl ? new ConvexWorkspaceStore(convexUrl) : undefined);
  const deferredCardStore =
    options.deferredCardStore ?? (convexUrl ? new ConvexDeferredCardStore(convexUrl) : undefined);
  const financeImportStore =
    options.financeImportStore ?? (convexUrl ? new ConvexFinanceImportStore(convexUrl) : undefined);
  const financeClassificationStore =
    options.financeClassificationStore ??
    (convexUrl ? new ConvexFinanceClassificationStore(convexUrl) : undefined);
  const quickAddStore =
    options.quickAddStore ?? (convexUrl ? new ConvexQuickAddStore(convexUrl) : undefined);
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

  app.get('/v1/transactions/review', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'read:workspace', reply)
    ) {
      return;
    }
    if (!financeClassificationStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }
    return financeClassificationStore.getMaterialReviewQueue(
      authenticatedRequest.identity.subject,
      authenticatedRequest.accessToken,
    );
  });

  app.post('/v1/transactions/:transactionId/classification', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    ) {
      return;
    }
    const classification = parseClassification(request.body);
    const transactionId = parseRouteId(request.params);
    if (!classification || !transactionId) {
      return reply
        .code(400)
        .send(problem('invalid_classification', 'Provide a valid transaction classification.'));
    }
    if (!financeClassificationStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }
    return financeClassificationStore.confirmClassification(
      authenticatedRequest.identity.subject,
      { classification, transactionId },
      authenticatedRequest.accessToken,
    );
  });

  app.post('/v1/transactions/:transactionId/merchant-correction', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    ) {
      return;
    }
    const transactionId = parseRouteId(request.params);
    const correction = parseMerchantCorrection(request.body);
    if (!transactionId || !correction) {
      return reply
        .code(400)
        .send(problem('invalid_merchant_correction', 'Provide a valid merchant correction.'));
    }
    if (!financeClassificationStore) {
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    }
    return financeClassificationStore.correctMerchant(
      authenticatedRequest.identity.subject,
      { ...correction, transactionId },
      authenticatedRequest.accessToken,
    );
  });

  app.post('/v1/quick-adds/preview', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'read:workspace', reply)
    )
      return;
    const quickAdd = parseQuickAdd(request.body, false);
    if (!quickAdd)
      return reply
        .code(400)
        .send(problem('invalid_quick_add', 'Provide a valid Quick Add preview.'));
    if (!quickAddStore)
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    return quickAddStore.preview(
      authenticatedRequest.identity.subject,
      quickAdd,
      authenticatedRequest.accessToken,
    );
  });

  app.post('/v1/quick-adds', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    )
      return;
    const quickAdd = parseQuickAdd(request.body, true);
    if (!quickAdd)
      return reply.code(400).send(problem('invalid_quick_add', 'Provide a valid Quick Add.'));
    if (!quickAddStore)
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    try {
      const result = await quickAddStore.create(
        authenticatedRequest.identity.subject,
        quickAdd,
        authenticatedRequest.accessToken,
      );
      return reply.code(result.outcome === 'applied' ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError)
        return reply.code(409).send(problem('idempotency_key_conflict', error.message));
      throw error;
    }
  });

  app.get('/v1/quick-adds', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'read:workspace', reply)
    )
      return;
    if (!quickAddStore)
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    return quickAddStore.getPending(
      authenticatedRequest.identity.subject,
      authenticatedRequest.accessToken,
    );
  });

  app.get('/v1/deferred-cards/summary', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'read:workspace', reply)
    )
      return;
    if (!deferredCardStore)
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    return deferredCardStore.getSummary(
      authenticatedRequest.identity.subject,
      authenticatedRequest.accessToken,
    );
  });

  app.post('/v1/deferred-card-purchases', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    )
      return;
    const purchase = parseDeferredCardPurchase(request.body);
    if (!purchase)
      return reply
        .code(400)
        .send(problem('invalid_deferred_card_purchase', 'Provide a valid deferred-card purchase.'));
    if (!deferredCardStore)
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    try {
      const result = await deferredCardStore.recordPurchase(
        authenticatedRequest.identity.subject,
        purchase,
        authenticatedRequest.accessToken,
      );
      return reply.code(result.outcome === 'applied' ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError)
        return reply.code(409).send(problem('idempotency_key_conflict', error.message));
      throw error;
    }
  });

  app.post('/v1/deferred-card-settlements', async (request, reply) => {
    const authenticatedRequest = await authenticate(request.headers.authorization, reply);
    if (
      !authenticatedRequest ||
      !requireScope(authenticatedRequest.identity, 'write:workspace', reply)
    )
      return;
    const settlement = parseDeferredCardSettlement(request.body);
    if (!settlement)
      return reply
        .code(400)
        .send(
          problem('invalid_deferred_card_settlement', 'Provide a valid deferred-card settlement.'),
        );
    if (!deferredCardStore)
      return reply
        .code(503)
        .send(problem('workspace_not_configured', 'Configure the Convex workspace store.'));
    try {
      const result = await deferredCardStore.recordSettlement(
        authenticatedRequest.identity.subject,
        settlement,
        authenticatedRequest.accessToken,
      );
      return reply.code(result.outcome === 'applied' ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError)
        return reply.code(409).send(problem('idempotency_key_conflict', error.message));
      throw error;
    }
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

function parseClassification(body: unknown): ConfirmedTransactionClassification | undefined {
  if (!isRecord(body) || Object.keys(body).length !== 1) {
    return undefined;
  }
  return isConfirmedClassification(body.classification) ? body.classification : undefined;
}

function parseMerchantCorrection(body: unknown):
  | {
      classification: ConfirmedTransactionClassification;
      scope: 'one_time' | 'retrospective' | 'prospective';
    }
  | undefined {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 2 ||
    !isConfirmedClassification(body.classification)
  ) {
    return undefined;
  }
  if (body.scope !== 'one_time' && body.scope !== 'retrospective' && body.scope !== 'prospective') {
    return undefined;
  }
  return { classification: body.classification, scope: body.scope };
}

function isConfirmedClassification(value: unknown): value is ConfirmedTransactionClassification {
  return (
    value === 'discretionary' || value === 'essential' || value === 'transfer' || value === 'refund'
  );
}

function parseRouteId(params: unknown): string | undefined {
  if (
    !isRecord(params) ||
    typeof params.transactionId !== 'string' ||
    params.transactionId.length === 0
  ) {
    return undefined;
  }
  return params.transactionId;
}

function parseDeferredCardPurchase(body: unknown): DeferredCardPurchaseRequest | undefined {
  if (!isRecord(body) || Object.keys(body).length !== 9) return undefined;
  const value = body as Record<string, unknown>;
  if (
    !validPositiveCents(value.amountCents) ||
    !validText(value.cardExternalId) ||
    !validDate(value.expectedSettlementEnd) ||
    !validDate(value.expectedSettlementStart) ||
    !validIdempotencyKey(value.idempotencyKey) ||
    !validDate(value.purchaseDate) ||
    !validText(value.purchaseExternalId) ||
    !validText(value.settlementAccountExternalId) ||
    !validText(value.sourceDescription) ||
    value.expectedSettlementStart > value.expectedSettlementEnd
  )
    return undefined;
  return value as unknown as DeferredCardPurchaseRequest;
}

function parseDeferredCardSettlement(body: unknown): DeferredCardSettlementRequest | undefined {
  if (!isRecord(body) || Object.keys(body).length !== 8) return undefined;
  const value = body as Record<string, unknown>;
  if (
    !validPositiveCents(value.amountCents) ||
    !validText(value.cardExternalId) ||
    !validIdempotencyKey(value.idempotencyKey) ||
    !validText(value.settlementAccountExternalId) ||
    !validDate(value.settlementDate) ||
    !validText(value.settlementExternalId) ||
    !validText(value.sourceDescription) ||
    !Array.isArray(value.allocations) ||
    value.allocations.some(
      (allocation) =>
        !isRecord(allocation) ||
        Object.keys(allocation).length !== 2 ||
        !validPositiveCents(allocation.amountCents) ||
        !validText(allocation.purchaseExternalId),
    ) ||
    new Set(
      value.allocations.map(
        (allocation) => (allocation as Record<string, unknown>).purchaseExternalId,
      ),
    ).size !== value.allocations.length
  )
    return undefined;
  return value as unknown as DeferredCardSettlementRequest;
}

function validPositiveCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function parseQuickAdd(body: unknown, includeCreationFields: true): QuickAddRequest | undefined;
function parseQuickAdd(
  body: unknown,
  includeCreationFields: false,
): Pick<QuickAddRequest, 'amountCents' | 'bookingDate' | 'sourceDescription'> | undefined;
function parseQuickAdd(body: unknown, includeCreationFields: boolean) {
  if (!isRecord(body)) return undefined;
  const expectedKeys = includeCreationFields ? 5 : 3;
  if (
    Object.keys(body).length !== expectedKeys ||
    typeof body.amountCents !== 'number' ||
    !Number.isSafeInteger(body.amountCents) ||
    body.amountCents <= 0 ||
    typeof body.bookingDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(body.bookingDate) ||
    typeof body.sourceDescription !== 'string' ||
    body.sourceDescription.trim().length === 0
  )
    return undefined;
  if (!includeCreationFields)
    return {
      amountCents: body.amountCents,
      bookingDate: body.bookingDate,
      sourceDescription: body.sourceDescription,
    };
  if (
    typeof body.accountExternalId !== 'string' ||
    body.accountExternalId.trim().length === 0 ||
    typeof body.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(body.idempotencyKey)
  )
    return undefined;
  return {
    accountExternalId: body.accountExternalId,
    amountCents: body.amountCents,
    bookingDate: body.bookingDate,
    idempotencyKey: body.idempotencyKey,
    sourceDescription: body.sourceDescription,
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
