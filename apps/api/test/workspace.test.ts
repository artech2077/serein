import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenVerifier } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import type { FinanceImportStore } from '../src/finance-import-store.js';
import type { QuickAddStore } from '../src/quick-add-store.js';
import { InMemoryWorkspaceStore } from '../src/workspace-store.js';

const readToken = 'read-token';
const writeToken = 'write-token';
const fullToken = 'full-token';
const secondUserToken = 'second-user-token';

function buildTestApp(
  options: { financeImportStore?: FinanceImportStore; quickAddStore?: QuickAddStore } = {},
) {
  const accessTokenVerifier: AccessTokenVerifier = {
    verify: vi.fn(async (token) => {
      const identities = {
        [fullToken]: {
          scopes: new Set(['read:workspace', 'write:workspace']),
          subject: 'auth0|primary-user',
        },
        [readToken]: {
          scopes: new Set(['read:workspace']),
          subject: 'auth0|primary-user',
        },
        [secondUserToken]: {
          scopes: new Set(['read:workspace', 'write:workspace']),
          subject: 'auth0|second-user',
        },
        [writeToken]: {
          scopes: new Set(['write:workspace']),
          subject: 'auth0|primary-user',
        },
      } as const;
      const identity = identities[token as keyof typeof identities];

      if (!identity) {
        throw new Error('Unknown token');
      }

      return identity;
    }),
  };

  return buildApp({
    accessTokenVerifier,
    financeImportStore: options.financeImportStore,
    quickAddStore: options.quickAddStore,
    workspaceStore: new InMemoryWorkspaceStore(),
  });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('workspace authorization boundary', () => {
  const apps: ReturnType<typeof buildTestApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('rejects unauthenticated and insufficiently scoped reads and commands', async () => {
    const app = buildTestApp();
    apps.push(app);

    const unauthenticatedRead = await app.inject({ method: 'GET', url: '/v1/workspace' });
    const invalidTokenRead = await app.inject({
      headers: bearer('invalid-token'),
      method: 'GET',
      url: '/v1/workspace',
    });
    const writeOnlyRead = await app.inject({
      headers: bearer(writeToken),
      method: 'GET',
      url: '/v1/workspace',
    });
    const readOnlyCommand = await app.inject({
      headers: bearer(readToken),
      method: 'POST',
      payload: initializeCommand('initialize-read-only'),
      url: '/v1/workspace/commands',
    });

    expect(unauthenticatedRead.statusCode).toBe(401);
    expect(unauthenticatedRead.json()).toMatchObject({
      error: { code: 'authentication_required' },
    });
    expect(invalidTokenRead.statusCode).toBe(401);
    expect(invalidTokenRead.json()).toMatchObject({ error: { code: 'invalid_access_token' } });
    expect(writeOnlyRead.statusCode).toBe(403);
    expect(writeOnlyRead.json()).toMatchObject({ error: { code: 'insufficient_scope' } });
    expect(readOnlyCommand.statusCode).toBe(403);
    expect(readOnlyCommand.json()).toMatchObject({ error: { code: 'insufficient_scope' } });
  });

  it('does not fall back to volatile in-memory storage outside tests', async () => {
    const accessTokenVerifier: AccessTokenVerifier = {
      verify: vi.fn(async () => ({
        scopes: new Set(['read:workspace']),
        subject: 'auth0|primary-user',
      })),
    };
    const app = buildApp({ accessTokenVerifier });
    apps.push(app);

    const response = await app.inject({
      headers: bearer(fullToken),
      method: 'GET',
      url: '/v1/workspace',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'workspace_not_configured' } });
  });

  it('keeps finance workspaces private to the validated Auth0 subject', async () => {
    const app = buildTestApp();
    apps.push(app);

    const initialized = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: initializeCommand('initialize-primary'),
      url: '/v1/workspace/commands',
    });
    const primaryProjection = await app.inject({
      headers: bearer(fullToken),
      method: 'GET',
      url: '/v1/workspace',
    });
    const secondProjection = await app.inject({
      headers: bearer(secondUserToken),
      method: 'GET',
      url: '/v1/workspace',
    });

    expect(initialized.statusCode).toBe(201);
    expect(primaryProjection.json()).toMatchObject({ initialized: true, version: 1 });
    expect(secondProjection.json()).toMatchObject({ initialized: false, version: 0 });
    expect(secondProjection.json().workspaceId).not.toBe(primaryProjection.json().workspaceId);
  });

  it('replays matching retries and returns reviewable version and idempotency conflicts', async () => {
    const app = buildTestApp();
    apps.push(app);
    const command = initializeCommand('initialize-primary');

    const applied = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: command,
      url: '/v1/workspace/commands',
    });
    const replayed = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: command,
      url: '/v1/workspace/commands',
    });
    const staleVersion = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: initializeCommand('initialize-after-stale-version'),
      url: '/v1/workspace/commands',
    });
    const reusedKey = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: { ...command, expectedVersion: 1 },
      url: '/v1/workspace/commands',
    });

    expect(applied.statusCode).toBe(201);
    expect(applied.json()).toMatchObject({ outcome: 'applied', projection: { version: 1 } });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ outcome: 'replayed', projection: { version: 1 } });
    expect(staleVersion.statusCode).toBe(409);
    expect(staleVersion.json()).toEqual({
      error: {
        code: 'workspace_version_conflict',
        detail: 'Expected workspace version 0, but found 1.',
        meta: { actualVersion: 1, expectedVersion: 0 },
      },
    });
    expect(reusedKey.statusCode).toBe(409);
    expect(reusedKey.json()).toMatchObject({ error: { code: 'idempotency_key_conflict' } });
  });

  it('routes authenticated CSV imports and coverage through the backend import store', async () => {
    const financeImportStore: FinanceImportStore = {
      getAllowanceCoverage: vi.fn(async () => ({
        accounts: [],
        allowanceQualified: true,
        missingAccountExternalIds: [],
      })),
      importCsv: vi.fn(async () => ({
        accountId: 'account_123',
        importedTransactionCount: 1,
        outcome: 'applied',
        skippedDuplicateTransactionCount: 0,
        sourceAsOf: '2026-08-16',
      })),
      setAccountCoverageState: vi.fn(async (_subject, request) => ({
        accountExternalId: request.accountExternalId,
        state: request.state,
      })),
      upsertManualAccount: vi.fn(async (_subject, request) => ({
        accountExternalId: request.accountExternalId,
        state: 'manual',
      })),
    };
    const app = buildTestApp({ financeImportStore });
    apps.push(app);

    const imported = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: {
        accountExternalId: 'checking',
        accountName: 'Checking',
        csv: 'Date,Description,Amount\\n2026-08-16,Coffee,-3.50',
        idempotencyKey: 'import-1',
        mapping: { amountColumn: 'Amount', dateColumn: 'Date', descriptionColumn: 'Description' },
      },
      url: '/v1/imports/csv',
    });
    const coverage = await app.inject({
      headers: bearer(readToken),
      method: 'GET',
      url: '/v1/imports/coverage',
    });
    const manual = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: { accountExternalId: 'cash', accountName: 'Cash' },
      url: '/v1/accounts/manual',
    });
    const missing = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: { accountExternalId: 'savings', accountName: 'Savings', state: 'missing' },
      url: '/v1/accounts/coverage',
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ importedTransactionCount: 1, outcome: 'applied' });
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json()).toEqual({
      accounts: [],
      allowanceQualified: true,
      missingAccountExternalIds: [],
    });
    expect(manual.statusCode).toBe(201);
    expect(missing.statusCode).toBe(200);
    expect(financeImportStore.importCsv).toHaveBeenCalledWith(
      'auth0|primary-user',
      expect.objectContaining({ accountExternalId: 'checking', idempotencyKey: 'import-1' }),
      fullToken,
    );
  });

  it('routes authenticated Quick Add previews, creation, and pending items through the backend store', async () => {
    const quickAddStore: QuickAddStore = {
      create: vi.fn(async () => ({ outcome: 'applied', quickAddId: 'quick-add_123' })),
      getPending: vi.fn(async () => [
        {
          amountCents: 450,
          bookingDate: '2026-08-21',
          quickAddId: 'quick-add_123',
          sourceDescription: 'Corner Cafe',
          state: 'provisional',
        },
      ]),
      preview: vi.fn(async () => ({ allowanceImpactCents: -450 })),
    };
    const app = buildTestApp({ quickAddStore });
    apps.push(app);
    const previewPayload = {
      amountCents: 450,
      bookingDate: '2026-08-21',
      sourceDescription: 'Corner Cafe',
    };

    const preview = await app.inject({
      headers: bearer(readToken),
      method: 'POST',
      payload: previewPayload,
      url: '/v1/quick-adds/preview',
    });
    const created = await app.inject({
      headers: bearer(fullToken),
      method: 'POST',
      payload: { ...previewPayload, accountExternalId: 'checking', idempotencyKey: 'coffee-now' },
      url: '/v1/quick-adds',
    });
    const pending = await app.inject({
      headers: bearer(readToken),
      method: 'GET',
      url: '/v1/quick-adds',
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ allowanceImpactCents: -450 });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ outcome: 'applied', quickAddId: 'quick-add_123' });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toHaveLength(1);
    expect(quickAddStore.create).toHaveBeenCalledWith(
      'auth0|primary-user',
      expect.objectContaining({ accountExternalId: 'checking', idempotencyKey: 'coffee-now' }),
      fullToken,
    );
  });
});

function initializeCommand(idempotencyKey: string) {
  return {
    command: { type: 'workspace.initialize' },
    expectedVersion: 0,
    idempotencyKey,
  };
}
