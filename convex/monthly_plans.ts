import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';
import { recordFinancialAudit } from './audit';

const planState = v.union(
  v.literal('awaiting_approval'),
  v.literal('active'),
  v.literal('revision_proposed'),
);
const planRequest = v.object({
  expectedSalaryEnd: v.string(),
  expectedSalaryStart: v.string(),
  forecastSalaryCents: v.number(),
  idempotencyKey: v.string(),
  month: v.string(),
  proposedBaseDailyAllowanceCents: v.number(),
  receivedIncomeCents: v.optional(v.number()),
});
const commandResult = v.object({
  approvedBaseDailyAllowanceCents: v.optional(v.number()),
  month: v.string(),
  outcome: v.union(v.literal('applied'), v.literal('replayed')),
  planId: v.string(),
  proposedBaseDailyAllowanceCents: v.number(),
  revisionRequired: v.boolean(),
  state: planState,
  version: v.number(),
});
type AppliedCommandResult = {
  approvedBaseDailyAllowanceCents?: number;
  month: string;
  outcome: 'applied';
  planId: string;
  proposedBaseDailyAllowanceCents: number;
  revisionRequired: boolean;
  state: 'awaiting_approval' | 'active' | 'revision_proposed';
  version: number;
};

export const propose = mutation({
  args: planRequest.fields,
  returns: v.union(commandResult, v.object({ type: v.literal('idempotency_key_conflict') })),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateProposal(request);
    const replay = await replayIfPresent(ctx, subject, request.idempotencyKey, request);
    if (replay) return replay;
    const existing = await findPlan(ctx, subject, request.month);
    if (existing) throw new ConvexError({ code: 'monthly_plan_already_exists' });
    const planId = await ctx.db.insert('monthlyPlans', {
      expectedSalaryEnd: request.expectedSalaryEnd,
      expectedSalaryStart: request.expectedSalaryStart,
      forecastSalaryCents: request.forecastSalaryCents,
      month: request.month,
      proposedBaseDailyAllowanceCents: request.proposedBaseDailyAllowanceCents,
      receivedIncomeCents: request.receivedIncomeCents,
      state: 'awaiting_approval',
      subject,
      version: 1,
    });
    const result = {
      month: request.month,
      outcome: 'applied' as const,
      planId,
      proposedBaseDailyAllowanceCents: request.proposedBaseDailyAllowanceCents,
      revisionRequired: false,
      state: 'awaiting_approval' as const,
      version: 1,
    };
    await saveReceipt(ctx, subject, request.idempotencyKey, request, result);
    await recordFinancialAudit(ctx, {
      amountCents: request.proposedBaseDailyAllowanceCents,
      entityId: planId,
      eventType: 'monthly_plan_proposed',
      month: request.month,
      subject,
      summary: `Proposed the ${request.month} monthly plan with a daily allowance of ${request.proposedBaseDailyAllowanceCents} cents.`,
    });
    return result;
  },
});

export const approve = mutation({
  args: { idempotencyKey: v.string(), month: v.string(), version: v.number() },
  returns: v.union(commandResult, v.object({ type: v.literal('idempotency_key_conflict') })),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateApproval(request);
    const replay = await replayIfPresent(ctx, subject, request.idempotencyKey, request);
    if (replay) return replay;
    const plan = await requirePlan(ctx, subject, request.month);
    if (plan.version !== request.version)
      throw new ConvexError({ code: 'monthly_plan_version_conflict' });
    if (plan.state === 'active') throw new ConvexError({ code: 'monthly_plan_already_active' });
    const version = plan.version + 1;
    await ctx.db.patch(plan._id, {
      approvedBaseDailyAllowanceCents: plan.proposedBaseDailyAllowanceCents,
      state: 'active',
      version,
    });
    const result = {
      approvedBaseDailyAllowanceCents: plan.proposedBaseDailyAllowanceCents,
      month: plan.month,
      outcome: 'applied' as const,
      planId: plan._id,
      proposedBaseDailyAllowanceCents: plan.proposedBaseDailyAllowanceCents,
      revisionRequired: false,
      state: 'active' as const,
      version,
    };
    await saveReceipt(ctx, subject, request.idempotencyKey, request, result);
    await recordFinancialAudit(ctx, {
      amountCents: plan.proposedBaseDailyAllowanceCents,
      entityId: plan._id,
      eventType: 'monthly_plan_approved',
      month: plan.month,
      subject,
      summary: `Approved the ${plan.month} monthly plan and its ${plan.proposedBaseDailyAllowanceCents}-cent daily allowance.`,
    });
    return result;
  },
});

export const proposeMaterialRevision = mutation({
  args: {
    idempotencyKey: v.string(),
    materialEventId: v.string(),
    minimumMaterialChangeCents: v.number(),
    month: v.string(),
    proposedBaseDailyAllowanceCents: v.number(),
    version: v.number(),
  },
  returns: v.union(commandResult, v.object({ type: v.literal('idempotency_key_conflict') })),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateRevision(request);
    const replay = await replayIfPresent(ctx, subject, request.idempotencyKey, request);
    if (replay) return replay;
    const plan = await requirePlan(ctx, subject, request.month);
    if (plan.version !== request.version)
      throw new ConvexError({ code: 'monthly_plan_version_conflict' });
    if (plan.state !== 'active' || plan.approvedBaseDailyAllowanceCents === undefined)
      throw new ConvexError({ code: 'monthly_plan_not_active' });
    const change = Math.abs(
      request.proposedBaseDailyAllowanceCents - plan.approvedBaseDailyAllowanceCents,
    );
    if (change < request.minimumMaterialChangeCents) {
      const result = {
        approvedBaseDailyAllowanceCents: plan.approvedBaseDailyAllowanceCents,
        month: plan.month,
        outcome: 'applied' as const,
        planId: plan._id,
        proposedBaseDailyAllowanceCents: plan.proposedBaseDailyAllowanceCents,
        revisionRequired: false,
        state: plan.state,
        version: plan.version,
      };
      await saveReceipt(ctx, subject, request.idempotencyKey, request, result);
      return result;
    }
    const version = plan.version + 1;
    await ctx.db.patch(plan._id, {
      proposedBaseDailyAllowanceCents: request.proposedBaseDailyAllowanceCents,
      state: 'revision_proposed',
      version,
    });
    const result = {
      approvedBaseDailyAllowanceCents: plan.approvedBaseDailyAllowanceCents,
      month: plan.month,
      outcome: 'applied' as const,
      planId: plan._id,
      proposedBaseDailyAllowanceCents: request.proposedBaseDailyAllowanceCents,
      revisionRequired: true,
      state: 'revision_proposed' as const,
      version,
    };
    await saveReceipt(ctx, subject, request.idempotencyKey, request, result);
    await recordFinancialAudit(ctx, {
      amountCents: request.proposedBaseDailyAllowanceCents,
      entityId: plan._id,
      eventType: 'monthly_plan_revision_proposed',
      month: plan.month,
      subject,
      summary: `Proposed a material revision to the ${plan.month} daily allowance.`,
    });
    return result;
  },
});

export const get = query({
  args: { asOf: v.string(), month: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      approvedBaseDailyAllowanceCents: v.optional(v.number()),
      month: v.string(),
      proposedBaseDailyAllowanceCents: v.number(),
      salary: v.object({
        conservativeIncomeCents: v.number(),
        expectedSalaryEnd: v.string(),
        expectedSalaryStart: v.string(),
        forecastSalaryCents: v.number(),
        receivedIncomeCents: v.optional(v.number()),
        status: v.union(
          v.literal('forecast'),
          v.literal('received'),
          v.literal('late_conservative'),
        ),
      }),
      state: planState,
      version: v.number(),
    }),
  ),
  handler: async (ctx, { asOf, month }) => {
    const subject = await requireSubject(ctx);
    if (!validDate(asOf) || !validMonth(month))
      throw new ConvexError({ code: 'invalid_monthly_plan' });
    const plan = await findPlan(ctx, subject, month);
    return plan && toProjection(plan, asOf);
  },
});

async function replayIfPresent(
  ctx: MutationCtx,
  subject: string,
  idempotencyKey: string,
  request: unknown,
) {
  const receipt = await ctx.db
    .query('monthlyPlanCommandReceipts')
    .withIndex('by_subject_and_idempotency_key', (index) =>
      index.eq('subject', subject).eq('idempotencyKey', idempotencyKey),
    )
    .unique();
  if (!receipt) return undefined;
  if (receipt.requestFingerprint !== JSON.stringify(request))
    return { type: 'idempotency_key_conflict' } as const;
  return { ...receipt.result, outcome: 'replayed' as const };
}

async function saveReceipt(
  ctx: MutationCtx,
  subject: string,
  idempotencyKey: string,
  request: unknown,
  result: AppliedCommandResult,
) {
  await ctx.db.insert('monthlyPlanCommandReceipts', {
    idempotencyKey,
    requestFingerprint: JSON.stringify(request),
    result,
    subject,
  });
}

async function findPlan(ctx: QueryCtx | MutationCtx, subject: string, month: string) {
  return await ctx.db
    .query('monthlyPlans')
    .withIndex('by_subject_and_month', (index) => index.eq('subject', subject).eq('month', month))
    .unique();
}

async function requirePlan(ctx: MutationCtx, subject: string, month: string) {
  const plan = await findPlan(ctx, subject, month);
  if (!plan) throw new ConvexError({ code: 'monthly_plan_not_found' });
  return plan;
}

function toProjection(
  plan: {
    approvedBaseDailyAllowanceCents?: number;
    expectedSalaryEnd: string;
    expectedSalaryStart: string;
    forecastSalaryCents: number;
    month: string;
    proposedBaseDailyAllowanceCents: number;
    receivedIncomeCents?: number;
    state: 'awaiting_approval' | 'active' | 'revision_proposed';
    version: number;
  },
  asOf: string,
) {
  const received = plan.receivedIncomeCents;
  const status =
    received !== undefined
      ? ('received' as const)
      : asOf > plan.expectedSalaryEnd
        ? ('late_conservative' as const)
        : ('forecast' as const);
  return {
    approvedBaseDailyAllowanceCents: plan.approvedBaseDailyAllowanceCents,
    month: plan.month,
    proposedBaseDailyAllowanceCents: plan.proposedBaseDailyAllowanceCents,
    salary: {
      conservativeIncomeCents: received ?? 0,
      expectedSalaryEnd: plan.expectedSalaryEnd,
      expectedSalaryStart: plan.expectedSalaryStart,
      forecastSalaryCents: plan.forecastSalaryCents,
      receivedIncomeCents: received,
      status,
    },
    state: plan.state,
    version: plan.version,
  };
}

function validateProposal(value: typeof planRequest.type) {
  if (
    !validMonth(value.month) ||
    !validDate(value.expectedSalaryStart) ||
    !validDate(value.expectedSalaryEnd) ||
    value.expectedSalaryStart > value.expectedSalaryEnd ||
    !validMoney(value.forecastSalaryCents) ||
    !validMoney(value.proposedBaseDailyAllowanceCents) ||
    (value.receivedIncomeCents !== undefined && !validMoney(value.receivedIncomeCents)) ||
    !validKey(value.idempotencyKey)
  )
    throw new ConvexError({ code: 'invalid_monthly_plan' });
}

function validateApproval(value: { idempotencyKey: string; month: string; version: number }) {
  if (!validMonth(value.month) || !validKey(value.idempotencyKey) || !validVersion(value.version))
    throw new ConvexError({ code: 'invalid_monthly_plan' });
}

function validateRevision(value: {
  idempotencyKey: string;
  materialEventId: string;
  minimumMaterialChangeCents: number;
  month: string;
  proposedBaseDailyAllowanceCents: number;
  version: number;
}) {
  if (
    !validMonth(value.month) ||
    !validKey(value.idempotencyKey) ||
    value.materialEventId.trim().length === 0 ||
    !validMoney(value.minimumMaterialChangeCents) ||
    !validMoney(value.proposedBaseDailyAllowanceCents) ||
    !validVersion(value.version)
  )
    throw new ConvexError({ code: 'invalid_monthly_plan' });
}

function validMonth(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function validMoney(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
function validVersion(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
function validKey(value: string) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
async function requireSubject(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError({ code: 'authentication_required' });
  return identity.subject;
}
