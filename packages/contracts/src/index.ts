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

export type AccountCoverageState = 'imported' | 'manual' | 'excluded' | 'missing';

export interface CsvColumnMapping {
  amountColumn: string;
  dateColumn: string;
  descriptionColumn: string;
}

export interface CsvImportRequest {
  accountExternalId: string;
  accountName: string;
  csv: string;
  idempotencyKey: string;
  mapping?: CsvColumnMapping;
}

export interface CsvImportResult {
  accountId: string;
  importedTransactionCount: number;
  outcome: 'applied' | 'replayed';
  skippedDuplicateTransactionCount: number;
  sourceAsOf: string;
}

export interface AccountCoverage {
  accountExternalId: string;
  accountName: string;
  lastImportedAt?: number;
  sourceAsOf?: string;
  state: AccountCoverageState;
}

export interface AllowanceCoverage {
  accounts: readonly AccountCoverage[];
  allowanceQualified: boolean;
  missingAccountExternalIds: readonly string[];
}

export type ConfirmedTransactionClassification =
  'discretionary' | 'essential' | 'transfer' | 'refund';

export interface MaterialReviewItem {
  aiClassification?: ConfirmedTransactionClassification;
  aiConfidence?: number;
  amountCents: number;
  bookingDate: string;
  sourceDescription: string;
  transactionId: string;
}

export interface MaterialReviewQueue {
  items: readonly MaterialReviewItem[];
  unresolvedDebitCents: number;
}

export interface QuickAddRequest {
  accountExternalId: string;
  amountCents: number;
  bookingDate: string;
  idempotencyKey: string;
  sourceDescription: string;
}

export interface QuickAddPreview {
  allowanceImpactCents: number;
}

export interface PendingQuickAdd {
  amountCents: number;
  bookingDate: string;
  quickAddId: string;
  sourceDescription: string;
  state: 'provisional' | 'review_required';
}

export interface DeferredCardPurchaseRequest {
  amountCents: number;
  cardExternalId: string;
  expectedSettlementEnd: string;
  expectedSettlementStart: string;
  idempotencyKey: string;
  purchaseDate: string;
  purchaseExternalId: string;
  settlementAccountExternalId: string;
  sourceDescription: string;
}

export interface DeferredCardSettlementAllocation {
  amountCents: number;
  purchaseExternalId: string;
}

export interface DeferredCardSettlementRequest {
  allocations: readonly DeferredCardSettlementAllocation[];
  amountCents: number;
  cardExternalId: string;
  idempotencyKey: string;
  settlementAccountExternalId: string;
  settlementDate: string;
  settlementExternalId: string;
  sourceDescription: string;
}

export interface DeferredCardSummary {
  cumulativePurchaseCents: number;
  outstandingLiabilityCents: number;
  reviewRequiredSettlementCount: number;
}

export interface DatedCashFlowEvent {
  amountCents: number;
  date: string;
  kind: 'income' | 'obligation';
}

export interface GoalReservationCommand {
  cashFlow: {
    events: readonly DatedCashFlowEvent[];
    openingCashCents: number;
    safetyBufferCents: number;
  };
  goalExternalId: string;
  idempotencyKey: string;
  label: string;
  priority: number;
  reservationAmountCents: number;
  reservationDate: string;
  targetCents: number;
  targetDate: string;
}

export interface CashFlowSafetyResult {
  firstUnsafeDate?: string;
  lowestBalanceCents: number;
  safe: boolean;
}

export type MonthlyPlanState = 'awaiting_approval' | 'active' | 'revision_proposed';

export type SalaryStatus = 'forecast' | 'received' | 'late_conservative';

export interface MonthlyPlanProposalCommand {
  expectedSalaryEnd: string;
  expectedSalaryStart: string;
  forecastSalaryCents: number;
  idempotencyKey: string;
  month: string;
  proposedBaseDailyAllowanceCents: number;
  receivedIncomeCents?: number;
}

export interface MonthlyPlanRevisionCommand {
  idempotencyKey: string;
  materialEventId: string;
  minimumMaterialChangeCents: number;
  month: string;
  proposedBaseDailyAllowanceCents: number;
  version: number;
}

export interface MonthlyPlanProjection {
  approvedBaseDailyAllowanceCents?: number;
  month: string;
  proposedBaseDailyAllowanceCents: number;
  salary: {
    conservativeIncomeCents: number;
    expectedSalaryEnd: string;
    expectedSalaryStart: string;
    forecastSalaryCents: number;
    receivedIncomeCents?: number;
    status: SalaryStatus;
  };
  state: MonthlyPlanState;
  version: number;
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
