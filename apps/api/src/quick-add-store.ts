import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

import type { PendingQuickAdd, QuickAddPreview, QuickAddRequest } from '@serein/contracts';

import { IdempotencyKeyConflictError } from './workspace-store.js';

type ConvexQuickAddRequest = QuickAddRequest & Record<string, unknown>;
type ConvexQuickAddResult =
  { outcome: 'applied' | 'replayed'; quickAddId: string } | { type: 'idempotency_key_conflict' };

const createQuickAdd = makeFunctionReference<
  'mutation',
  ConvexQuickAddRequest,
  ConvexQuickAddResult
>('quick_adds:create');
const previewQuickAdd = makeFunctionReference<
  'query',
  Pick<QuickAddRequest, 'amountCents' | 'bookingDate' | 'sourceDescription'> &
    Record<string, unknown>,
  QuickAddPreview
>('quick_adds:preview');
const getPendingQuickAdds = makeFunctionReference<
  'query',
  Record<string, never>,
  PendingQuickAdd[]
>('quick_adds:getPending');

export interface QuickAddStore {
  create(
    subject: string,
    request: QuickAddRequest,
    accessToken?: string,
  ): Promise<{ outcome: 'applied' | 'replayed'; quickAddId: string }>;
  getPending(subject: string, accessToken?: string): Promise<readonly PendingQuickAdd[]>;
  preview(
    subject: string,
    request: Pick<QuickAddRequest, 'amountCents' | 'bookingDate' | 'sourceDescription'>,
    accessToken?: string,
  ): Promise<QuickAddPreview>;
}

export class ConvexQuickAddStore implements QuickAddStore {
  constructor(private readonly convexUrl: string) {}

  async create(
    _subject: string,
    request: QuickAddRequest,
    accessToken: string,
  ): Promise<{ outcome: 'applied' | 'replayed'; quickAddId: string }> {
    const result = await this.client(accessToken).mutation(
      createQuickAdd,
      request as ConvexQuickAddRequest,
    );
    if ('type' in result) throw new IdempotencyKeyConflictError(request.idempotencyKey);
    return result;
  }

  getPending(_subject: string, accessToken: string): Promise<readonly PendingQuickAdd[]> {
    return this.client(accessToken).query(getPendingQuickAdds, {});
  }

  preview(
    _subject: string,
    request: Pick<QuickAddRequest, 'amountCents' | 'bookingDate' | 'sourceDescription'>,
    accessToken: string,
  ): Promise<QuickAddPreview> {
    return this.client(accessToken).query(
      previewQuickAdd,
      request as typeof request & Record<string, unknown>,
    );
  }

  private client(accessToken: string): ConvexHttpClient {
    return new ConvexHttpClient(this.convexUrl, { auth: accessToken, logger: false });
  }
}
