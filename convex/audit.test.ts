import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { upsertMaterialAlert } from './audit';
import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|audit-user' };

function proposal() {
  return {
    expectedSalaryEnd: '2026-09-30',
    expectedSalaryStart: '2026-09-28',
    forecastSalaryCents: 300_000,
    idempotencyKey: 'audit-plan',
    month: '2026-09',
    proposedBaseDailyAllowanceCents: 5_000,
  };
}

describe('financial audit history and material alerts', () => {
  it('records plan proposals, approvals, and material revisions as an auditable subject-scoped history', async () => {
    const shared = convexTest(schema, modules);
    const t = shared.withIdentity(identity);
    const proposed = await t.mutation(api.monthly_plans.propose, proposal());
    const approved = await t.mutation(api.monthly_plans.approve, {
      idempotencyKey: 'audit-approve',
      month: '2026-09',
      version: proposed.version,
    });
    await t.mutation(api.monthly_plans.proposeMaterialRevision, {
      idempotencyKey: 'audit-revision',
      materialEventId: 'audit-rent-change',
      minimumMaterialChangeCents: 500,
      month: '2026-09',
      proposedBaseDailyAllowanceCents: 3_000,
      version: approved.version,
    });

    const history = await t.query(api.audit.getHistory, {});
    const otherHistory = await shared
      .withIdentity({ subject: 'auth0|other-audit-user' })
      .query(api.audit.getHistory, {});

    expect(history.map((event) => event.eventType).sort()).toEqual([
      'monthly_plan_approved',
      'monthly_plan_proposed',
      'monthly_plan_revision_proposed',
    ]);
    expect(history.every((event) => event.summary.length > 0)).toBe(true);
    expect(otherHistory).toEqual([]);
  });

  it('keeps one open alert for a repeatedly observed material risk', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    await t.run(async (ctx) => {
      await upsertMaterialAlert(ctx, {
        dedupeKey: 'unallocated-settlement:statement-1',
        impactCents: 600,
        kind: 'unallocated_settlement',
        recoveryAction: 'Review the settlement allocations and assign the remaining amount.',
        subject: identity.subject,
        summary: '600 cents of this deferred-card settlement are not allocated to purchases.',
      });
      await upsertMaterialAlert(ctx, {
        dedupeKey: 'unallocated-settlement:statement-1',
        impactCents: 600,
        kind: 'unallocated_settlement',
        recoveryAction: 'Review the settlement allocations and assign the remaining amount.',
        subject: identity.subject,
        summary: '600 cents of this deferred-card settlement are not allocated to purchases.',
      });
    });

    expect(await t.query(api.audit.getOpenAlerts, {})).toEqual([
      expect.objectContaining({
        impactCents: 600,
        kind: 'unallocated_settlement',
        recoveryAction: 'Review the settlement allocations and assign the remaining amount.',
      }),
    ]);
  });
});
