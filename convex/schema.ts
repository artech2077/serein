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
});
