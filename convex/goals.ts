import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';

const cashFlowEvent = v.object({
  amountCents: v.number(),
  date: v.string(),
  kind: v.union(v.literal('income'), v.literal('obligation')),
});
const command = v.object({
  cashFlow: v.object({
    events: v.array(cashFlowEvent),
    openingCashCents: v.number(),
    safetyBufferCents: v.number(),
  }),
  goalExternalId: v.string(),
  idempotencyKey: v.string(),
  label: v.string(),
  priority: v.number(),
  reservationAmountCents: v.number(),
  reservationDate: v.string(),
  targetCents: v.number(),
  targetDate: v.string(),
});
const result = v.object({
  goalId: v.string(),
  outcome: v.union(v.literal('applied'), v.literal('replayed')),
  reservationId: v.string(),
});

export const approveGoalReservation = mutation({
  args: command.fields,
  returns: v.union(result, v.object({ type: v.literal('idempotency_key_conflict') })),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateCommand(request);
    const fingerprint = JSON.stringify(request);
    const receipt = await ctx.db
      .query('goalCommandReceipts')
      .withIndex('by_subject_and_idempotency_key', (index) =>
        index.eq('subject', subject).eq('idempotencyKey', request.idempotencyKey),
      )
      .unique();
    if (receipt) {
      if (receipt.requestFingerprint !== fingerprint)
        return { type: 'idempotency_key_conflict' } as const;
      return { ...receipt.result, outcome: 'replayed' as const };
    }
    const existingGoal = await ctx.db
      .query('goals')
      .withIndex('by_subject_and_goal_external_id', (index) =>
        index.eq('subject', subject).eq('goalExternalId', request.goalExternalId),
      )
      .unique();
    const existingReservations = await ctx.db
      .query('reservations')
      .withIndex('by_subject_and_due_date', (index) => index.eq('subject', subject))
      .collect();
    const safety = evaluateCashFlow(request.cashFlow, [
      ...existingReservations
        .filter((item) => item.goalId !== existingGoal?._id)
        .map((item) => ({ amountCents: item.amountCents, date: item.dueDate })),
      { amountCents: request.reservationAmountCents, date: request.reservationDate },
    ]);
    if (!safety.safe)
      throw new ConvexError({ code: 'cash_flow_unsafe', firstUnsafeDate: safety.firstUnsafeDate });
    const goalPatch = {
      label: request.label,
      priority: request.priority,
      status: 'approved' as const,
      targetCents: request.targetCents,
      targetDate: request.targetDate,
    };
    const goalId = existingGoal
      ? (await ctx.db.patch(existingGoal._id, goalPatch), existingGoal._id)
      : await ctx.db.insert('goals', {
          ...goalPatch,
          goalExternalId: request.goalExternalId,
          subject,
        });
    const existingReservation = existingReservations.find((item) => item.goalId === goalId);
    const reservationPatch = {
      amountCents: request.reservationAmountCents,
      dueDate: request.reservationDate,
      kind: 'goal' as const,
      label: request.label,
      state: 'approved' as const,
    };
    const reservationId = existingReservation
      ? (await ctx.db.patch(existingReservation._id, reservationPatch), existingReservation._id)
      : await ctx.db.insert('reservations', { ...reservationPatch, goalId, subject });
    const applied = { goalId, outcome: 'applied' as const, reservationId };
    await ctx.db.insert('goalCommandReceipts', {
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      result: applied,
      subject,
    });
    return applied;
  },
});

export const previewCashSafety = query({
  args: v.object({
    cashFlow: command.fields.cashFlow,
    reservationAmountCents: v.number(),
    reservationDate: v.string(),
  }).fields,
  returns: v.object({
    firstUnsafeDate: v.optional(v.string()),
    lowestBalanceCents: v.number(),
    safe: v.boolean(),
  }),
  handler: async (ctx, request) => {
    await requireSubject(ctx);
    if (!validMoney(request.reservationAmountCents) || !validDate(request.reservationDate))
      throw new ConvexError({ code: 'invalid_cash_flow_preview' });
    return evaluateCashFlow(request.cashFlow, [
      { amountCents: request.reservationAmountCents, date: request.reservationDate },
    ]);
  },
});

export const getApprovedGoals = query({
  args: {},
  returns: v.array(
    v.object({
      goalExternalId: v.string(),
      label: v.string(),
      priority: v.number(),
      reservationAmountCents: v.number(),
      reservationDate: v.string(),
      targetCents: v.number(),
      targetDate: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const subject = await requireSubject(ctx);
    const goals = await ctx.db
      .query('goals')
      .withIndex('by_subject_and_goal_external_id', (index) => index.eq('subject', subject))
      .collect();
    const reservations = await ctx.db
      .query('reservations')
      .withIndex('by_subject_and_due_date', (index) => index.eq('subject', subject))
      .collect();
    return goals
      .filter((goal) => goal.status === 'approved')
      .map((goal) => {
        const reservation = reservations.find((item) => item.goalId === goal._id);
        if (!reservation) throw new ConvexError({ code: 'goal_reservation_missing' });
        return {
          goalExternalId: goal.goalExternalId,
          label: goal.label,
          priority: goal.priority,
          reservationAmountCents: reservation.amountCents,
          reservationDate: reservation.dueDate,
          targetCents: goal.targetCents,
          targetDate: goal.targetDate,
        };
      })
      .sort((left, right) => left.priority - right.priority);
  },
});

function evaluateCashFlow(
  cashFlow: typeof command.type.cashFlow,
  reservations: Array<{ amountCents: number; date: string }>,
) {
  const events = [
    ...cashFlow.events.map((event) => ({
      amountCents: event.kind === 'income' ? event.amountCents : -event.amountCents,
      date: event.date,
    })),
    ...reservations.map((reservation) => ({
      amountCents: -reservation.amountCents,
      date: reservation.date,
    })),
  ].sort((left, right) => left.date.localeCompare(right.date));
  let balance = cashFlow.openingCashCents;
  let lowestBalanceCents = balance;
  let firstUnsafeDate: string | undefined;
  for (const event of events) {
    balance += event.amountCents;
    lowestBalanceCents = Math.min(lowestBalanceCents, balance);
    if (balance < cashFlow.safetyBufferCents && !firstUnsafeDate) firstUnsafeDate = event.date;
  }
  return { firstUnsafeDate, lowestBalanceCents, safe: firstUnsafeDate === undefined };
}

function validateCommand(request: typeof command.type) {
  if (
    !validText(request.goalExternalId) ||
    !validText(request.label) ||
    !validKey(request.idempotencyKey) ||
    !validMoney(request.targetCents) ||
    !validMoney(request.reservationAmountCents) ||
    !Number.isSafeInteger(request.priority) ||
    request.priority < 0 ||
    !validDate(request.targetDate) ||
    !validDate(request.reservationDate) ||
    !validMoney(request.cashFlow.openingCashCents, true) ||
    !validMoney(request.cashFlow.safetyBufferCents, true) ||
    request.cashFlow.events.some(
      (event) => !validMoney(event.amountCents) || !validDate(event.date),
    )
  )
    throw new ConvexError({ code: 'invalid_goal_reservation' });
}
function validMoney(value: number, allowZero = false) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function validText(value: string) {
  return value.trim().length > 0;
}
function validKey(value: string) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
async function requireSubject(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError({ code: 'authentication_required' });
  return identity.subject;
}
