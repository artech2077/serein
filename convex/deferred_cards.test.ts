import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|card-user' };

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    amountCents: 1_000,
    cardExternalId: 'deferred-card',
    expectedSettlementEnd: '2026-09-05',
    expectedSettlementStart: '2026-09-01',
    idempotencyKey: 'purchase-1',
    purchaseDate: '2026-08-21',
    purchaseExternalId: 'purchase-1',
    settlementAccountExternalId: 'checking',
    sourceDescription: 'Corner Cafe',
    ...overrides,
  };
}

describe('deferred-card purchases and settlements', () => {
  it('reserves purchase-date liability and clears an exact settlement without new spending', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    const created = await t.mutation(api.deferred_cards.recordPurchase, purchase());
    const beforeSettlement = await t.query(api.deferred_cards.getSummary, {});
    const settled = await t.mutation(api.deferred_cards.recordSettlement, {
      allocations: [{ amountCents: 1_000, purchaseExternalId: 'purchase-1' }],
      amountCents: 1_000,
      cardExternalId: 'deferred-card',
      idempotencyKey: 'settlement-1',
      settlementAccountExternalId: 'checking',
      settlementDate: '2026-09-03',
      settlementExternalId: 'statement-settlement-1',
      sourceDescription: 'Card settlement',
    });
    const afterSettlement = await t.query(api.deferred_cards.getSummary, {});
    const allocations = await t.run(async (ctx) =>
      ctx.db.query('deferredCardSettlementAllocations').collect(),
    );

    expect(created).toMatchObject({ outcome: 'applied' });
    expect(beforeSettlement).toEqual({
      cumulativePurchaseCents: 1_000,
      outstandingLiabilityCents: 1_000,
      reviewRequiredSettlementCount: 0,
    });
    expect(settled).toMatchObject({
      outstandingLiabilityCents: 0,
      outcome: 'applied',
      state: 'reconciled',
    });
    expect(afterSettlement).toEqual({
      cumulativePurchaseCents: 1_000,
      outstandingLiabilityCents: 0,
      reviewRequiredSettlementCount: 0,
    });
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      amountCents: 1_000,
      settlementId: settled.settlementId,
    });
  });

  it('supports partial and delayed settlement while keeping unmatched value reviewable', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await t.mutation(api.deferred_cards.recordPurchase, purchase());
    const partial = await t.mutation(api.deferred_cards.recordSettlement, {
      allocations: [{ amountCents: 400, purchaseExternalId: 'purchase-1' }],
      amountCents: 500,
      cardExternalId: 'deferred-card',
      idempotencyKey: 'settlement-partial',
      settlementAccountExternalId: 'checking',
      settlementDate: '2026-10-03',
      settlementExternalId: 'statement-settlement-partial',
      sourceDescription: 'Delayed card settlement',
    });
    const summary = await t.query(api.deferred_cards.getSummary, {});

    expect(partial).toMatchObject({
      outstandingLiabilityCents: 600,
      state: 'review_required',
    });
    expect(summary).toEqual({
      cumulativePurchaseCents: 1_000,
      outstandingLiabilityCents: 600,
      reviewRequiredSettlementCount: 1,
    });
  });

  it('replays matching requests and keeps card records private to the authenticated subject', async () => {
    const t = convexTest(schema, modules);
    const first = await t
      .withIdentity(identity)
      .mutation(api.deferred_cards.recordPurchase, purchase());
    const replayed = await t
      .withIdentity(identity)
      .mutation(api.deferred_cards.recordPurchase, purchase());
    const otherSummary = await t
      .withIdentity({ subject: 'auth0|other-card-user' })
      .query(api.deferred_cards.getSummary, {});

    expect(first).toMatchObject({ outcome: 'applied' });
    expect(replayed).toMatchObject({ outcome: 'replayed', purchaseId: first.purchaseId });
    expect(otherSummary).toEqual({
      cumulativePurchaseCents: 0,
      outstandingLiabilityCents: 0,
      reviewRequiredSettlementCount: 0,
    });
  });
});
