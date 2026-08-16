import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';

const confirmedClassification = v.union(
  v.literal('discretionary'),
  v.literal('essential'),
  v.literal('transfer'),
  v.literal('refund'),
);

const correctionScope = v.union(
  v.literal('one_time'),
  v.literal('retrospective'),
  v.literal('prospective'),
);

const reviewItem = v.object({
  amountCents: v.number(),
  bookingDate: v.string(),
  sourceDescription: v.string(),
  transactionId: v.string(),
});

export const getMaterialReviewQueue = query({
  args: {},
  returns: v.object({ items: v.array(reviewItem), unresolvedDebitCents: v.number() }),
  handler: async (ctx) => {
    const subject = await requireSubject(ctx);
    const transactions = await ctx.db
      .query('importedTransactions')
      .withIndex('by_subject_and_source_fingerprint', (index) => index.eq('subject', subject))
      .collect();
    const items = transactions
      .filter((transaction) => transaction.classificationState === 'review_required')
      .map((transaction) => ({
        amountCents: transaction.amountCents,
        bookingDate: transaction.bookingDate,
        sourceDescription: transaction.sourceDescription,
        transactionId: transaction._id,
      }))
      .sort((left, right) => right.bookingDate.localeCompare(left.bookingDate));

    return {
      items,
      unresolvedDebitCents: items.reduce(
        (total, item) => total + Math.max(-item.amountCents, 0),
        0,
      ),
    };
  },
});

export const confirmClassification = mutation({
  args: { classification: confirmedClassification, transactionId: v.id('importedTransactions') },
  returns: v.object({ classification: confirmedClassification, transactionId: v.string() }),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    const transaction = await requireOwnedTransaction(ctx, subject, request.transactionId);
    await ctx.db.patch(transaction._id, {
      classification: request.classification,
      classificationState: 'confirmed',
    });
    return { classification: request.classification, transactionId: transaction._id };
  },
});

export const correctMerchant = mutation({
  args: {
    classification: confirmedClassification,
    scope: correctionScope,
    transactionId: v.id('importedTransactions'),
  },
  returns: v.object({ affectedTransactionCount: v.number(), scope: correctionScope }),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    const transaction = await requireOwnedTransaction(ctx, subject, request.transactionId);
    const matching =
      request.scope === 'retrospective'
        ? await ctx.db
            .query('importedTransactions')
            .withIndex('by_subject_and_merchant_key', (index) =>
              index.eq('subject', subject).eq('merchantKey', transaction.merchantKey),
            )
            .collect()
        : [transaction];

    for (const candidate of matching) {
      await ctx.db.patch(candidate._id, {
        classification: request.classification,
        classificationState: 'confirmed',
      });
    }

    if (request.scope === 'prospective') {
      const existingRule = await ctx.db
        .query('merchantRules')
        .withIndex('by_subject_and_merchant_key', (index) =>
          index.eq('subject', subject).eq('merchantKey', transaction.merchantKey),
        )
        .unique();
      if (existingRule) {
        await ctx.db.patch(existingRule._id, { classification: request.classification });
      } else {
        await ctx.db.insert('merchantRules', {
          classification: request.classification,
          merchantKey: transaction.merchantKey,
          subject,
        });
      }
    }

    return { affectedTransactionCount: matching.length, scope: request.scope };
  },
});

async function requireOwnedTransaction(
  ctx: MutationCtx,
  subject: string,
  transactionId: Id<'importedTransactions'>,
) {
  const transaction = await ctx.db.get(transactionId);
  if (!transaction || transaction.subject !== subject) {
    throw new ConvexError({ code: 'transaction_not_found' });
  }
  return transaction;
}

async function requireSubject(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) {
    throw new ConvexError({ code: 'authentication_required' });
  }
  return identity.subject;
}
