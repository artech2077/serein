import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

import type {
  DeferredCardPurchaseRequest,
  DeferredCardSettlementRequest,
  DeferredCardSummary,
} from '@serein/contracts';

import { IdempotencyKeyConflictError } from './workspace-store.js';

type PurchaseResult =
  { outcome: 'applied' | 'replayed'; purchaseId: string } | { type: 'idempotency_key_conflict' };
type SettlementResult =
  | {
      outcome: 'applied' | 'replayed';
      outstandingLiabilityCents: number;
      settlementId: string;
      state: 'reconciled' | 'review_required';
    }
  | { type: 'idempotency_key_conflict' };

const recordPurchase = makeFunctionReference<
  'mutation',
  DeferredCardPurchaseRequest & Record<string, unknown>,
  PurchaseResult
>('deferred_cards:recordPurchase');
const recordSettlement = makeFunctionReference<
  'mutation',
  DeferredCardSettlementRequest & Record<string, unknown>,
  SettlementResult
>('deferred_cards:recordSettlement');
const getSummary = makeFunctionReference<'query', Record<string, never>, DeferredCardSummary>(
  'deferred_cards:getSummary',
);

export interface DeferredCardStore {
  getSummary(subject: string, accessToken?: string): Promise<DeferredCardSummary>;
  recordPurchase(
    subject: string,
    request: DeferredCardPurchaseRequest,
    accessToken?: string,
  ): Promise<{ outcome: 'applied' | 'replayed'; purchaseId: string }>;
  recordSettlement(
    subject: string,
    request: DeferredCardSettlementRequest,
    accessToken?: string,
  ): Promise<{
    outcome: 'applied' | 'replayed';
    outstandingLiabilityCents: number;
    settlementId: string;
    state: 'reconciled' | 'review_required';
  }>;
}

export class ConvexDeferredCardStore implements DeferredCardStore {
  constructor(private readonly convexUrl: string) {}

  getSummary(_subject: string, accessToken: string): Promise<DeferredCardSummary> {
    return this.client(accessToken).query(getSummary, {});
  }

  async recordPurchase(
    _subject: string,
    request: DeferredCardPurchaseRequest,
    accessToken: string,
  ): Promise<{ outcome: 'applied' | 'replayed'; purchaseId: string }> {
    const result = await this.client(accessToken).mutation(
      recordPurchase,
      request as DeferredCardPurchaseRequest & Record<string, unknown>,
    );
    if ('type' in result) throw new IdempotencyKeyConflictError(request.idempotencyKey);
    return result;
  }

  async recordSettlement(
    _subject: string,
    request: DeferredCardSettlementRequest,
    accessToken: string,
  ): Promise<{
    outcome: 'applied' | 'replayed';
    outstandingLiabilityCents: number;
    settlementId: string;
    state: 'reconciled' | 'review_required';
  }> {
    const result = await this.client(accessToken).mutation(
      recordSettlement,
      request as DeferredCardSettlementRequest & Record<string, unknown>,
    );
    if ('type' in result) throw new IdempotencyKeyConflictError(request.idempotencyKey);
    return result;
  }

  private client(accessToken: string): ConvexHttpClient {
    return new ConvexHttpClient(this.convexUrl, { auth: accessToken, logger: false });
  }
}
