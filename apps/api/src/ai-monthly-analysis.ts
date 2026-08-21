import type { AiEvidence, AiGateway, MonthlyPlanningSuggestion } from './ai-gateway.js';

export interface MonthlyAnalysisEvidence extends AiEvidence {
  evidenceId: string;
}

export interface MonthlyAnalysisItem {
  evidenceIds: readonly string[];
  kind: MonthlyPlanningSuggestion['kind'];
  proposedChange?: MonthlyPlanningSuggestion['proposedChange'];
  summary: string;
}

/**
 * Advisory-only monthly analysis. It maps every AI statement to supplied
 * evidence and returns review proposals; it deliberately has no mutation path.
 */
export class AiMonthlyAnalysisService {
  constructor(
    private readonly gatewayForAccessToken: (accessToken: string) => Pick<AiGateway, 'execute'>,
  ) {}

  async analyze(
    subject: string,
    accessToken: string,
    requestId: string,
    evidence: readonly MonthlyAnalysisEvidence[],
  ): Promise<{ items: readonly MonthlyAnalysisItem[] }> {
    validateEvidence(evidence);
    const result = await this.gatewayForAccessToken(accessToken).execute({
      evidence,
      requestId,
      subject,
      task: 'monthly_planning',
    });
    if (result.output.kind !== 'monthly_planning') throw new Error('Unexpected AI task output.');
    return {
      items: result.output.suggestions.map((suggestion) => ({
        evidenceIds: suggestion.evidenceIndexes.map((index) => evidence[index]?.evidenceId ?? ''),
        kind: suggestion.kind,
        proposedChange: suggestion.proposedChange,
        summary: suggestion.summary,
      })),
    };
  }
}

function validateEvidence(evidence: readonly MonthlyAnalysisEvidence[]) {
  if (
    evidence.length === 0 ||
    evidence.length > 100 ||
    evidence.some((item) => !/^[A-Za-z0-9._:-]{1,128}$/.test(item.evidenceId))
  ) {
    throw new Error('Monthly analysis requires bounded, identifiable evidence.');
  }
}
