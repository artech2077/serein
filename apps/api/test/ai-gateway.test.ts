import { describe, expect, it, vi } from 'vitest';

import {
  AiBudgetExceededError,
  AiGateway,
  AiGatewayUnavailableError,
  InMemoryAiUsageLedger,
  OpenAiResponsesClient,
  type ResponsesApiClient,
} from '../src/ai-gateway.js';

const config = {
  monthlyBudgetNanoEur: 5_000_000_000,
  monthlyPlanningReserveNanoEur: 500_000_000,
  now: () => new Date('2026-09-12T10:00:00.000Z'),
};

function command(overrides: Record<string, unknown> = {}) {
  return {
    evidence: [{ amountCents: 1_200, date: '2026-09-12', kind: 'expense' as const }],
    requestId: 'classification-1',
    subject: 'auth0|person-with-private-identity',
    task: 'routine_classification' as const,
    ...overrides,
  };
}

function client(outputText: string): ResponsesApiClient {
  return { create: vi.fn(async () => ({ outputText })) };
}

describe('AI gateway', () => {
  it('calls the Responses API server-side with storage disabled', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output: [{ content: [{ text: '{"suggestions":[]}', type: 'output_text' }] }],
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
          { status: 200 },
        ),
    );
    const responses = new OpenAiResponsesClient('server-key', fetchImpl as typeof fetch);

    await expect(
      responses.create({
        input: '{"task":"routine_classification"}',
        maxOutputTokens: 600,
        model: 'gpt-5.6-luna',
        reasoning: { effort: 'low' },
        safetyIdentifier: 'serein_opaque',
        store: false,
        text: {
          format: {
            name: 'classification_suggestions',
            schema: {},
            strict: true,
            type: 'json_schema',
          },
        },
      }),
    ).resolves.toEqual({
      outputText: '{"suggestions":[]}',
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer server-key' }),
        method: 'POST',
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      text: { format: { strict: true, type: 'json_schema' } },
    });
  });

  it('sends only pseudonymous normalized evidence to a non-stored structured Luna response', async () => {
    const responses = client(
      JSON.stringify({
        suggestions: [{ classification: 'discretionary', confidence: 0.92, evidenceIndex: 0 }],
      }),
    );
    const gateway = new AiGateway(
      responses,
      new InMemoryAiUsageLedger(config.monthlyBudgetNanoEur, config.monthlyPlanningReserveNanoEur),
      config,
    );

    const result = await gateway.execute(command());
    const request = vi.mocked(responses.create).mock.calls[0][0];

    expect(result).toMatchObject({ model: 'gpt-5.6-luna' });
    expect(request).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoning: { effort: 'low' },
      store: false,
      text: { format: { strict: true, type: 'json_schema' } },
    });
    expect(request.input).not.toContain('auth0|person-with-private-identity');
    expect(request.input).toContain('evidence_1');
    expect(request.safetyIdentifier).not.toContain('person-with-private-identity');
  });

  it('uses Terra and medium reasoning for the bounded monthly-planning task', async () => {
    const responses = client(
      JSON.stringify({
        suggestions: [
          {
            evidenceIndexes: [0],
            kind: 'risk',
            proposedChange: { action: 'review', target: 'monthly_plan' },
            summary: 'Known bill precedes income.',
          },
        ],
      }),
    );
    const gateway = new AiGateway(
      responses,
      new InMemoryAiUsageLedger(config.monthlyBudgetNanoEur, config.monthlyPlanningReserveNanoEur),
      config,
    );

    const result = await gateway.execute(
      command({ requestId: 'plan-1', task: 'monthly_planning' }),
    );

    expect(result).toMatchObject({
      model: 'gpt-5.6-terra',
      output: {
        suggestions: [{ proposedChange: { action: 'review', target: 'monthly_plan' } }],
      },
    });
    expect(vi.mocked(responses.create).mock.calls[0][0]).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoning: { effort: 'medium' },
    });
  });

  it('reserves planning capacity before optional work and charges a failed request conservatively', async () => {
    const ledger = new InMemoryAiUsageLedger(20_000, 10_000);
    const responses: ResponsesApiClient = {
      create: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    const gateway = new AiGateway(responses, ledger, {
      monthlyBudgetNanoEur: 20_000,
      monthlyPlanningReserveNanoEur: 10_000,
      now: config.now,
    });

    await expect(gateway.execute(command({ requestId: 'too-expensive' }))).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
    expect(ledger.spentNanoEur('auth0|person-with-private-identity', '2026-09')).toBe(0);

    const usableLedger = new InMemoryAiUsageLedger(
      config.monthlyBudgetNanoEur,
      config.monthlyPlanningReserveNanoEur,
    );
    const failedGateway = new AiGateway(responses, usableLedger, config);
    await expect(failedGateway.execute(command({ requestId: 'outage' }))).rejects.toBeInstanceOf(
      AiGatewayUnavailableError,
    );
    expect(
      usableLedger.spentNanoEur('auth0|person-with-private-identity', '2026-09'),
    ).toBeGreaterThan(0);
  });
});
