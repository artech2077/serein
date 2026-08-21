import type { MutationCtx, QueryCtx } from './_generated/server';
import { query } from './_generated/server';
import { ConvexError, v } from 'convex/values';

const auditEventType = v.union(
  v.literal('account_coverage_changed'),
  v.literal('classification_confirmed'),
  v.literal('csv_imported'),
  v.literal('deferred_purchase_recorded'),
  v.literal('merchant_corrected'),
  v.literal('monthly_plan_approved'),
  v.literal('monthly_plan_proposed'),
  v.literal('monthly_plan_revision_proposed'),
  v.literal('quick_add_created'),
  v.literal('quick_add_reconciled'),
  v.literal('reservation_approved'),
  v.literal('settlement_recorded'),
);
const alertKind = v.union(
  v.literal('ambiguous_quick_add_match'),
  v.literal('missing_account_coverage'),
  v.literal('unallocated_settlement'),
);

type AuditEventType = typeof auditEventType.type;
type AlertKind = typeof alertKind.type;

export async function recordFinancialAudit(
  ctx: MutationCtx,
  event: {
    amountCents?: number;
    entityId?: string;
    eventType: AuditEventType;
    month?: string;
    subject: string;
    summary: string;
  },
) {
  await ctx.db.insert('financialAuditEvents', { ...event, occurredAt: Date.now() });
}

export async function upsertMaterialAlert(
  ctx: MutationCtx,
  alert: {
    dedupeKey: string;
    evidenceId?: string;
    impactCents?: number;
    kind: AlertKind;
    recoveryAction: string;
    subject: string;
    summary: string;
  },
) {
  const existing = await ctx.db
    .query('materialAlerts')
    .withIndex('by_subject_and_dedupe_key', (index) =>
      index.eq('subject', alert.subject).eq('dedupeKey', alert.dedupeKey),
    )
    .unique();
  const updatedAt = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, { ...alert, state: 'open', updatedAt });
    return existing._id;
  }
  return await ctx.db.insert('materialAlerts', {
    ...alert,
    createdAt: updatedAt,
    state: 'open',
    updatedAt,
  });
}

export async function resolveMaterialAlert(ctx: MutationCtx, subject: string, dedupeKey: string) {
  const existing = await ctx.db
    .query('materialAlerts')
    .withIndex('by_subject_and_dedupe_key', (index) =>
      index.eq('subject', subject).eq('dedupeKey', dedupeKey),
    )
    .unique();
  if (existing?.state === 'open')
    await ctx.db.patch(existing._id, { state: 'resolved', updatedAt: Date.now() });
}

export const getHistory = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      amountCents: v.optional(v.number()),
      entityId: v.optional(v.string()),
      eventType: auditEventType,
      month: v.optional(v.string()),
      occurredAt: v.number(),
      summary: v.string(),
    }),
  ),
  handler: async (ctx, { limit = 50 }) => {
    const subject = await requireSubject(ctx);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ConvexError({ code: 'invalid_history_limit' });
    const events = await ctx.db
      .query('financialAuditEvents')
      .withIndex('by_subject_and_occurred_at', (index) => index.eq('subject', subject))
      .order('desc')
      .take(limit);
    return events.map(({ amountCents, entityId, eventType, month, occurredAt, summary }) => ({
      amountCents,
      entityId,
      eventType,
      month,
      occurredAt,
      summary,
    }));
  },
});

export const getOpenAlerts = query({
  args: {},
  returns: v.array(
    v.object({
      createdAt: v.number(),
      evidenceId: v.optional(v.string()),
      impactCents: v.optional(v.number()),
      kind: alertKind,
      recoveryAction: v.string(),
      summary: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const subject = await requireSubject(ctx);
    const alerts = await ctx.db
      .query('materialAlerts')
      .withIndex('by_subject_and_state_and_updated_at', (index) =>
        index.eq('subject', subject).eq('state', 'open'),
      )
      .order('desc')
      .collect();
    return alerts.map(
      ({ createdAt, evidenceId, impactCents, kind, recoveryAction, summary, updatedAt }) => ({
        createdAt,
        evidenceId,
        impactCents,
        kind,
        recoveryAction,
        summary,
        updatedAt,
      }),
    );
  },
});

async function requireSubject(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError({ code: 'authentication_required' });
  return identity.subject;
}
