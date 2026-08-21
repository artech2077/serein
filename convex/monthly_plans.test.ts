import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|plan-user' };

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    expectedSalaryEnd: '2026-09-30',
    expectedSalaryStart: '2026-09-28',
    forecastSalaryCents: 300_000,
    idempotencyKey: 'september-plan',
    month: '2026-09',
    proposedBaseDailyAllowanceCents: 5_000,
    ...overrides,
  };
}

describe('monthly plan lifecycle', () => {
  it('keeps a salary forecast distinct from received income and becomes conservative after a late salary', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await t.mutation(api.monthly_plans.propose, proposal());

    expect(await t.query(api.monthly_plans.get, { asOf: '2026-09-29', month: '2026-09' })).toEqual(
      expect.objectContaining({
        salary: {
          conservativeIncomeCents: 0,
          expectedSalaryEnd: '2026-09-30',
          expectedSalaryStart: '2026-09-28',
          forecastSalaryCents: 300_000,
          status: 'forecast',
        },
        state: 'awaiting_approval',
      }),
    );
    expect(await t.query(api.monthly_plans.get, { asOf: '2026-10-01', month: '2026-09' })).toEqual(
      expect.objectContaining({
        salary: expect.objectContaining({
          conservativeIncomeCents: 0,
          forecastSalaryCents: 300_000,
          status: 'late_conservative',
        }),
      }),
    );
  });

  it('uses received income when supplied without collapsing it into the salary forecast', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await t.mutation(api.monthly_plans.propose, proposal({ receivedIncomeCents: 295_000 }));

    expect(await t.query(api.monthly_plans.get, { asOf: '2026-10-01', month: '2026-09' })).toEqual(
      expect.objectContaining({
        salary: expect.objectContaining({
          conservativeIncomeCents: 295_000,
          forecastSalaryCents: 300_000,
          receivedIncomeCents: 295_000,
          status: 'received',
        }),
      }),
    );
  });

  it('keeps the approved base stable while a material revision awaits explicit approval', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    const created = await t.mutation(api.monthly_plans.propose, proposal());
    const active = await t.mutation(api.monthly_plans.approve, {
      idempotencyKey: 'approve-september',
      month: '2026-09',
      version: created.version,
    });
    const revision = await t.mutation(api.monthly_plans.proposeMaterialRevision, {
      idempotencyKey: 'rent-change',
      materialEventId: 'rent-increase',
      minimumMaterialChangeCents: 500,
      month: '2026-09',
      proposedBaseDailyAllowanceCents: 3_000,
      version: active.version,
    });

    expect(revision).toMatchObject({ revisionRequired: true, state: 'revision_proposed' });
    expect(await t.query(api.monthly_plans.get, { asOf: '2026-09-15', month: '2026-09' })).toEqual(
      expect.objectContaining({
        approvedBaseDailyAllowanceCents: 5_000,
        proposedBaseDailyAllowanceCents: 3_000,
        state: 'revision_proposed',
      }),
    );

    await t.mutation(api.monthly_plans.approve, {
      idempotencyKey: 'approve-rent-change',
      month: '2026-09',
      version: revision.version,
    });
    expect(await t.query(api.monthly_plans.get, { asOf: '2026-09-15', month: '2026-09' })).toEqual(
      expect.objectContaining({
        approvedBaseDailyAllowanceCents: 3_000,
        state: 'active',
      }),
    );
  });

  it('does not propose an unqualified revision and replays a matching command safely', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    const created = await t.mutation(api.monthly_plans.propose, proposal());
    const replayed = await t.mutation(api.monthly_plans.propose, proposal());
    const active = await t.mutation(api.monthly_plans.approve, {
      idempotencyKey: 'approve-for-small-change',
      month: '2026-09',
      version: created.version,
    });
    const noRevision = await t.mutation(api.monthly_plans.proposeMaterialRevision, {
      idempotencyKey: 'coffee-change',
      materialEventId: 'coffee-price-change',
      minimumMaterialChangeCents: 500,
      month: '2026-09',
      proposedBaseDailyAllowanceCents: 4_750,
      version: active.version,
    });

    expect(replayed).toMatchObject({ outcome: 'replayed', planId: created.planId });
    expect(noRevision).toMatchObject({
      approvedBaseDailyAllowanceCents: 5_000,
      revisionRequired: false,
      state: 'active',
    });
  });

  it('does not reveal a monthly plan to a different authenticated user', async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(identity).mutation(api.monthly_plans.propose, proposal());

    await expect(
      t
        .withIdentity({ subject: 'auth0|other-plan-user' })
        .query(api.monthly_plans.get, { asOf: '2026-09-29', month: '2026-09' }),
    ).resolves.toBeNull();
  });
});
