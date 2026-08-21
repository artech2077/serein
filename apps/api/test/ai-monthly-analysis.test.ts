import { describe, expect, it, vi } from 'vitest';

import { AiMonthlyAnalysisService } from '../src/ai-monthly-analysis.js';

const evidence = [
  { amountCents: -12_000, date: '2026-09-03', evidenceId: 'goal_1', kind: 'goal' as const },
  { amountCents: -4_500, date: '2026-09-05', evidenceId: 'bill_1', kind: 'obligation' as const },
] as const;

describe('AI monthly analysis', () => {
  it('returns neutral, evidence-linked observations and review-only proposals', async () => {
    const execute = vi.fn(async () => ({
      estimatedCostNanoEur: 1,
      model: 'gpt-5.6-terra' as const,
      output: {
        kind: 'monthly_planning' as const,
        suggestions: [
          {
            evidenceIndexes: [0, 1],
            kind: 'risk' as const,
            proposedChange: { action: 'review' as const, target: 'goal' as const },
            summary: 'The supplied goal and bill occur before the next income evidence.',
          },
        ],
      },
    }));
    const service = new AiMonthlyAnalysisService(() => ({ execute }));

    await expect(service.analyze('auth0|person', 'token', 'monthly_1', evidence)).resolves.toEqual({
      items: [
        {
          evidenceIds: ['goal_1', 'bill_1'],
          kind: 'risk',
          proposedChange: { action: 'review', target: 'goal' },
          summary: 'The supplied goal and bill occur before the next income evidence.',
        },
      ],
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ evidence, task: 'monthly_planning' }),
    );
  });

  it('rejects an unbounded evidence request before calling the AI gateway', async () => {
    const execute = vi.fn();
    const service = new AiMonthlyAnalysisService(() => ({ execute }));
    await expect(service.analyze('auth0|person', 'token', 'monthly_2', [])).rejects.toThrow(
      'Monthly analysis requires bounded, identifiable evidence.',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
