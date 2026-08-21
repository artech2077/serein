import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';
import { recordFinancialAudit, upsertMaterialAlert } from './audit';

const purchaseRequest = v.object({
  amountCents: v.number(),
  cardExternalId: v.string(),
  expectedSettlementEnd: v.string(),
  expectedSettlementStart: v.string(),
  idempotencyKey: v.string(),
  purchaseDate: v.string(),
  purchaseExternalId: v.string(),
  settlementAccountExternalId: v.string(),
  sourceDescription: v.string(),
});

const settlementRequest = v.object({
  allocations: v.array(v.object({ amountCents: v.number(), purchaseExternalId: v.string() })),
  amountCents: v.number(),
  cardExternalId: v.string(),
  idempotencyKey: v.string(),
  settlementAccountExternalId: v.string(),
  settlementDate: v.string(),
  settlementExternalId: v.string(),
  sourceDescription: v.string(),
});

const settlementResult = v.object({
  outcome: v.union(v.literal('applied'), v.literal('replayed')),
  outstandingLiabilityCents: v.number(),
  settlementId: v.string(),
  state: v.union(v.literal('reconciled'), v.literal('review_required')),
});

export const recordPurchase = mutation({
  args: purchaseRequest.fields,
  returns: v.union(
    v.object({
      outcome: v.union(v.literal('applied'), v.literal('replayed')),
      purchaseId: v.string(),
    }),
    v.object({ type: v.literal('idempotency_key_conflict') }),
  ),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validatePurchase(request);
    const fingerprint = JSON.stringify(request);
    const receipt = await ctx.db
      .query('deferredCardPurchaseReceipts')
      .withIndex('by_subject_and_idempotency_key', (index) =>
        index.eq('subject', subject).eq('idempotencyKey', request.idempotencyKey),
      )
      .unique();
    if (receipt) {
      if (receipt.requestFingerprint !== fingerprint)
        return { type: 'idempotency_key_conflict' } as const;
      return { outcome: 'replayed' as const, purchaseId: receipt.purchaseId };
    }
    const duplicate = await ctx.db
      .query('deferredCardPurchases')
      .withIndex('by_subject_and_card_and_purchase_external_id', (index) =>
        index
          .eq('subject', subject)
          .eq('cardExternalId', request.cardExternalId)
          .eq('purchaseExternalId', request.purchaseExternalId),
      )
      .unique();
    if (duplicate) throw new ConvexError({ code: 'purchase_already_recorded' });
    const purchaseId = await ctx.db.insert('deferredCardPurchases', {
      amountCents: request.amountCents,
      cardExternalId: request.cardExternalId,
      expectedSettlementEnd: request.expectedSettlementEnd,
      expectedSettlementStart: request.expectedSettlementStart,
      purchaseDate: request.purchaseDate,
      purchaseExternalId: request.purchaseExternalId,
      settlementAccountExternalId: request.settlementAccountExternalId,
      sourceDescription: request.sourceDescription,
      remainingLiabilityCents: request.amountCents,
      subject,
    });
    await ctx.db.insert('deferredCardPurchaseReceipts', {
      idempotencyKey: request.idempotencyKey,
      purchaseId,
      requestFingerprint: fingerprint,
      subject,
    });
    await recordFinancialAudit(ctx, {
      amountCents: request.amountCents,
      entityId: purchaseId,
      eventType: 'deferred_purchase_recorded',
      subject,
      summary: `Recorded a deferred-card purchase of ${request.amountCents} cents.`,
    });
    return { outcome: 'applied' as const, purchaseId };
  },
});

export const recordSettlement = mutation({
  args: settlementRequest.fields,
  returns: v.union(settlementResult, v.object({ type: v.literal('idempotency_key_conflict') })),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateSettlement(request);
    const fingerprint = JSON.stringify(request);
    const receipt = await ctx.db
      .query('deferredCardSettlementReceipts')
      .withIndex('by_subject_and_idempotency_key', (index) =>
        index.eq('subject', subject).eq('idempotencyKey', request.idempotencyKey),
      )
      .unique();
    if (receipt) {
      if (receipt.requestFingerprint !== fingerprint)
        return { type: 'idempotency_key_conflict' } as const;
      return { ...receipt.result, outcome: 'replayed' as const };
    }
    const duplicate = await ctx.db
      .query('deferredCardSettlements')
      .withIndex('by_subject_and_settlement_external_id', (index) =>
        index.eq('subject', subject).eq('settlementExternalId', request.settlementExternalId),
      )
      .unique();
    if (duplicate) throw new ConvexError({ code: 'settlement_already_recorded' });

    let allocatedCents = 0;
    const updates: Array<{
      id: Id<'deferredCardPurchases'>;
      amountCents: number;
      remaining: number;
    }> = [];
    for (const allocation of request.allocations) {
      const purchase = await ctx.db
        .query('deferredCardPurchases')
        .withIndex('by_subject_and_card_and_purchase_external_id', (index) =>
          index
            .eq('subject', subject)
            .eq('cardExternalId', request.cardExternalId)
            .eq('purchaseExternalId', allocation.purchaseExternalId),
        )
        .unique();
      if (
        !purchase ||
        purchase.settlementAccountExternalId !== request.settlementAccountExternalId ||
        allocation.amountCents > purchase.remainingLiabilityCents
      )
        throw new ConvexError({ code: 'invalid_settlement_allocation' });
      allocatedCents += allocation.amountCents;
      updates.push({
        amountCents: allocation.amountCents,
        id: purchase._id,
        remaining: purchase.remainingLiabilityCents - allocation.amountCents,
      });
    }
    if (allocatedCents > request.amountCents)
      throw new ConvexError({ code: 'invalid_settlement_allocation' });
    await Promise.all(
      updates.map((update) =>
        ctx.db.patch(update.id, { remainingLiabilityCents: update.remaining }),
      ),
    );
    const unallocatedCents = request.amountCents - allocatedCents;
    const state = unallocatedCents === 0 ? ('reconciled' as const) : ('review_required' as const);
    const settlementId = await ctx.db.insert('deferredCardSettlements', {
      amountCents: request.amountCents,
      cardExternalId: request.cardExternalId,
      settlementDate: request.settlementDate,
      settlementExternalId: request.settlementExternalId,
      settlementAccountExternalId: request.settlementAccountExternalId,
      sourceDescription: request.sourceDescription,
      state,
      subject,
      unallocatedCents,
    });
    await Promise.all(
      updates.map((update) =>
        ctx.db.insert('deferredCardSettlementAllocations', {
          amountCents: update.amountCents,
          purchaseId: update.id,
          settlementId,
          subject,
        }),
      ),
    );
    const outstandingLiabilityCents = await outstandingLiability(ctx, subject);
    const result = { outcome: 'applied' as const, outstandingLiabilityCents, settlementId, state };
    await ctx.db.insert('deferredCardSettlementReceipts', {
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      result,
      subject,
    });
    await recordFinancialAudit(ctx, {
      amountCents: request.amountCents,
      entityId: settlementId,
      eventType: 'settlement_recorded',
      subject,
      summary:
        state === 'reconciled'
          ? `Reconciled a deferred-card settlement of ${request.amountCents} cents.`
          : `Recorded a deferred-card settlement with ${unallocatedCents} cents still needing review.`,
    });
    if (state === 'review_required') {
      await upsertMaterialAlert(ctx, {
        dedupeKey: `unallocated-settlement:${request.settlementExternalId}`,
        evidenceId: settlementId,
        impactCents: unallocatedCents,
        kind: 'unallocated_settlement',
        recoveryAction: 'Review the settlement allocations and assign the remaining amount.',
        subject,
        summary: `${unallocatedCents} cents of this deferred-card settlement are not allocated to purchases.`,
      });
    }
    return result;
  },
});

export const getSummary = query({
  args: {},
  returns: v.object({
    cumulativePurchaseCents: v.number(),
    outstandingLiabilityCents: v.number(),
    reviewRequiredSettlementCount: v.number(),
  }),
  handler: async (ctx) => {
    const subject = await requireSubject(ctx);
    const purchases = await ctx.db
      .query('deferredCardPurchases')
      .withIndex('by_subject_and_card_and_purchase_external_id', (index) =>
        index.eq('subject', subject),
      )
      .collect();
    const settlements = await ctx.db
      .query('deferredCardSettlements')
      .withIndex('by_subject_and_settlement_external_id', (index) => index.eq('subject', subject))
      .collect();
    return {
      cumulativePurchaseCents: purchases.reduce(
        (total, purchase) => total + purchase.amountCents,
        0,
      ),
      outstandingLiabilityCents: purchases.reduce(
        (total, purchase) => total + purchase.remainingLiabilityCents,
        0,
      ),
      reviewRequiredSettlementCount: settlements.filter((item) => item.state === 'review_required')
        .length,
    };
  },
});

async function outstandingLiability(ctx: MutationCtx, subject: string) {
  const purchases = await ctx.db
    .query('deferredCardPurchases')
    .withIndex('by_subject_and_card_and_purchase_external_id', (index) =>
      index.eq('subject', subject),
    )
    .collect();
  return purchases.reduce((total, purchase) => total + purchase.remainingLiabilityCents, 0);
}

function validatePurchase(request: typeof purchaseRequest.type) {
  if (
    !validMoney(request.amountCents) ||
    !validDate(request.purchaseDate) ||
    !validDate(request.expectedSettlementStart) ||
    !validDate(request.expectedSettlementEnd) ||
    request.expectedSettlementStart > request.expectedSettlementEnd ||
    !validText(request.cardExternalId) ||
    !validText(request.purchaseExternalId) ||
    !validText(request.settlementAccountExternalId) ||
    !validText(request.sourceDescription) ||
    !validKey(request.idempotencyKey)
  )
    throw new ConvexError({ code: 'invalid_deferred_card_purchase' });
}

function validateSettlement(request: typeof settlementRequest.type) {
  if (
    !validMoney(request.amountCents) ||
    !validDate(request.settlementDate) ||
    !validText(request.cardExternalId) ||
    !validText(request.settlementExternalId) ||
    !validText(request.settlementAccountExternalId) ||
    !validText(request.sourceDescription) ||
    !validKey(request.idempotencyKey) ||
    new Set(request.allocations.map((item) => item.purchaseExternalId)).size !==
      request.allocations.length ||
    request.allocations.some(
      (item) => !validMoney(item.amountCents) || !validText(item.purchaseExternalId),
    )
  )
    throw new ConvexError({ code: 'invalid_deferred_card_settlement' });
}

function validMoney(value: number) {
  return Number.isSafeInteger(value) && value > 0;
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
