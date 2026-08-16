import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|csv-user' };
const mapping = { amountColumn: 'Amount', dateColumn: 'Date', descriptionColumn: 'Description' };
const csv = `Date,Description,Amount\n2026-08-14,"  Corner, Cafe  ",-12.50\n2026-08-15,Salary,2500.00`;

describe('CSV imports', () => {
  it('deduplicates reimports, preserves source descriptions, and reuses a saved mapping', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    const first = await t.mutation(api.imports.importCsv, {
      accountExternalId: 'bank-checking',
      accountName: 'Checking',
      csv,
      idempotencyKey: 'first-import',
      mapping,
    });
    const replayed = await t.mutation(api.imports.importCsv, {
      accountExternalId: 'bank-checking',
      accountName: 'Checking',
      csv,
      idempotencyKey: 'first-import',
      mapping,
    });
    const reimported = await t.mutation(api.imports.importCsv, {
      accountExternalId: 'bank-checking',
      accountName: 'Checking',
      csv,
      idempotencyKey: 'second-import',
    });
    const transactions = await t.run(async (ctx) => ctx.db.query('importedTransactions').collect());

    expect(first).toMatchObject({
      importedTransactionCount: 2,
      outcome: 'applied',
      skippedDuplicateTransactionCount: 0,
      sourceAsOf: '2026-08-15',
    });
    expect(replayed).toMatchObject({ importedTransactionCount: 2, outcome: 'replayed' });
    expect(reimported).toMatchObject({
      importedTransactionCount: 0,
      outcome: 'applied',
      skippedDuplicateTransactionCount: 2,
    });
    expect(transactions).toHaveLength(2);
    expect(transactions.map((transaction) => transaction.sourceDescription)).toContain(
      '  Corner, Cafe  ',
    );
  });

  it('qualifies allowance coverage only when no account is marked missing', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await t.mutation(api.imports.importCsv, {
      accountExternalId: 'bank-checking',
      accountName: 'Checking',
      csv,
      idempotencyKey: 'import-coverage',
      mapping,
    });
    await t.mutation(api.imports.upsertManualAccount, {
      accountExternalId: 'cash',
      accountName: 'Cash',
    });
    await t.mutation(api.imports.setAccountCoverageState, {
      accountExternalId: 'closed-card',
      accountName: 'Closed card',
      state: 'excluded',
    });
    await t.mutation(api.imports.setAccountCoverageState, {
      accountExternalId: 'unavailable-savings',
      accountName: 'Savings',
      state: 'missing',
    });

    const blocked = await t.query(api.imports.getAllowanceCoverage, {});
    await t.mutation(api.imports.setAccountCoverageState, {
      accountExternalId: 'unavailable-savings',
      accountName: 'Savings',
      state: 'manual',
    });
    const qualified = await t.query(api.imports.getAllowanceCoverage, {});

    expect(blocked.allowanceQualified).toBe(false);
    expect(blocked.missingAccountExternalIds).toEqual(['unavailable-savings']);
    expect(blocked.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'imported', sourceAsOf: '2026-08-15' }),
        expect.objectContaining({ state: 'manual' }),
        expect.objectContaining({ state: 'excluded' }),
        expect.objectContaining({ state: 'missing' }),
      ]),
    );
    expect(qualified.allowanceQualified).toBe(true);
    expect(qualified.missingAccountExternalIds).toEqual([]);
  });

  it('does not expose one subject’s imported records or saved mapping to another subject', async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(identity).mutation(api.imports.importCsv, {
      accountExternalId: 'bank-checking',
      accountName: 'Checking',
      csv,
      idempotencyKey: 'primary-import',
      mapping,
    });

    await expect(
      t.withIdentity({ subject: 'auth0|other-user' }).mutation(api.imports.importCsv, {
        accountExternalId: 'bank-checking',
        accountName: 'Checking',
        csv,
        idempotencyKey: 'other-import',
      }),
    ).rejects.toThrow('csv_mapping_required');
    expect(
      await t
        .withIdentity({ subject: 'auth0|other-user' })
        .query(api.imports.getAllowanceCoverage, {}),
    ).toEqual({
      accounts: [],
      allowanceQualified: true,
      missingAccountExternalIds: [],
    });
  });
});
