import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

import type {
  AccountCoverageState,
  AllowanceCoverage,
  CsvImportRequest,
  CsvImportResult,
} from '@serein/contracts';

import { IdempotencyKeyConflictError } from './workspace-store.js';

type ConvexImportResult = CsvImportResult | { type: 'idempotency_key_conflict' };
type ConvexCsvImportRequest = CsvImportRequest & Record<string, unknown>;

const importCsv = makeFunctionReference<'mutation', ConvexCsvImportRequest, ConvexImportResult>(
  'imports:importCsv',
);
const upsertManualAccount = makeFunctionReference<
  'mutation',
  { accountExternalId: string; accountName: string },
  { accountExternalId: string; state: 'manual' }
>('imports:upsertManualAccount');
const setAccountCoverageState = makeFunctionReference<
  'mutation',
  { accountExternalId: string; accountName: string; state: AccountCoverageState },
  { accountExternalId: string; state: AccountCoverageState }
>('imports:setAccountCoverageState');
const getAllowanceCoverage = makeFunctionReference<
  'query',
  Record<string, never>,
  AllowanceCoverage
>('imports:getAllowanceCoverage');

export interface FinanceImportStore {
  getAllowanceCoverage(subject: string, accessToken?: string): Promise<AllowanceCoverage>;
  importCsv(
    subject: string,
    request: CsvImportRequest,
    accessToken?: string,
  ): Promise<CsvImportResult>;
  setAccountCoverageState(
    subject: string,
    request: {
      accountExternalId: string;
      accountName: string;
      state: Exclude<AccountCoverageState, 'imported'>;
    },
    accessToken?: string,
  ): Promise<{ accountExternalId: string; state: AccountCoverageState }>;
  upsertManualAccount(
    subject: string,
    request: { accountExternalId: string; accountName: string },
    accessToken?: string,
  ): Promise<{ accountExternalId: string; state: 'manual' }>;
}

export class ConvexFinanceImportStore implements FinanceImportStore {
  constructor(private readonly convexUrl: string) {}

  async importCsv(
    _subject: string,
    request: CsvImportRequest,
    accessToken: string,
  ): Promise<CsvImportResult> {
    const result = await this.client(accessToken).mutation(
      importCsv,
      request as ConvexCsvImportRequest,
    );
    if ('type' in result) {
      throw new IdempotencyKeyConflictError(request.idempotencyKey);
    }
    return result;
  }

  getAllowanceCoverage(_subject: string, accessToken: string): Promise<AllowanceCoverage> {
    return this.client(accessToken).query(getAllowanceCoverage, {});
  }

  upsertManualAccount(
    _subject: string,
    request: { accountExternalId: string; accountName: string },
    accessToken: string,
  ): Promise<{ accountExternalId: string; state: 'manual' }> {
    return this.client(accessToken).mutation(upsertManualAccount, request);
  }

  setAccountCoverageState(
    _subject: string,
    request: {
      accountExternalId: string;
      accountName: string;
      state: Exclude<AccountCoverageState, 'imported'>;
    },
    accessToken: string,
  ): Promise<{ accountExternalId: string; state: AccountCoverageState }> {
    return this.client(accessToken).mutation(setAccountCoverageState, request);
  }

  private client(accessToken: string): ConvexHttpClient {
    return new ConvexHttpClient(this.convexUrl, { auth: accessToken, logger: false });
  }
}
