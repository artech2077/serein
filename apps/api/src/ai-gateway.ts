import { createHash } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

export type AiTask = 'routine_classification' | 'monthly_planning';
export type AiEvidenceKind = 'income' | 'expense' | 'obligation' | 'goal' | 'reservation';

export interface AiEvidence {
  amountCents: number;
  date: string;
  kind: AiEvidenceKind;
  merchantHint?: string;
}

export interface AiGatewayCommand {
  evidence: readonly AiEvidence[];
  requestId: string;
  subject: string;
  task: AiTask;
}

export interface ClassificationSuggestion {
  classification: 'discretionary' | 'essential' | 'income' | 'refund' | 'transfer';
  confidence: number;
  evidenceIndex: number;
}

export interface MonthlyPlanningSuggestion {
  evidenceIndexes: readonly number[];
  kind: 'observation' | 'recommendation' | 'risk';
  summary: string;
}

export type AiGatewayOutput =
  | { kind: 'routine_classification'; suggestions: readonly ClassificationSuggestion[] }
  | { kind: 'monthly_planning'; suggestions: readonly MonthlyPlanningSuggestion[] };

export interface ResponsesApiRequest {
  input: string;
  instructions?: string;
  maxOutputTokens: number;
  model: 'gpt-5.6-luna' | 'gpt-5.6-terra';
  reasoning: { effort: 'low' | 'medium' };
  safetyIdentifier: string;
  store: false;
  text: {
    format: {
      name: string;
      schema: Record<string, unknown>;
      strict: true;
      type: 'json_schema';
    };
  };
}

export interface ResponsesApiResult {
  outputText: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ResponsesApiClient {
  create(request: ResponsesApiRequest): Promise<ResponsesApiResult>;
}

export interface AiUsageLedger {
  commit(reservation: AiUsageReservation): Promise<void>;
  reserve(request: AiUsageReservationRequest): Promise<AiUsageReservation>;
}

export interface AiUsageReservationRequest {
  estimatedCostNanoEur: number;
  month: string;
  requestId: string;
  subject: string;
  task: AiTask;
}

export interface AiUsageReservation extends AiUsageReservationRequest {
  replayed: boolean;
}

export interface AiGatewayConfig {
  monthlyBudgetNanoEur: number;
  monthlyPlanningReserveNanoEur: number;
  now?: () => Date;
}

export class AiBudgetExceededError extends Error {
  constructor(message = 'AI budget capacity is reserved for the next monthly planning run.') {
    super(message);
    this.name = 'AiBudgetExceededError';
  }
}

export class AiGatewayUnavailableError extends Error {
  constructor(
    message = 'The AI service is unavailable. Your approved finance state is unchanged.',
  ) {
    super(message);
    this.name = 'AiGatewayUnavailableError';
  }
}

export class AiStructuredOutputError extends Error {
  constructor() {
    super('The AI response did not match the required structured result.');
    this.name = 'AiStructuredOutputError';
  }
}

const modelByTask = {
  monthly_planning: 'gpt-5.6-terra',
  routine_classification: 'gpt-5.6-luna',
} as const;
const maxOutputTokensByTask = { monthly_planning: 1_500, routine_classification: 600 } as const;
const priceNanoEurPerToken = {
  'gpt-5.6-luna': { input: 200, output: 1_200 },
  'gpt-5.6-terra': { input: 2_000, output: 12_000 },
} as const;

const classificationSchema = {
  additionalProperties: false,
  properties: {
    suggestions: {
      items: {
        additionalProperties: false,
        properties: {
          classification: {
            enum: ['discretionary', 'essential', 'income', 'refund', 'transfer'],
            type: 'string',
          },
          confidence: { maximum: 1, minimum: 0, type: 'number' },
          evidenceIndex: { minimum: 0, type: 'integer' },
        },
        required: ['evidenceIndex', 'classification', 'confidence'],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['suggestions'],
  type: 'object',
};
const monthlyPlanningSchema = {
  additionalProperties: false,
  properties: {
    suggestions: {
      items: {
        additionalProperties: false,
        properties: {
          evidenceIndexes: { items: { minimum: 0, type: 'integer' }, type: 'array' },
          kind: { enum: ['observation', 'recommendation', 'risk'], type: 'string' },
          summary: { type: 'string' },
        },
        required: ['kind', 'summary', 'evidenceIndexes'],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['suggestions'],
  type: 'object',
};

/**
 * Bounded gateway for advisory AI. It deliberately has no authority to create
 * or change a finance workspace, plan, goal, reservation, or allowance.
 */
export class AiGateway {
  private readonly now: () => Date;

  constructor(
    private readonly client: ResponsesApiClient,
    private readonly ledger: AiUsageLedger,
    private readonly config: AiGatewayConfig,
  ) {
    this.now = config.now ?? (() => new Date());
    if (
      !validPositiveInteger(config.monthlyBudgetNanoEur) ||
      !validNonNegativeInteger(config.monthlyPlanningReserveNanoEur) ||
      config.monthlyPlanningReserveNanoEur > config.monthlyBudgetNanoEur
    )
      throw new Error('Invalid AI budget configuration.');
  }

  async execute(command: AiGatewayCommand): Promise<{
    estimatedCostNanoEur: number;
    model: 'gpt-5.6-luna' | 'gpt-5.6-terra';
    output: AiGatewayOutput;
  }> {
    validateCommand(command);
    const request = toResponsesRequest(command);
    const reservation = await this.ledger.reserve({
      estimatedCostNanoEur: estimatedCostNanoEur(request),
      month: monthFor(this.now()),
      requestId: command.requestId,
      subject: command.subject,
      task: command.task,
    });
    if (reservation.replayed)
      throw new AiGatewayUnavailableError('This AI request was already completed or attempted.');

    try {
      const response = await this.client.create(request);
      const output = parseOutput(command.task, response.outputText, command.evidence.length);
      await this.ledger.commit(reservation);
      return {
        estimatedCostNanoEur: reservation.estimatedCostNanoEur,
        model: request.model,
        output,
      };
    } catch (error) {
      // A network failure can still have reached OpenAI. Commit the conservative
      // reservation so retries cannot accidentally spend through the cap.
      await this.ledger.commit(reservation);
      if (error instanceof AiStructuredOutputError || error instanceof AiGatewayUnavailableError)
        throw error;
      throw new AiGatewayUnavailableError();
    }
  }
}

/**
 * A deterministic ledger for the gateway boundary. Production wiring can
 * replace it with a durable adapter without changing routing or budgeting.
 */
export class InMemoryAiUsageLedger implements AiUsageLedger {
  private readonly reservations = new Map<string, AiUsageReservation>();
  private readonly spentByWindow = new Map<string, number>();

  constructor(
    private readonly monthlyBudgetNanoEur: number,
    private readonly monthlyPlanningReserveNanoEur: number,
  ) {}

  async reserve(request: AiUsageReservationRequest): Promise<AiUsageReservation> {
    const key = reservationKey(request);
    const existing = this.reservations.get(key);
    if (existing) return { ...existing, replayed: true };

    const windowKey = usageWindowKey(request.subject, request.month);
    const spent = this.spentByWindow.get(windowKey) ?? 0;
    const reserved = [...this.reservations.values()]
      .filter((item) => item.subject === request.subject && item.month === request.month)
      .reduce((total, item) => total + item.estimatedCostNanoEur, 0);
    const remainingAfterRequest =
      this.monthlyBudgetNanoEur - spent - reserved - request.estimatedCostNanoEur;
    const requiredReserve =
      request.task === 'monthly_planning' ? 0 : this.monthlyPlanningReserveNanoEur;
    if (remainingAfterRequest < requiredReserve) throw new AiBudgetExceededError();

    const reservation = { ...request, replayed: false };
    this.reservations.set(key, reservation);
    return reservation;
  }

  async commit(reservation: AiUsageReservation): Promise<void> {
    if (reservation.replayed) return;
    const windowKey = usageWindowKey(reservation.subject, reservation.month);
    const key = reservationKey(reservation);
    if (!this.reservations.has(key)) return;
    this.spentByWindow.set(
      windowKey,
      (this.spentByWindow.get(windowKey) ?? 0) + reservation.estimatedCostNanoEur,
    );
    this.reservations.delete(key);
  }

  spentNanoEur(subject: string, month: string) {
    return this.spentByWindow.get(usageWindowKey(subject, month)) ?? 0;
  }
}

type ConvexReservationResult =
  | { replayed: boolean; reservationId: string; type: 'reserved' }
  | { type: 'budget_exceeded' }
  | { type: 'idempotency_key_conflict' }
  | { type: 'reservation_not_found' };
type ConvexReservationRequest = AiUsageReservationRequest &
  Record<string, unknown> & {
    monthlyBudgetNanoEur: number;
    monthlyPlanningReserveNanoEur: number;
  };
const reserveAiUsage = makeFunctionReference<
  'mutation',
  ConvexReservationRequest,
  ConvexReservationResult
>('ai_usage:reserve');
const commitAiUsage = makeFunctionReference<
  'mutation',
  { requestId: string } & Record<string, unknown>,
  ConvexReservationResult
>('ai_usage:commit');

/** Durable, user-scoped AI budget ledger for API requests carrying an Auth0 token. */
export class ConvexAiUsageLedger implements AiUsageLedger {
  constructor(
    private readonly convexUrl: string,
    private readonly accessToken: string,
    private readonly monthlyBudgetNanoEur: number,
    private readonly monthlyPlanningReserveNanoEur: number,
  ) {}

  async reserve(request: AiUsageReservationRequest): Promise<AiUsageReservation> {
    const result = await this.client().mutation(reserveAiUsage, {
      ...request,
      monthlyBudgetNanoEur: this.monthlyBudgetNanoEur,
      monthlyPlanningReserveNanoEur: this.monthlyPlanningReserveNanoEur,
    });
    if (result.type === 'budget_exceeded') throw new AiBudgetExceededError();
    if (result.type === 'idempotency_key_conflict')
      throw new AiGatewayUnavailableError(
        'This AI request identifier conflicts with another request.',
      );
    if (result.type === 'reservation_not_found') throw new AiGatewayUnavailableError();
    return { ...request, replayed: result.replayed };
  }

  async commit(reservation: AiUsageReservation): Promise<void> {
    const result = await this.client().mutation(commitAiUsage, {
      requestId: reservation.requestId,
    });
    if (result.type !== 'reserved')
      throw new AiGatewayUnavailableError('The AI budget reservation was lost.');
  }

  private client() {
    return new ConvexHttpClient(this.convexUrl, { auth: this.accessToken, logger: false });
  }
}

/** A small server-side client for the Responses API; callers never expose the key to a client. */
export class OpenAiResponsesClient implements ResponsesApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async create(request: ResponsesApiRequest): Promise<ResponsesApiResult> {
    const response = await this.fetchImpl('https://api.openai.com/v1/responses', {
      body: JSON.stringify({
        input: request.input,
        instructions: request.instructions,
        max_output_tokens: request.maxOutputTokens,
        model: request.model,
        reasoning: request.reasoning,
        safety_identifier: request.safetyIdentifier,
        store: request.store,
        text: request.text,
      }),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new AiGatewayUnavailableError();
    const outputText = outputTextFrom(body);
    if (!outputText)
      throw new AiGatewayUnavailableError('The AI service returned no text response.');
    return { outputText, usage: usageFrom(body) };
  }
}

function toResponsesRequest(command: AiGatewayCommand): ResponsesApiRequest {
  const model = modelByTask[command.task];
  return {
    input: JSON.stringify({
      evidence: command.evidence.map((item, index) => ({
        amountCents: item.amountCents,
        date: item.date,
        kind: item.kind,
        merchantHint: item.merchantHint,
        reference: `evidence_${index + 1}`,
      })),
      task: command.task,
    }),
    instructions:
      command.task === 'routine_classification'
        ? 'Classify each normalized transaction evidence item. Return only the requested JSON. Use the supplied classification labels; do not infer personal details or explain your answer.'
        : 'Provide only the requested JSON planning suggestions. Do not make changes or claim that any plan has been approved.',
    maxOutputTokens: maxOutputTokensByTask[command.task],
    model,
    reasoning: { effort: command.task === 'monthly_planning' ? 'medium' : 'low' },
    safetyIdentifier: pseudonymousSafetyIdentifier(command.subject),
    store: false,
    text: {
      format: {
        name:
          command.task === 'monthly_planning'
            ? 'monthly_planning_suggestions'
            : 'classification_suggestions',
        schema: command.task === 'monthly_planning' ? monthlyPlanningSchema : classificationSchema,
        strict: true,
        type: 'json_schema',
      },
    },
  };
}

function estimatedCostNanoEur(request: ResponsesApiRequest) {
  const pricing = priceNanoEurPerToken[request.model];
  // One input character per token is intentionally conservative for the
  // normalized JSON payload. Output is reserved at the configured hard cap.
  return request.input.length * pricing.input + request.maxOutputTokens * pricing.output;
}

function parseOutput(task: AiTask, text: string, evidenceCount: number): AiGatewayOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AiStructuredOutputError();
  }
  if (!isRecord(value) || !Array.isArray(value.suggestions)) throw new AiStructuredOutputError();
  if (task === 'routine_classification') {
    const suggestions = value.suggestions.map((item) => parseClassification(item, evidenceCount));
    return { kind: task, suggestions };
  }
  const suggestions = value.suggestions.map((item) => parseMonthlySuggestion(item, evidenceCount));
  return { kind: task, suggestions };
}

function parseClassification(value: unknown, evidenceCount: number): ClassificationSuggestion {
  if (
    !isRecord(value) ||
    !validEvidenceIndex(value.evidenceIndex, evidenceCount) ||
    !isClassification(value.classification) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  )
    throw new AiStructuredOutputError();
  return {
    classification: value.classification,
    confidence: value.confidence,
    evidenceIndex: value.evidenceIndex,
  };
}

function parseMonthlySuggestion(value: unknown, evidenceCount: number): MonthlyPlanningSuggestion {
  if (
    !isRecord(value) ||
    !isMonthlyKind(value.kind) ||
    typeof value.summary !== 'string' ||
    value.summary.trim().length === 0 ||
    !Array.isArray(value.evidenceIndexes) ||
    !value.evidenceIndexes.every((index) => validEvidenceIndex(index, evidenceCount))
  )
    throw new AiStructuredOutputError();
  return { evidenceIndexes: value.evidenceIndexes, kind: value.kind, summary: value.summary };
}

function validateCommand(value: AiGatewayCommand) {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId) ||
    value.subject.trim().length === 0 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.length > 100 ||
    value.evidence.some(
      (item) =>
        !Number.isSafeInteger(item.amountCents) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
        !isEvidenceKind(item.kind) ||
        (item.merchantHint !== undefined &&
          (item.merchantHint.trim().length === 0 || item.merchantHint.length > 80)),
    )
  )
    throw new Error('Invalid bounded AI request.');
}

function outputTextFrom(body: Record<string, unknown>) {
  if (typeof body.output_text === 'string') return body.output_text;
  if (!Array.isArray(body.output)) return undefined;
  for (const item of body.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string')
        return content.text;
    }
  }
  return undefined;
}

function usageFrom(body: Record<string, unknown>) {
  if (!isRecord(body.usage)) return undefined;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = body.usage;
  return typeof inputTokens === 'number' && typeof outputTokens === 'number'
    ? { inputTokens, outputTokens }
    : undefined;
}

function monthFor(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    month: '2-digit',
    timeZone: 'Europe/Paris',
    year: 'numeric',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Unable to determine the current AI budget month.');
  return `${year}-${month}`;
}

function pseudonymousSafetyIdentifier(subject: string) {
  return `serein_${createHash('sha256').update(subject).digest('hex').slice(0, 48)}`;
}
function usageWindowKey(subject: string, month: string) {
  return `${subject}\u001f${month}`;
}
function reservationKey(value: Pick<AiUsageReservationRequest, 'month' | 'requestId' | 'subject'>) {
  return `${value.subject}\u001f${value.month}\u001f${value.requestId}`;
}
function validEvidenceIndex(value: unknown, evidenceCount: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < evidenceCount
  );
}
function validPositiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
function validNonNegativeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isClassification(value: unknown): value is ClassificationSuggestion['classification'] {
  return (
    value === 'discretionary' ||
    value === 'essential' ||
    value === 'income' ||
    value === 'refund' ||
    value === 'transfer'
  );
}
function isMonthlyKind(value: unknown): value is MonthlyPlanningSuggestion['kind'] {
  return value === 'observation' || value === 'recommendation' || value === 'risk';
}
function isEvidenceKind(value: unknown): value is AiEvidenceKind {
  return (
    value === 'income' ||
    value === 'expense' ||
    value === 'obligation' ||
    value === 'goal' ||
    value === 'reservation'
  );
}
