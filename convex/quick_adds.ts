import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';

const quickAdd = v.object({
  amountCents: v.number(),
  bookingDate: v.string(),
  sourceDescription: v.string(),
});

export const preview = query({
  args: quickAdd.fields,
  returns: v.object({ allowanceImpactCents: v.number() }),
  handler: async (ctx, request) => {
    await requireSubject(ctx);
    validate(request);
    return { allowanceImpactCents: -request.amountCents };
  },
});

export const create = mutation({
  args: { ...quickAdd.fields, accountExternalId: v.string(), idempotencyKey: v.string() },
  returns: v.object({
    outcome: v.union(v.literal('applied'), v.literal('replayed')),
    quickAddId: v.string(),
  }),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validate(request);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(request.idempotencyKey))
      throw new ConvexError({ code: 'invalid_quick_add' });
    const fingerprint = JSON.stringify(request);
    const receipt = await ctx.db
      .query('quickAddReceipts')
      .withIndex('by_subject_and_idempotency_key', (i) =>
        i.eq('subject', subject).eq('idempotencyKey', request.idempotencyKey),
      )
      .unique();
    if (receipt) {
      if (receipt.requestFingerprint !== fingerprint)
        throw new ConvexError({ code: 'idempotency_key_conflict' });
      return { outcome: 'replayed' as const, quickAddId: receipt.quickAddId };
    }
    const account = await ctx.db
      .query('financeAccounts')
      .withIndex('by_subject_and_external_id', (i) =>
        i.eq('subject', subject).eq('accountExternalId', request.accountExternalId),
      )
      .unique();
    if (!account) throw new ConvexError({ code: 'account_not_found' });
    const id = await ctx.db.insert('quickAdds', {
      accountId: account._id,
      amountCents: request.amountCents,
      bookingDate: request.bookingDate,
      merchantKey: merchantKeyFor(request.sourceDescription),
      matchKey: matchKeyFor(
        account._id,
        request.bookingDate,
        request.amountCents,
        request.sourceDescription,
      ),
      sourceDescription: request.sourceDescription,
      state: 'provisional',
      subject,
    });
    await ctx.db.insert('quickAddReceipts', {
      idempotencyKey: request.idempotencyKey,
      quickAddId: id,
      requestFingerprint: fingerprint,
      subject,
    });
    return { outcome: 'applied' as const, quickAddId: id };
  },
});

export const getPending = query({
  args: {},
  returns: v.array(
    v.object({
      amountCents: v.number(),
      bookingDate: v.string(),
      quickAddId: v.string(),
      sourceDescription: v.string(),
      state: v.union(v.literal('provisional'), v.literal('review_required')),
    }),
  ),
  handler: async (ctx) => {
    const subject = await requireSubject(ctx);
    const all = await ctx.db
      .query('quickAdds')
      .withIndex('by_subject_and_match_key', (i) => i.eq('subject', subject))
      .collect();
    return all
      .filter((item) => item.state !== 'matched')
      .map((item) => ({
        amountCents: item.amountCents,
        bookingDate: item.bookingDate,
        quickAddId: item._id,
        sourceDescription: item.sourceDescription,
        state: item.state as 'provisional' | 'review_required',
      }));
  },
});

export async function reconcileImportedTransaction(
  ctx: MutationCtx,
  subject: string,
  accountId: Id<'financeAccounts'>,
  bookingDate: string,
  amountCents: number,
  sourceDescription: string,
) {
  const matches = await ctx.db
    .query('quickAdds')
    .withIndex('by_subject_and_match_key', (i) =>
      i
        .eq('subject', subject)
        .eq('matchKey', matchKeyFor(accountId, bookingDate, amountCents, sourceDescription)),
    )
    .collect();
  if (matches.length === 1) await ctx.db.patch(matches[0]._id, { state: 'matched' });
  if (matches.length > 1)
    await Promise.all(matches.map((item) => ctx.db.patch(item._id, { state: 'review_required' })));
}

function validate(value: { amountCents: number; bookingDate: string; sourceDescription: string }) {
  if (
    !Number.isSafeInteger(value.amountCents) ||
    value.amountCents <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.bookingDate) ||
    value.sourceDescription.trim().length === 0
  )
    throw new ConvexError({ code: 'invalid_quick_add' });
}
async function requireSubject(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError({ code: 'authentication_required' });
  return identity.subject;
}
function merchantKeyFor(description: string) {
  return description.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
function matchKeyFor(
  accountId: Id<'financeAccounts'>,
  date: string,
  amountCents: number,
  description: string,
) {
  return [accountId, date, amountCents, merchantKeyFor(description)].join('\u001f');
}
