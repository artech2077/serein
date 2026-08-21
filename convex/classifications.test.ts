import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|classification-user' };
const mapping = { amountColumn: 'Amount', dateColumn: 'Date', descriptionColumn: 'Description' };
const initialCsv = `Date,Description,Amount\n2026-08-14,Coffee Shop,-12.50\n2026-08-15,Coffee Shop,-4.00\n2026-08-15,Salary,2500.00`;

async function importTransactions(t: ReturnType<typeof convexTest>['withIdentity']) {
  await t.mutation(api.imports.importCsv, {
    accountExternalId: 'checking',
    accountName: 'Checking',
    csv: initialCsv,
    idempotencyKey: 'initial-import',
    mapping,
  });
}

describe('transaction classification and material review', () => {
  it('holds unknown debits in the review queue until a classification is confirmed', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await importTransactions(t);

    const before = await t.query(api.classifications.getMaterialReviewQueue, {});
    const firstItem = before.items[0];
    if (!firstItem) {
      throw new Error('Expected an unknown debit in the review queue.');
    }
    const confirmed = await t.mutation(api.classifications.confirmClassification, {
      classification: 'discretionary',
      transactionId: firstItem.transactionId as Id<'importedTransactions'>,
    });
    const after = await t.query(api.classifications.getMaterialReviewQueue, {});

    expect(before.items).toHaveLength(2);
    expect(before.unresolvedDebitCents).toBe(1650);
    expect(confirmed.classification).toBe('discretionary');
    expect(after.items).toHaveLength(1);
    expect(after.unresolvedDebitCents).toBeGreaterThan(0);
  });

  it('records AI suggestions without removing material spending from review, and only accepts eligible transfers', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await importTransactions(t);
    const queue = await t.query(api.classifications.getMaterialReviewQueue, {});
    const first = queue.items[0];
    const second = queue.items[1];
    if (!first || !second) throw new Error('Expected reviewable transactions.');

    await t.mutation(api.classifications.saveAiSuggestion, {
      classification: 'essential',
      confidence: 0.99,
      transactionId: first.transactionId as Id<'importedTransactions'>,
    });
    const afterEssentialSuggestion = await t.query(api.classifications.getMaterialReviewQueue, {});
    expect(afterEssentialSuggestion.items).toHaveLength(2);
    expect(afterEssentialSuggestion.items[0]).toMatchObject({
      aiClassification: 'essential',
      aiConfidence: 0.99,
    });

    await t.mutation(api.classifications.saveAiSuggestion, {
      classification: 'transfer',
      confidence: 0.95,
      transactionId: second.transactionId as Id<'importedTransactions'>,
    });
    await t.mutation(api.classifications.acceptNonAllowanceAiSuggestion, {
      transactionId: second.transactionId as Id<'importedTransactions'>,
    });
    const afterTransfer = await t.query(api.classifications.getMaterialReviewQueue, {});
    expect(afterTransfer.items).toHaveLength(1);
    expect(afterTransfer.items[0]).toMatchObject({ aiClassification: 'essential' });
  });

  it('applies merchant corrections one time, retrospectively, or prospectively', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await importTransactions(t);
    const queue = await t.query(api.classifications.getMaterialReviewQueue, {});
    const firstItem = queue.items[0];
    const secondItem = queue.items[1];
    if (!firstItem || !secondItem) {
      throw new Error('Expected two unknown debits in the review queue.');
    }
    const first = firstItem.transactionId as Id<'importedTransactions'>;
    const second = secondItem.transactionId as Id<'importedTransactions'>;

    const oneTime = await t.mutation(api.classifications.correctMerchant, {
      classification: 'essential',
      scope: 'one_time',
      transactionId: first,
    });
    expect(oneTime).toEqual({ affectedTransactionCount: 1, scope: 'one_time' });
    expect((await t.query(api.classifications.getMaterialReviewQueue, {})).items).toHaveLength(1);

    const retrospective = await t.mutation(api.classifications.correctMerchant, {
      classification: 'discretionary',
      scope: 'retrospective',
      transactionId: second,
    });
    expect(retrospective).toEqual({ affectedTransactionCount: 2, scope: 'retrospective' });
    expect((await t.query(api.classifications.getMaterialReviewQueue, {})).items).toEqual([]);

    await t.mutation(api.classifications.correctMerchant, {
      classification: 'discretionary',
      scope: 'prospective',
      transactionId: first,
    });
    await t.mutation(api.imports.importCsv, {
      accountExternalId: 'checking',
      accountName: 'Checking',
      csv: `Date,Description,Amount\n2026-08-16,Coffee Shop,-3.20`,
      idempotencyKey: 'future-coffee',
      mapping,
    });
    expect((await t.query(api.classifications.getMaterialReviewQueue, {})).items).toEqual([]);
  });

  it('keeps each user’s review queue private', async () => {
    const t = convexTest(schema, modules);
    await importTransactions(t.withIdentity(identity));

    expect(
      await t
        .withIdentity({ subject: 'auth0|other-user' })
        .query(api.classifications.getMaterialReviewQueue, {}),
    ).toEqual({ items: [], unresolvedDebitCents: 0 });
  });
});
