import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';

const workspaceProjection = v.object({
  initialized: v.boolean(),
  version: v.number(),
  workspaceId: v.string(),
});

const workspaceCommand = v.object({
  command: v.object({ type: v.literal('workspace.initialize') }),
  expectedVersion: v.number(),
  idempotencyKey: v.string(),
});

const commandResult = v.union(
  v.object({
    outcome: v.union(v.literal('applied'), v.literal('replayed')),
    projection: workspaceProjection,
    type: v.literal('success'),
  }),
  v.object({
    actualVersion: v.number(),
    expectedVersion: v.number(),
    type: v.literal('version_conflict'),
  }),
  v.object({ type: v.literal('idempotency_key_conflict') }),
  v.object({ type: v.literal('workspace_already_initialized') }),
);

export const get = query({
  args: {},
  returns: workspaceProjection,
  handler: async (ctx) => {
    const subject = await requireSubject(ctx);
    const workspace = await ctx.db
      .query('financeWorkspaces')
      .withIndex('by_subject', (index) => index.eq('subject', subject))
      .unique();

    return workspace
      ? toProjection(workspace)
      : {
          initialized: false,
          version: 0,
          workspaceId: await workspaceIdForSubject(subject),
        };
  },
});

export const initialize = mutation({
  args: workspaceCommand.fields,
  returns: commandResult,
  handler: async (ctx, request) => {
    validateCommand(request);

    const subject = await requireSubject(ctx);
    const requestFingerprint = JSON.stringify({
      command: request.command,
      expectedVersion: request.expectedVersion,
    });
    const receipt = await ctx.db
      .query('workspaceCommandReceipts')
      .withIndex('by_subject_and_idempotency_key', (index) =>
        index.eq('subject', subject).eq('idempotencyKey', request.idempotencyKey),
      )
      .unique();

    if (receipt) {
      if (receipt.requestFingerprint !== requestFingerprint) {
        return { type: 'idempotency_key_conflict' } as const;
      }

      const workspace = await ctx.db
        .query('financeWorkspaces')
        .withIndex('by_subject', (index) => index.eq('subject', subject))
        .unique();

      if (!workspace) {
        throw new ConvexError({ code: 'workspace_receipt_invariant_failed' });
      }

      return {
        outcome: 'replayed',
        projection: toProjection(workspace),
        type: 'success',
      } as const;
    }

    const workspace = await ctx.db
      .query('financeWorkspaces')
      .withIndex('by_subject', (index) => index.eq('subject', subject))
      .unique();

    if (workspace && workspace.version !== request.expectedVersion) {
      return {
        actualVersion: workspace.version,
        expectedVersion: request.expectedVersion,
        type: 'version_conflict',
      } as const;
    }

    if (workspace?.initialized) {
      return { type: 'workspace_already_initialized' } as const;
    }

    const workspaceId = workspace?.workspaceId ?? (await workspaceIdForSubject(subject));
    const projection = { initialized: true, version: 1, workspaceId };

    if (workspace) {
      await ctx.db.patch(workspace._id, projection);
    } else {
      await ctx.db.insert('financeWorkspaces', { ...projection, subject });
    }

    await ctx.db.insert('workspaceCommandReceipts', {
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      subject,
      workspaceId,
    });

    return { outcome: 'applied', projection, type: 'success' } as const;
  },
});

async function requireSubject(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity?.subject) {
    throw new ConvexError({ code: 'authentication_required' });
  }

  return identity.subject;
}

function validateCommand(request: { expectedVersion: number; idempotencyKey: string }): void {
  if (
    !Number.isSafeInteger(request.expectedVersion) ||
    request.expectedVersion < 0 ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(request.idempotencyKey)
  ) {
    throw new ConvexError({ code: 'invalid_command' });
  }
}

function toProjection(workspace: { initialized: boolean; version: number; workspaceId: string }) {
  return {
    initialized: workspace.initialized,
    version: workspace.version,
    workspaceId: workspace.workspaceId,
  };
}

async function workspaceIdForSubject(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject));
  const encoded = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

  return `workspace_${encoded.slice(0, 22)}`;
}
