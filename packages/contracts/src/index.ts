export const API_VERSION = 'v1' as const;

export interface HealthResponse {
  service: 'serein-api';
  version: typeof API_VERSION;
  status: 'ok';
}

export interface WorkspaceProjection {
  initialized: boolean;
  version: number;
  workspaceId: string;
}

export interface WorkspaceInitializeCommand {
  type: 'workspace.initialize';
}

export interface WorkspaceCommandRequest {
  command: WorkspaceInitializeCommand;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface WorkspaceCommandResponse {
  outcome: 'applied' | 'replayed';
  projection: WorkspaceProjection;
}

export interface ApiProblem {
  error: {
    code: string;
    detail: string;
    meta?: Record<string, string | number>;
  };
}

export type FinanceMovementKind = 'discretionary-spend' | 'refund' | 'transfer';

export interface FinanceMovement {
  amountCents: number;
  date: string;
  id: string;
  kind: FinanceMovementKind;
}

export interface ApprovedReservation {
  amountCents: number;
  id: string;
  label: string;
}

export interface FinanceWorkspaceInput {
  approvedReservations: readonly ApprovedReservation[];
  asOf: string;
  baseDailyAllowanceCents: number;
  cashBalanceCents: number;
  deferredCardLiabilityCents: number;
  movements: readonly FinanceMovement[];
  periodStart: string;
  safetyBufferCents: number;
  sourceAsOf: string;
}

export interface FinanceWorkspaceExplanation {
  amountCents: number;
  code:
    | 'cash_balance'
    | 'deferred_card_liability'
    | 'approved_reservations'
    | 'safety_buffer'
    | 'base_daily_allowance'
    | 'carry'
    | 'today_discretionary_spend'
    | 'genuine_availability_cap';
  label: string;
}

export interface FinanceWorkspaceFreshness {
  ageInCalendarDays: number;
  sourceAsOf: string;
  status: 'current' | 'stale';
}

export interface FinanceWorkspaceSnapshot {
  baseAllowanceCents: number;
  carryCents: number;
  components: {
    approvedReservationCents: number;
    cashBalanceCents: number;
    deferredCardLiabilityCents: number;
    discretionarySpendBeforeTodayCents: number;
    discretionarySpendTodayCents: number;
    safetyBufferCents: number;
  };
  explanations: readonly FinanceWorkspaceExplanation[];
  freshness: FinanceWorkspaceFreshness;
  genuineAvailabilityCents: number;
  safeToSpendTodayCents: number;
}
