import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|goal-user' };

function command(overrides: Record<string, unknown> = {}) {
  return {
    cashFlow: {
      events: [
        { amountCents: 3_000, date: '2026-09-03', kind: 'income' },
        { amountCents: 4_000, date: '2026-09-05', kind: 'obligation' },
      ],
      openingCashCents: 5_000,
      safetyBufferCents: 1_000,
    },
    goalExternalId: 'emergency-fund',
    idempotencyKey: 'goal-1',
    label: 'Emergency fund',
    priority: 1,
    reservationAmountCents: 2_000,
    reservationDate: '2026-09-10',
    targetCents: 20_000,
    targetDate: '2026-12-31',
    ...overrides,
  };
}

describe('approved goals and dated cash-flow safety', () => {
  it('creates a virtual reservation while retaining the user-selected priority', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    const approved = await t.mutation(api.goals.approveGoalReservation, command());
    const goals = await t.query(api.goals.getApprovedGoals, {});

    expect(approved).toMatchObject({ outcome: 'applied' });
    expect(goals).toEqual([
      {
        goalExternalId: 'emergency-fund',
        label: 'Emergency fund',
        priority: 1,
        reservationAmountCents: 2_000,
        reservationDate: '2026-09-10',
        targetCents: 20_000,
        targetDate: '2026-12-31',
      },
    ]);
  });

  it('rejects a proposed goal reservation that would breach an obligation or safety buffer', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    const preview = await t.query(api.goals.previewCashSafety, {
      cashFlow: command().cashFlow,
      reservationAmountCents: 7_000,
      reservationDate: '2026-09-01',
    });

    await expect(
      t.mutation(
        api.goals.approveGoalReservation,
        command({ reservationAmountCents: 7_000, reservationDate: '2026-09-01' }),
      ),
    ).rejects.toThrow('cash_flow_unsafe');
    expect(preview).toEqual({
      firstUnsafeDate: '2026-09-01',
      lowestBalanceCents: -3_000,
      safe: false,
    });
    expect(await t.query(api.goals.getApprovedGoals, {})).toEqual([]);
  });

  it('replays matching retries and does not expose another user’s approved goals', async () => {
    const t = convexTest(schema, modules);
    const first = await t
      .withIdentity(identity)
      .mutation(api.goals.approveGoalReservation, command());
    const replayed = await t
      .withIdentity(identity)
      .mutation(api.goals.approveGoalReservation, command());

    expect(replayed).toMatchObject({
      goalId: first.goalId,
      outcome: 'replayed',
      reservationId: first.reservationId,
    });
    expect(
      await t
        .withIdentity({ subject: 'auth0|other-goal-user' })
        .query(api.goals.getApprovedGoals, {}),
    ).toEqual([]);
  });

  it('replaces a goal reservation without changing the chosen priority', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await t.mutation(api.goals.approveGoalReservation, command());
    await t.mutation(
      api.goals.approveGoalReservation,
      command({ idempotencyKey: 'goal-2', reservationAmountCents: 3_000 }),
    );

    expect(await t.query(api.goals.getApprovedGoals, {})).toEqual([
      expect.objectContaining({ priority: 1, reservationAmountCents: 3_000 }),
    ]);
  });
});
