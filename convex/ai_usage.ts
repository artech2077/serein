import type { MutationCtx } from './_generated/server';
import { mutation } from './_generated/server';
import { ConvexError, v } from 'convex/values';

const task = v.union(v.literal('routine_classification'), v.literal('monthly_planning'));
const reservationResult = v.union(
  v.object({ replayed: v.boolean(), reservationId: v.string(), type: v.literal('reserved') }),
  v.object({ type: v.literal('budget_exceeded') }),
  v.object({ type: v.literal('idempotency_key_conflict') }),
  v.object({ type: v.literal('reservation_not_found') }),
);

export const reserve = mutation({
  args: {
    estimatedCostNanoEur: v.number(),
    month: v.string(),
    monthlyBudgetNanoEur: v.number(),
    monthlyPlanningReserveNanoEur: v.number(),
    requestId: v.string(),
    task,
  },
  returns: reservationResult,
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validate(request);
    const fingerprint = JSON.stringify(request);
    const existing = await ctx.db
      .query('aiUsageReservations')
      .withIndex('by_subject_and_request_id', (index) =>
        index.eq('subject', subject).eq('requestId', request.requestId),
      )
      .unique();
    if (existing) {
      if (existing.requestFingerprint !== fingerprint)
        return { type: 'idempotency_key_conflict' } as const;
      return { replayed: true, reservationId: existing._id, type: 'reserved' } as const;
    }

    const [committed, reserved] = await Promise.all([
      ctx.db
        .query('aiUsageReservations')
        .withIndex('by_subject_and_month_and_state', (index) =>
          index.eq('subject', subject).eq('month', request.month).eq('state', 'committed'),
        )
        .collect(),
      ctx.db
        .query('aiUsageReservations')
        .withIndex('by_subject_and_month_and_state', (index) =>
          index.eq('subject', subject).eq('month', request.month).eq('state', 'reserved'),
        )
        .collect(),
    ]);
    const remaining =
      request.monthlyBudgetNanoEur - request.estimatedCostNanoEur - sum(committed) - sum(reserved);
    const protectedReserve =
      request.task === 'monthly_planning' ? 0 : request.monthlyPlanningReserveNanoEur;
    if (remaining < protectedReserve) return { type: 'budget_exceeded' } as const;
    const reservationId = await ctx.db.insert('aiUsageReservations', {
      estimatedCostNanoEur: request.estimatedCostNanoEur,
      month: request.month,
      requestFingerprint: fingerprint,
      requestId: request.requestId,
      state: 'reserved',
      subject,
      task: request.task,
    });
    return { replayed: false, reservationId, type: 'reserved' } as const;
  },
});

export const commit = mutation({
  args: { requestId: v.string() },
  returns: reservationResult,
  handler: async (ctx, { requestId }) => {
    const subject = await requireSubject(ctx);
    if (!validRequestId(requestId)) throw new ConvexError({ code: 'invalid_ai_usage_reservation' });
    const reservation = await ctx.db
      .query('aiUsageReservations')
      .withIndex('by_subject_and_request_id', (index) =>
        index.eq('subject', subject).eq('requestId', requestId),
      )
      .unique();
    if (!reservation) return { type: 'reservation_not_found' } as const;
    if (reservation.state === 'reserved')
      await ctx.db.patch(reservation._id, { state: 'committed' });
    return {
      replayed: reservation.state === 'committed',
      reservationId: reservation._id,
      type: 'reserved',
    } as const;
  },
});

function sum(items: Array<{ estimatedCostNanoEur: number }>) {
  return items.reduce((total, item) => total + item.estimatedCostNanoEur, 0);
}
function validate(value: {
  estimatedCostNanoEur: number;
  month: string;
  monthlyBudgetNanoEur: number;
  monthlyPlanningReserveNanoEur: number;
  requestId: string;
}) {
  if (
    !validMoney(value.estimatedCostNanoEur) ||
    !validMoney(value.monthlyBudgetNanoEur) ||
    !Number.isSafeInteger(value.monthlyPlanningReserveNanoEur) ||
    value.monthlyPlanningReserveNanoEur < 0 ||
    value.monthlyPlanningReserveNanoEur > value.monthlyBudgetNanoEur ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) ||
    !validRequestId(value.requestId)
  )
    throw new ConvexError({ code: 'invalid_ai_usage_reservation' });
}
function validMoney(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
function validRequestId(value: string) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
async function requireSubject(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError({ code: 'authentication_required' });
  return identity.subject;
}
