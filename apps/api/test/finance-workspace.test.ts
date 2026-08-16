import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { financeWorkspaceFixture } from '@serein/fixtures';

import { calculateFinanceWorkspace } from '../src/finance-workspace.js';

describe('finance workspace contract', () => {
  it.each([
    {
      expected: {
        carryCents: 3_700,
        genuineAvailabilityCents: 70_000,
        safeToSpendTodayCents: 5_000,
      },
      input: financeWorkspaceFixture({
        approvedReservations: [{ amountCents: 12_000, id: 'rent', label: 'Rent' }],
        asOf: '2026-08-03',
        baseDailyAllowanceCents: 2_000,
        cashBalanceCents: 100_000,
        deferredCardLiabilityCents: 8_000,
        movements: [
          { amountCents: 500, date: '2026-08-01', id: 'coffee', kind: 'discretionary-spend' },
          { amountCents: 200, date: '2026-08-02', id: 'refund', kind: 'refund' },
          { amountCents: 700, date: '2026-08-03', id: 'lunch', kind: 'discretionary-spend' },
          { amountCents: 40_000, date: '2026-08-03', id: 'transfer', kind: 'transfer' },
        ],
        periodStart: '2026-08-01',
        safetyBufferCents: 10_000,
      }),
      name: 'accounts for carry, refunds, transfers, reservations, and today’s spending',
    },
    {
      expected: {
        carryCents: 4_000,
        genuineAvailabilityCents: 1_200,
        safeToSpendTodayCents: 1_200,
      },
      input: financeWorkspaceFixture({
        asOf: '2026-03-01',
        cashBalanceCents: 11_200,
        movements: [],
        periodStart: '2026-02-27',
      }),
      name: 'uses calendar dates across a leap-year month boundary and caps by genuine availability',
    },
  ])('$name', ({ expected, input }) => {
    const snapshot = calculateFinanceWorkspace(input);

    expect(snapshot).toMatchObject(expected);
    expect(snapshot.explanations.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'cash_balance',
        'deferred_card_liability',
        'approved_reservations',
        'safety_buffer',
        'base_daily_allowance',
        'carry',
        'today_discretionary_spend',
      ]),
    );
  });

  it('marks older source data stale with its calendar-day age', () => {
    const snapshot = calculateFinanceWorkspace(
      financeWorkspaceFixture({ asOf: '2026-08-16', sourceAsOf: '2026-08-14' }),
    );

    expect(snapshot.freshness).toEqual({
      ageInCalendarDays: 2,
      sourceAsOf: '2026-08-14',
      status: 'stale',
    });
  });

  it('is deterministic for transfers, refunds, reservations, and calendar-day carry', () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 50_000, min: 0 }),
        fc.integer({ max: 20, min: 0 }),
        fc.integer({ max: 5_000, min: 0 }),
        fc.integer({ max: 5_000, min: 0 }),
        fc.integer({ max: 5_000, min: 0 }),
        (
          baseDailyAllowanceCents,
          daysBeforeToday,
          priorSpendCents,
          refundCents,
          reservationCents,
        ) => {
          const asOf = dateInAugust(daysBeforeToday + 1);
          const periodStart = dateInAugust(1);
          const baseInput = financeWorkspaceFixture({
            asOf,
            baseDailyAllowanceCents,
            cashBalanceCents: 1_000_000,
            movements: [
              {
                amountCents: priorSpendCents,
                date: periodStart,
                id: 'spend',
                kind: 'discretionary-spend',
              },
              { amountCents: refundCents, date: periodStart, id: 'refund', kind: 'refund' },
            ],
            periodStart,
            sourceAsOf: asOf,
          });
          const withTransfer = {
            ...baseInput,
            movements: [
              ...baseInput.movements,
              { amountCents: 999_999, date: asOf, id: 'transfer', kind: 'transfer' as const },
            ],
          };
          const withReservation = {
            ...baseInput,
            approvedReservations: [{ amountCents: reservationCents, id: 'goal', label: 'Goal' }],
          };

          const baseline = calculateFinanceWorkspace(baseInput);
          const transferSnapshot = calculateFinanceWorkspace(withTransfer);
          const reservationSnapshot = calculateFinanceWorkspace(withReservation);

          expect(transferSnapshot.carryCents).toBe(baseline.carryCents);
          expect(transferSnapshot.safeToSpendTodayCents).toBe(baseline.safeToSpendTodayCents);
          expect(baseline.carryCents).toBe(
            daysBeforeToday === 0
              ? 0
              : daysBeforeToday * baseDailyAllowanceCents - priorSpendCents + refundCents,
          );
          expect(reservationSnapshot.genuineAvailabilityCents).toBe(
            baseline.genuineAvailabilityCents - reservationCents,
          );
        },
      ),
    );
  });
});

function dateInAugust(day: number): string {
  return `2026-08-${String(day).padStart(2, '0')}`;
}
