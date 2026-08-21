import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';
import { recordFinancialAudit } from './audit';

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
  aiClassification: v.optional(confirmedClassification),
  aiConfidence: v.optional(v.number()),
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
        aiClassification: transaction.aiClassification,
        aiConfidence: transaction.aiConfidence,
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

const aiCandidate = v.object({
  amountCents: v.number(),
  bookingDate: v.string(),
  sourceDescription: v.string(),
  transactionId: v.string(),
});

export const getAiClassificationCandidates = query({
  args: { transactionIds: v.array(v.id('importedTransactions')) },
  returns: v.array(aiCandidate),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    if (request.transactionIds.length === 0 || request.transactionIds.length > 50) {
      throw new ConvexError({ code: 'invalid_ai_classification_selection' });
    }
    const candidates = await Promise.all(
      request.transactionIds.map(async (transactionId) => {
        const transaction = await ctx.db.get(transactionId);
        if (
          !transaction ||
          transaction.subject !== subject ||
          transaction.classificationState !== 'review_required'
        ) {
          throw new ConvexError({ code: 'transaction_not_reviewable' });
        }
        return {
          amountCents: transaction.amountCents,
          bookingDate: transaction.bookingDate,
          sourceDescription: transaction.sourceDescription,
          transactionId: transaction._id,
        };
      }),
    );
    return candidates;
  },
});

export const saveAiSuggestion = mutation({
  args: {
    classification: confirmedClassification,
    confidence: v.number(),
    transactionId: v.id('importedTransactions'),
  },
  returns: v.null(),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    const transaction = await requireOwnedTransaction(ctx, subject, request.transactionId);
    if (
      transaction.classificationState !== 'review_required' ||
      !Number.isFinite(request.confidence) ||
      request.confidence < 0 ||
      request.confidence > 1
    ) {
      throw new ConvexError({ code: 'transaction_not_reviewable' });
    }
    await ctx.db.patch(transaction._id, {
      aiClassification: request.classification,
      aiConfidence: request.confidence,
    });
    return null;
  },
});

export const acceptNonAllowanceAiSuggestion = mutation({
  args: { transactionId: v.id('importedTransactions') },
  returns: v.null(),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    const transaction = await requireOwnedTransaction(ctx, subject, request.transactionId);
    if (
      transaction.classificationState !== 'review_required' ||
      transaction.aiClassification !== 'transfer' ||
      (transaction.aiConfidence ?? 0) < 0.9
    ) {
      throw new ConvexError({ code: 'ai_suggestion_not_eligible' });
    }
    await ctx.db.patch(transaction._id, {
      classification: 'transfer',
      classificationState: 'confirmed',
    });
    await recordFinancialAudit(ctx, {
      amountCents: transaction.amountCents,
      entityId: transaction._id,
      eventType: 'classification_confirmed',
      subject,
      summary: 'Accepted the high-confidence transfer suggestion for this transaction.',
    });
    return null;
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
    await recordFinancialAudit(ctx, {
      amountCents: transaction.amountCents,
      entityId: transaction._id,
      eventType: 'classification_confirmed',
      subject,
      summary: `Confirmed this transaction as ${request.classification}.`,
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

    await recordFinancialAudit(ctx, {
      entityId: transaction._id,
      eventType: 'merchant_corrected',
      subject,
      summary: `Corrected ${matching.length} ${matching.length === 1 ? 'transaction' : 'transactions'} for this merchant as ${request.classification} (${request.scope}).`,
    });

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
