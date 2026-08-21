import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|quick-add-user' };
const mapping = { amountColumn: 'Amount', dateColumn: 'Date', descriptionColumn: 'Description' };

async function importAccount(t: ReturnType<typeof convexTest>['withIdentity']) {
  await t.mutation(api.imports.importCsv, {
    accountExternalId: 'checking',
    accountName: 'Checking',
    csv: 'Date,Description,Amount\n2026-08-21,Opening balance,100.00',
    idempotencyKey: 'create-account',
    mapping,
  });
}

describe('Quick Adds', () => {
  it('previews and records exactly one immediate provisional effect', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await importAccount(t);

    const preview = await t.query(api.quick_adds.preview, {
      amountCents: 450,
      bookingDate: '2026-08-21',
      sourceDescription: 'Corner Cafe',
    });
    const applied = await t.mutation(api.quick_adds.create, {
      accountExternalId: 'checking',
      amountCents: 450,
      bookingDate: '2026-08-21',
      idempotencyKey: 'coffee-now',
      sourceDescription: 'Corner Cafe',
    });
    const replayed = await t.mutation(api.quick_adds.create, {
      accountExternalId: 'checking',
      amountCents: 450,
      bookingDate: '2026-08-21',
      idempotencyKey: 'coffee-now',
      sourceDescription: 'Corner Cafe',
    });

    expect(preview).toEqual({ allowanceImpactCents: -450 });
    expect(applied.outcome).toBe('applied');
    expect(replayed).toEqual({ outcome: 'replayed', quickAddId: applied.quickAddId });
    expect(await t.query(api.quick_adds.getPending, {})).toEqual([
      expect.objectContaining({
        amountCents: 450,
        sourceDescription: 'Corner Cafe',
        state: 'provisional',
      }),
    ]);
  });

  it('automatically matches a single exact imported activity and sends ambiguity to review', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await importAccount(t);
    const quickAdd = {
      accountExternalId: 'checking',
      amountCents: 450,
      bookingDate: '2026-08-21',
      sourceDescription: 'Corner Cafe',
    };
    await t.mutation(api.quick_adds.create, { ...quickAdd, idempotencyKey: 'one' });
    await t.mutation(api.imports.importCsv, {
      accountExternalId: 'checking',
      accountName: 'Checking',
      csv: 'Date,Description,Amount\n2026-08-21,Corner Cafe,-4.50',
      idempotencyKey: 'match-one',
      mapping,
    });
    expect(await t.query(api.quick_adds.getPending, {})).toEqual([]);

    const ambiguousQuickAdd = { ...quickAdd, bookingDate: '2026-08-22' };
    await t.mutation(api.quick_adds.create, { ...ambiguousQuickAdd, idempotencyKey: 'two' });
    await t.mutation(api.quick_adds.create, {
      ...ambiguousQuickAdd,
      idempotencyKey: 'three',
    });
    await t.mutation(api.imports.importCsv, {
      accountExternalId: 'checking',
      accountName: 'Checking',
      csv: 'Date,Description,Amount\n2026-08-22,Corner Cafe,-4.50',
      idempotencyKey: 'ambiguous-match',
      mapping,
    });

    const pending = await t.query(api.quick_adds.getPending, {});
    expect(pending).toHaveLength(2);
    expect(pending.map((item) => item.state)).toEqual(['review_required', 'review_required']);
  });

  it('does not reveal a user’s Quick Adds to another identity', async () => {
    const t = convexTest(schema, modules);
    const primary = t.withIdentity(identity);
    await importAccount(primary);
    await primary.mutation(api.quick_adds.create, {
      accountExternalId: 'checking',
      amountCents: 450,
      bookingDate: '2026-08-21',
      idempotencyKey: 'private-quick-add',
      sourceDescription: 'Corner Cafe',
    });

    await expect(
      t.withIdentity({ subject: 'auth0|other-user' }).query(api.quick_adds.getPending, {}),
    ).resolves.toEqual([]);
  });
});
