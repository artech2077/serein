import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { modules } from './test.setup';

const identity = { subject: 'auth0|ai-usage-user' };
const request = {
  estimatedCostNanoEur: 1_000,
  month: '2026-09',
  monthlyBudgetNanoEur: 5_000,
  monthlyPlanningReserveNanoEur: 1_000,
  requestId: 'classification-1',
  task: 'routine_classification' as const,
};

describe('durable AI usage reservations', () => {
  it('reserves next-plan capacity and keeps retries idempotent', async () => {
    const t = convexTest(schema, modules).withIdentity(identity);
    const first = await t.mutation(api.ai_usage.reserve, request);
    const replay = await t.mutation(api.ai_usage.reserve, request);
    const protectedCapacity = await t.mutation(api.ai_usage.reserve, {
      ...request,
      estimatedCostNanoEur: 3_100,
      requestId: 'classification-2',
    });
    const planning = await t.mutation(api.ai_usage.reserve, {
      ...request,
      estimatedCostNanoEur: 3_100,
      requestId: 'planning-1',
      task: 'monthly_planning',
    });

    expect(first).toMatchObject({ replayed: false, type: 'reserved' });
    expect(replay).toMatchObject({ replayed: true, type: 'reserved' });
    expect(protectedCapacity).toEqual({ type: 'budget_exceeded' });
    expect(planning).toMatchObject({ type: 'reserved' });
  });

  it('commits conservatively and rejects a second user’s access', async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(identity).mutation(api.ai_usage.reserve, request);
    expect(
      await t
        .withIdentity(identity)
        .mutation(api.ai_usage.commit, { requestId: 'classification-1' }),
    ).toMatchObject({
      replayed: false,
      type: 'reserved',
    });
    expect(
      await t
        .withIdentity({ subject: 'auth0|other-ai-user' })
        .mutation(api.ai_usage.commit, { requestId: 'classification-1' }),
    ).toEqual({ type: 'reservation_not_found' });
  });
});
