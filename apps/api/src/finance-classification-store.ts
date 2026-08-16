import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

import type { ConfirmedTransactionClassification, MaterialReviewQueue } from '@serein/contracts';

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

export interface FinanceClassificationStore {
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

  private client(accessToken: string): ConvexHttpClient {
    return new ConvexHttpClient(this.convexUrl, { auth: accessToken, logger: false });
  }
}
