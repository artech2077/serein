import type {
  FinanceMovement,
  FinanceWorkspaceExplanation,
  FinanceWorkspaceInput,
  FinanceWorkspaceSnapshot,
} from '@serein/contracts';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Calculates Serein's authoritative daily finance projection. Money values are integer cents;
 * clients render this result but must not recalculate it.
 */
export function calculateFinanceWorkspace(input: FinanceWorkspaceInput): FinanceWorkspaceSnapshot {
  validateInput(input);

  const daysBeforeToday = calendarDaysBetween(input.periodStart, input.asOf);
  const approvedReservationCents = sum(input.approvedReservations.map((item) => item.amountCents));
  const discretionarySpendBeforeTodayCents = sum(
    input.movements
      .filter((movement) => movement.date >= input.periodStart && movement.date < input.asOf)
      .map(discretionaryImpact),
  );
  const discretionarySpendTodayCents = sum(
    input.movements.filter((movement) => movement.date === input.asOf).map(discretionaryImpact),
  );
  const carryCents =
    daysBeforeToday * input.baseDailyAllowanceCents - discretionarySpendBeforeTodayCents;
  const genuineAvailabilityCents =
    input.cashBalanceCents -
    input.deferredCardLiabilityCents -
    approvedReservationCents -
    input.safetyBufferCents;
  const allowanceBeforeAvailabilityCapCents =
    input.baseDailyAllowanceCents + carryCents - discretionarySpendTodayCents;
  const safeToSpendTodayCents = Math.max(
    0,
    Math.min(allowanceBeforeAvailabilityCapCents, genuineAvailabilityCents),
  );
  const freshnessAge = calendarDaysBetween(input.sourceAsOf, input.asOf);

  return {
    baseAllowanceCents: input.baseDailyAllowanceCents,
    carryCents,
    components: {
      approvedReservationCents,
      cashBalanceCents: input.cashBalanceCents,
      deferredCardLiabilityCents: input.deferredCardLiabilityCents,
      discretionarySpendBeforeTodayCents,
      discretionarySpendTodayCents,
      safetyBufferCents: input.safetyBufferCents,
    },
    explanations: explanations({
      allowanceBeforeAvailabilityCapCents,
      approvedReservationCents,
      carryCents,
      discretionarySpendTodayCents,
      genuineAvailabilityCents,
      input,
    }),
    freshness: {
      ageInCalendarDays: freshnessAge,
      sourceAsOf: input.sourceAsOf,
      status: freshnessAge === 0 ? 'current' : 'stale',
    },
    genuineAvailabilityCents,
    safeToSpendTodayCents,
  };
}

function explanations({
  allowanceBeforeAvailabilityCapCents,
  approvedReservationCents,
  carryCents,
  discretionarySpendTodayCents,
  genuineAvailabilityCents,
  input,
}: {
  allowanceBeforeAvailabilityCapCents: number;
  approvedReservationCents: number;
  carryCents: number;
  discretionarySpendTodayCents: number;
  genuineAvailabilityCents: number;
  input: FinanceWorkspaceInput;
}): readonly FinanceWorkspaceExplanation[] {
  const result: FinanceWorkspaceExplanation[] = [
    { amountCents: input.cashBalanceCents, code: 'cash_balance', label: 'Cash balance' },
    {
      amountCents: -input.deferredCardLiabilityCents,
      code: 'deferred_card_liability',
      label: 'Deferred-card liability',
    },
    {
      amountCents: -approvedReservationCents,
      code: 'approved_reservations',
      label: 'Approved reservations',
    },
    { amountCents: -input.safetyBufferCents, code: 'safety_buffer', label: 'Safety buffer' },
    {
      amountCents: input.baseDailyAllowanceCents,
      code: 'base_daily_allowance',
      label: 'Base daily allowance',
    },
    { amountCents: carryCents, code: 'carry', label: 'Carry from earlier days' },
    {
      amountCents: -discretionarySpendTodayCents,
      code: 'today_discretionary_spend',
      label: 'Today’s discretionary spending',
    },
  ];

  if (allowanceBeforeAvailabilityCapCents > genuineAvailabilityCents) {
    result.push({
      amountCents: genuineAvailabilityCents - allowanceBeforeAvailabilityCapCents,
      code: 'genuine_availability_cap',
      label: 'Limited by genuine availability',
    });
  }

  return result;
}

function discretionaryImpact(movement: FinanceMovement): number {
  if (movement.kind === 'discretionary-spend') {
    return movement.amountCents;
  }

  if (movement.kind === 'refund') {
    return -movement.amountCents;
  }

  return 0;
}

function validateInput(input: FinanceWorkspaceInput): void {
  const dates = [input.periodStart, input.asOf, input.sourceAsOf];

  for (const date of dates) {
    parseCalendarDate(date);
  }

  if (input.periodStart > input.asOf) {
    throw new Error('The finance period cannot start after the calculation date.');
  }

  if (input.sourceAsOf > input.asOf) {
    throw new Error('Financial data cannot be fresher than the calculation date.');
  }

  for (const value of [
    input.baseDailyAllowanceCents,
    input.cashBalanceCents,
    input.deferredCardLiabilityCents,
    input.safetyBufferCents,
    ...input.approvedReservations.map((item) => item.amountCents),
    ...input.movements.map((item) => item.amountCents),
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Finance workspace money values must be non-negative integer cents.');
    }
  }

  for (const movement of input.movements) {
    parseCalendarDate(movement.date);
  }
}

function calendarDaysBetween(start: string, end: string): number {
  return (
    (parseCalendarDate(end).getTime() - parseCalendarDate(start).getTime()) / MILLISECONDS_PER_DAY
  );
}

function parseCalendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  return date;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
