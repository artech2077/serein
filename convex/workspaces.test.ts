import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const primaryIdentity = { subject: 'auth0|primary-user' };
const secondIdentity = { subject: 'auth0|second-user' };

function initializeCommand(idempotencyKey: string, expectedVersion = 0) {
  return {
    command: { type: 'workspace.initialize' as const },
    expectedVersion,
    idempotencyKey,
  };
}

describe('workspaces', () => {
  it('stores an Auth0-subject-scoped workspace and never accepts a caller-selected owner', async () => {
    const t = convexTest(schema, modules);
    const primary = t.withIdentity(primaryIdentity);
    const second = t.withIdentity(secondIdentity);

    const initial = await primary.query(api.workspaces.get, {});
    const result = await primary.mutation(
      api.workspaces.initialize,
      initializeCommand('initialize'),
    );
    const primaryProjection = await primary.query(api.workspaces.get, {});
    const secondProjection = await second.query(api.workspaces.get, {});

    expect(initial).toMatchObject({ initialized: false, version: 0 });
    expect(result).toMatchObject({
      outcome: 'applied',
      projection: { initialized: true, version: 1 },
      type: 'success',
    });
    expect(primaryProjection).toMatchObject({ initialized: true, version: 1 });
    expect(secondProjection).toMatchObject({ initialized: false, version: 0 });
    expect(secondProjection.workspaceId).not.toBe(primaryProjection.workspaceId);
  });

  it('replays matching requests and returns deterministic conflicts', async () => {
    const t = convexTest(schema, modules);
    const primary = t.withIdentity(primaryIdentity);
    const command = initializeCommand('initialize');

    const applied = await primary.mutation(api.workspaces.initialize, command);
    const replayed = await primary.mutation(api.workspaces.initialize, command);
    const staleVersion = await primary.mutation(
      api.workspaces.initialize,
      initializeCommand('stale-version'),
    );
    const reusedKey = await primary.mutation(
      api.workspaces.initialize,
      initializeCommand('initialize', 1),
    );

    expect(applied).toMatchObject({ outcome: 'applied', type: 'success' });
    expect(replayed).toMatchObject({ outcome: 'replayed', type: 'success' });
    expect(staleVersion).toEqual({
      actualVersion: 1,
      expectedVersion: 0,
      type: 'version_conflict',
    });
    expect(reusedKey).toEqual({ type: 'idempotency_key_conflict' });
  });

  it('requires an authenticated identity', async () => {
    const t = convexTest(schema, modules);

    await expect(t.query(api.workspaces.get, {})).rejects.toThrow('authentication_required');
  });
});
