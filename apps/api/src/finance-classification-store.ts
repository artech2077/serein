import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

import type { ConfirmedTransactionClassification, MaterialReviewQueue } from '@serein/contracts';

export interface AiClassificationCandidate {
  amountCents: number;
  bookingDate: string;
  sourceDescription: string;
  transactionId: string;
}

const getMaterialReviewQueue = makeFunctionReference<
  'query',
  Record<string, never>,
  MaterialReviewQueue
>('classifications:getMaterialReviewQueue');
const confirmClassification = makeFunctionReference<
  'mutation',
  { classification: ConfirmedTransactionClassification; transactionId: string },
  { classification: ConfirmedTransactionClassification; transactionId: string }
>('classifications:confirmClassification');
const correctMerchant = makeFunctionReference<
  'mutation',
  {
    classification: ConfirmedTransactionClassification;
    scope: 'one_time' | 'retrospective' | 'prospective';
    transactionId: string;
  },
  { affectedTransactionCount: number; scope: 'one_time' | 'retrospective' | 'prospective' }
>('classifications:correctMerchant');
const getAiClassificationCandidates = makeFunctionReference<
  'query',
  { transactionIds: string[] },
  AiClassificationCandidate[]
>('classifications:getAiClassificationCandidates');
const saveAiSuggestion = makeFunctionReference<
  'mutation',
  { classification: ConfirmedTransactionClassification; confidence: number; transactionId: string },
  null
>('classifications:saveAiSuggestion');
const acceptNonAllowanceAiSuggestion = makeFunctionReference<
  'mutation',
  { transactionId: string },
  null
>('classifications:acceptNonAllowanceAiSuggestion');

export interface FinanceClassificationStore {
  acceptNonAllowanceAiSuggestion(
    subject: string,
    transactionId: string,
    accessToken?: string,
  ): Promise<void>;
  confirmClassification(
    subject: string,
    request: { classification: ConfirmedTransactionClassification; transactionId: string },
    accessToken?: string,
  ): Promise<{ classification: ConfirmedTransactionClassification; transactionId: string }>;
  correctMerchant(
    subject: string,
    request: {
      classification: ConfirmedTransactionClassification;
      scope: 'one_time' | 'retrospective' | 'prospective';
      transactionId: string;
    },
    accessToken?: string,
  ): Promise<{
    affectedTransactionCount: number;
    scope: 'one_time' | 'retrospective' | 'prospective';
  }>;
  getMaterialReviewQueue(subject: string, accessToken?: string): Promise<MaterialReviewQueue>;
  getAiClassificationCandidates(
    subject: string,
    transactionIds: string[],
    accessToken?: string,
  ): Promise<AiClassificationCandidate[]>;
  saveAiSuggestion(
    subject: string,
    request: {
      classification: ConfirmedTransactionClassification;
      confidence: number;
      transactionId: string;
    },
    accessToken?: string,
  ): Promise<void>;
}

export class ConvexFinanceClassificationStore implements FinanceClassificationStore {
  constructor(private readonly convexUrl: string) {}

  confirmClassification(
    _subject: string,
    request: { classification: ConfirmedTransactionClassification; transactionId: string },
    accessToken: string,
  ): Promise<{ classification: ConfirmedTransactionClassification; transactionId: string }> {
    return this.client(accessToken).mutation(confirmClassification, request);
  }

  acceptNonAllowanceAiSuggestion(
    _subject: string,
    transactionId: string,
    accessToken: string,
  ): Promise<void> {
    return this.client(accessToken)
      .mutation(acceptNonAllowanceAiSuggestion, { transactionId })
      .then(() => undefined);
  }

  correctMerchant(
    _subject: string,
    request: {
      classification: ConfirmedTransactionClassification;
      scope: 'one_time' | 'retrospective' | 'prospective';
      transactionId: string;
    },
    accessToken: string,
  ): Promise<{
    affectedTransactionCount: number;
    scope: 'one_time' | 'retrospective' | 'prospective';
  }> {
    return this.client(accessToken).mutation(correctMerchant, request);
  }

  getMaterialReviewQueue(_subject: string, accessToken: string): Promise<MaterialReviewQueue> {
    return this.client(accessToken).query(getMaterialReviewQueue, {});
  }

  getAiClassificationCandidates(
    _subject: string,
    transactionIds: string[],
    accessToken: string,
  ): Promise<AiClassificationCandidate[]> {
    return this.client(accessToken).query(getAiClassificationCandidates, { transactionIds });
  }

  saveAiSuggestion(
    _subject: string,
    request: {
      classification: ConfirmedTransactionClassification;
      confidence: number;
      transactionId: string;
    },
    accessToken: string,
  ): Promise<void> {
    return this.client(accessToken)
      .mutation(saveAiSuggestion, request)
      .then(() => undefined);
  }

  private client(accessToken: string): ConvexHttpClient {
    return new ConvexHttpClient(this.convexUrl, { auth: accessToken, logger: false });
  }
}
