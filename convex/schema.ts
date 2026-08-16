import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  financeWorkspaces: defineTable({
    initialized: v.boolean(),
    subject: v.string(),
    version: v.number(),
    workspaceId: v.string(),
  }).index('by_subject', ['subject']),
  workspaceCommandReceipts: defineTable({
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    subject: v.string(),
    workspaceId: v.string(),
  }).index('by_subject_and_idempotency_key', ['subject', 'idempotencyKey']),
  financeAccounts: defineTable({
    accountExternalId: v.string(),
    accountName: v.string(),
    lastImportedAt: v.optional(v.number()),
    sourceAsOf: v.optional(v.string()),
    state: v.union(
      v.literal('imported'),
      v.literal('manual'),
      v.literal('excluded'),
      v.literal('missing'),
    ),
    subject: v.string(),
    workspaceId: v.string(),
  }).index('by_subject_and_external_id', ['subject', 'accountExternalId']),
  importedTransactions: defineTable({
    accountId: v.id('financeAccounts'),
    amountCents: v.number(),
    bookingDate: v.string(),
    sourceDescription: v.string(),
    sourceFingerprint: v.string(),
    subject: v.string(),
  }).index('by_subject_and_source_fingerprint', ['subject', 'sourceFingerprint']),
  savedCsvMappings: defineTable({
    amountColumn: v.string(),
    dateColumn: v.string(),
    descriptionColumn: v.string(),
    headerSignature: v.string(),
    subject: v.string(),
  }).index('by_subject_and_header_signature', ['subject', 'headerSignature']),
  csvImportReceipts: defineTable({
    accountExternalId: v.string(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    result: v.object({
      accountId: v.string(),
      importedTransactionCount: v.number(),
      outcome: v.literal('applied'),
      skippedDuplicateTransactionCount: v.number(),
      sourceAsOf: v.string(),
    }),
    subject: v.string(),
  }).index('by_subject_and_idempotency_key', ['subject', 'idempotencyKey']),
});
