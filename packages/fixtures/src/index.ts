import type { FinanceWorkspaceInput } from '@serein/contracts';

export const emptyFinanceWorkspaceFixture = {
  accounts: [],
  generatedAt: '2026-08-16T00:00:00.000Z',
  transactions: [],
} as const;

export function financeWorkspaceFixture(
  overrides: Partial<FinanceWorkspaceInput> = {},
): FinanceWorkspaceInput {
  const fixture = {
    approvedReservations: [],
    asOf: '2026-08-16',
    baseDailyAllowanceCents: 2_000,
    cashBalanceCents: 100_000,
    deferredCardLiabilityCents: 0,
    movements: [],
    periodStart: '2026-08-01',
    safetyBufferCents: 10_000,
    ...overrides,
  };

  return {
    ...fixture,
    sourceAsOf: overrides.sourceAsOf ?? fixture.asOf,
  };
}
