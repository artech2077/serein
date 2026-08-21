import { describe, expect, it, vi } from 'vitest';

import {
  AiClassificationService,
  normalizeMerchantHint,
  type ClassificationProposalStore,
} from '../src/ai-classification.js';
import type { ClassificationSuggestion } from '../src/ai-gateway.js';

const candidates = [
  {
    amountCents: -1_250,
    bookingDate: '2026-08-21',
    sourceDescription: 'Cinema 123456 - alex@example.com',
    transactionId: 'transaction_1',
  },
  {
    amountCents: -9_000,
    bookingDate: '2026-08-22',
    sourceDescription: 'Bank transfer 123456',
    transactionId: 'transaction_2',
  },
] as const;

function store(): ClassificationProposalStore {
  return {
    acceptNonAllowanceAiSuggestion: vi.fn(async () => undefined),
    saveAiSuggestion: vi.fn(async () => undefined),
  };
}

function service(suggestions: ClassificationSuggestion[], proposalStore = store()) {
  return {
    proposalStore,
    service: new AiClassificationService(
      () => ({
        execute: vi.fn(async () => ({
          estimatedCostNanoEur: 1,
          model: 'gpt-5.6-luna' as const,
          output: { kind: 'routine_classification' as const, suggestions },
        })),
      }),
      proposalStore,
      { calibrationAccuracyThreshold: 0.8, highConfidenceThreshold: 0.9 },
    ),
  };
}

describe('AI classification safety', () => {
  it('does not persist suggestions before the representative calibration threshold is met', async () => {
    const { proposalStore, service: classification } = service([
      { classification: 'essential', confidence: 1, evidenceIndex: 0 },
      { classification: 'discretionary', confidence: 1, evidenceIndex: 1 },
      { classification: 'transfer', confidence: 1, evidenceIndex: 2 },
      { classification: 'transfer', confidence: 1, evidenceIndex: 3 },
      { classification: 'transfer', confidence: 1, evidenceIndex: 4 },
      { classification: 'discretionary', confidence: 0.99, evidenceIndex: 5 },
    ]);

    const result = await classification.propose(
      'auth0|person',
      'access-token',
      'attempt_1',
      candidates,
    );

    expect(result.calibration).toEqual({ accurateCount: 3, sampleCount: 5, thresholdMet: false });
    expect(proposalStore.saveAiSuggestion).not.toHaveBeenCalled();
    expect(proposalStore.acceptNonAllowanceAiSuggestion).not.toHaveBeenCalled();
  });

  it('keeps allowance-affecting and low-confidence classifications in review, while accepting a calibrated transfer', async () => {
    const { proposalStore, service: classification } = service([
      { classification: 'essential', confidence: 1, evidenceIndex: 0 },
      { classification: 'discretionary', confidence: 1, evidenceIndex: 1 },
      { classification: 'transfer', confidence: 1, evidenceIndex: 2 },
      { classification: 'essential', confidence: 1, evidenceIndex: 3 },
      { classification: 'discretionary', confidence: 1, evidenceIndex: 4 },
      { classification: 'essential', confidence: 0.95, evidenceIndex: 5 },
      { classification: 'transfer', confidence: 0.95, evidenceIndex: 6 },
    ]);

    const result = await classification.propose(
      'auth0|person',
      'access-token',
      'attempt_2',
      candidates,
    );

    expect(result).toMatchObject({
      acceptedTransactionIds: ['transaction_2'],
      proposedTransactionIds: ['transaction_1', 'transaction_2'],
    });
    expect(proposalStore.saveAiSuggestion).toHaveBeenCalledTimes(2);
    expect(proposalStore.acceptNonAllowanceAiSuggestion).toHaveBeenCalledWith(
      'auth0|person',
      'transaction_2',
      'access-token',
    );
  });

  it('removes identifiers and long numbers from the bounded merchant hint', () => {
    expect(normalizeMerchantHint('Cinema 123456 - alex@example.com')).toBe('cinema');
  });
});
