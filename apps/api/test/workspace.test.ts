import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenVerifier } from '../src/auth.js';
import { buildApp } from '../src/app.js';

const readToken = 'read-token';
const writeToken = 'write-token';
const fullToken = 'full-token';
const secondUserToken = 'second-user-token';

function buildTestApp() {
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

  return buildApp({ accessTokenVerifier });
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
});

function initializeCommand(idempotencyKey: string) {
  return {
    command: { type: 'workspace.initialize' },
    expectedVersion: 0,
    idempotencyKey,
  };
}
