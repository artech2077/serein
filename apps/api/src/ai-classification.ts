import type { AiEvidence, AiGateway, ClassificationSuggestion } from './ai-gateway.js';

type AiClassificationGateway = Pick<AiGateway, 'execute'>;

export type AiClassification = Exclude<ClassificationSuggestion['classification'], 'income'>;

export interface ClassificationCandidate {
  amountCents: number;
  bookingDate: string;
  sourceDescription: string;
  transactionId: string;
}

export interface ClassificationProposal {
  classification: AiClassification;
  confidence: number;
  transactionId: string;
}

export interface ClassificationProposalStore {
  acceptNonAllowanceAiSuggestion(
    subject: string,
    transactionId: string,
    accessToken: string,
  ): Promise<void>;
  saveAiSuggestion(
    subject: string,
    transactionId: string,
    proposal: ClassificationProposal,
    accessToken: string,
  ): Promise<void>;
}

export interface AiClassificationConfig {
  calibrationAccuracyThreshold: number;
  calibrationSet?: readonly CalibrationCase[];
  highConfidenceThreshold: number;
}

export interface CalibrationCase {
  amountCents: number;
  bookingDate: string;
  expectedClassification: AiClassification;
  merchantHint: string;
}

export interface AiClassificationResult {
  acceptedTransactionIds: readonly string[];
  calibration: { accurateCount: number; sampleCount: number; thresholdMet: boolean };
  proposedTransactionIds: readonly string[];
}

const defaultCalibrationSet: readonly CalibrationCase[] = [
  {
    amountCents: -4_250,
    bookingDate: '2026-01-14',
    expectedClassification: 'essential',
    merchantHint: 'grocery market',
  },
  {
    amountCents: -1_299,
    bookingDate: '2026-01-16',
    expectedClassification: 'discretionary',
    merchantHint: 'cinema tickets',
  },
  {
    amountCents: -9_000,
    bookingDate: '2026-01-18',
    expectedClassification: 'transfer',
    merchantHint: 'bank transfer',
  },
  {
    amountCents: -2_450,
    bookingDate: '2026-01-20',
    expectedClassification: 'essential',
    merchantHint: 'electricity utility',
  },
  {
    amountCents: -650,
    bookingDate: '2026-01-22',
    expectedClassification: 'discretionary',
    merchantHint: 'coffee shop',
  },
];

/**
 * Uses the bounded gateway to propose classification, but only persists a
 * proposal after the same model response meets a representative calibration
 * threshold. This has no authority over allowance-bearing classifications.
 */
export class AiClassificationService {
  private readonly calibrationSet: readonly CalibrationCase[];

  constructor(
    private readonly gatewayForAccessToken: (accessToken: string) => AiClassificationGateway,
    private readonly store: ClassificationProposalStore,
    private readonly config: AiClassificationConfig,
  ) {
    if (
      !validFraction(config.calibrationAccuracyThreshold) ||
      !validFraction(config.highConfidenceThreshold)
    ) {
      throw new Error('Invalid AI classification threshold.');
    }
    this.calibrationSet = config.calibrationSet ?? defaultCalibrationSet;
    if (this.calibrationSet.length === 0) throw new Error('AI calibration data is required.');
  }

  async propose(
    subject: string,
    accessToken: string,
    requestId: string,
    candidates: readonly ClassificationCandidate[],
  ): Promise<AiClassificationResult> {
    if (candidates.length === 0 || candidates.length > 50) {
      throw new Error('Select between one and fifty transactions for AI classification.');
    }

    const evidence = [
      ...this.calibrationSet.map(toCalibrationEvidence),
      ...candidates.map(toCandidateEvidence),
    ];
    const result = await this.gatewayForAccessToken(accessToken).execute({
      evidence,
      requestId,
      subject,
      task: 'routine_classification',
    });
    if (result.output.kind !== 'routine_classification')
      throw new Error('Unexpected AI task output.');

    const calibration = evaluateCalibration(
      result.output.suggestions,
      this.calibrationSet,
      this.config.calibrationAccuracyThreshold,
    );
    if (!calibration.thresholdMet) {
      return { acceptedTransactionIds: [], calibration, proposedTransactionIds: [] };
    }

    const suggestions = indexSuggestions(result.output.suggestions);
    const proposedTransactionIds: string[] = [];
    const acceptedTransactionIds: string[] = [];
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const suggestion = suggestions.get(candidateIndex + this.calibrationSet.length);
      if (!suggestion || suggestion.classification === 'income') continue;
      const proposal = {
        classification: suggestion.classification,
        confidence: suggestion.confidence,
        transactionId: candidate.transactionId,
      } satisfies ClassificationProposal;
      await this.store.saveAiSuggestion(subject, candidate.transactionId, proposal, accessToken);
      proposedTransactionIds.push(candidate.transactionId);

      if (canAutoAccept(proposal, this.config.highConfidenceThreshold)) {
        await this.store.acceptNonAllowanceAiSuggestion(
          subject,
          candidate.transactionId,
          accessToken,
        );
        acceptedTransactionIds.push(candidate.transactionId);
      }
    }
    return { acceptedTransactionIds, calibration, proposedTransactionIds };
  }
}

export function normalizeMerchantHint(sourceDescription: string) {
  return sourceDescription
    .toLowerCase()
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
    .replace(/\b[a-z]{2}\d{2}[a-z0-9]{11,30}\b/gi, ' ')
    .replace(/(?:\+?\d[\s().-]*){8,}\d/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function toCalibrationEvidence(item: CalibrationCase): AiEvidence {
  return {
    amountCents: item.amountCents,
    date: item.bookingDate,
    kind: item.amountCents > 0 ? 'income' : 'expense',
    merchantHint: item.merchantHint,
  };
}

function toCandidateEvidence(item: ClassificationCandidate): AiEvidence {
  return {
    amountCents: item.amountCents,
    date: item.bookingDate,
    kind: item.amountCents > 0 ? 'income' : 'expense',
    merchantHint: normalizeMerchantHint(item.sourceDescription) || undefined,
  };
}

function evaluateCalibration(
  suggestions: readonly ClassificationSuggestion[],
  calibrationSet: readonly CalibrationCase[],
  threshold: number,
) {
  const indexed = indexSuggestions(suggestions);
  const accurateCount = calibrationSet.filter(
    (item, index) => indexed.get(index)?.classification === item.expectedClassification,
  ).length;
  const sampleCount = calibrationSet.length;
  return {
    accurateCount,
    sampleCount,
    thresholdMet: accurateCount / sampleCount >= threshold,
  };
}

function indexSuggestions(suggestions: readonly ClassificationSuggestion[]) {
  return new Map(suggestions.map((suggestion) => [suggestion.evidenceIndex, suggestion]));
}

function canAutoAccept(proposal: ClassificationProposal, highConfidenceThreshold: number) {
  return proposal.classification === 'transfer' && proposal.confidence >= highConfidenceThreshold;
}

function validFraction(value: number) {
  return Number.isFinite(value) && value > 0 && value <= 1;
}
