import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { ConvexError, v } from 'convex/values';

const coverageState = v.union(
  v.literal('imported'),
  v.literal('manual'),
  v.literal('excluded'),
  v.literal('missing'),
);

const mapping = v.object({
  amountColumn: v.string(),
  dateColumn: v.string(),
  descriptionColumn: v.string(),
});

const importResult = v.object({
  accountId: v.string(),
  importedTransactionCount: v.number(),
  outcome: v.union(v.literal('applied'), v.literal('replayed')),
  skippedDuplicateTransactionCount: v.number(),
  sourceAsOf: v.string(),
});

export const importCsv = mutation({
  args: {
    accountExternalId: v.string(),
    accountName: v.string(),
    csv: v.string(),
    idempotencyKey: v.string(),
    mapping: v.optional(mapping),
  },
  returns: v.union(importResult, v.object({ type: v.literal('idempotency_key_conflict') })),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateImportRequest(request);
    const requestFingerprint = JSON.stringify(request);
    const existingReceipt = await ctx.db
      .query('csvImportReceipts')
      .withIndex('by_subject_and_idempotency_key', (index) =>
        index.eq('subject', subject).eq('idempotencyKey', request.idempotencyKey),
      )
      .unique();

    if (existingReceipt) {
      if (existingReceipt.requestFingerprint !== requestFingerprint) {
        return { type: 'idempotency_key_conflict' } as const;
      }

      return { ...existingReceipt.result, outcome: 'replayed' } as const;
    }

    const parsed = parseCsv(request.csv);
    const headerSignature = parsed.headers.join('\u001f');
    const resolvedMapping = await resolveMapping(ctx, subject, headerSignature, request.mapping);
    const rows = toTransactions(parsed, resolvedMapping);
    const sourceAsOf = rows.reduce(
      (latest, row) => (row.bookingDate > latest ? row.bookingDate : latest),
      rows[0]?.bookingDate,
    );

    if (!sourceAsOf) {
      throw new ConvexError({ code: 'csv_contains_no_transactions' });
    }

    const account = await upsertImportedAccount(ctx, subject, request, sourceAsOf);
    let importedTransactionCount = 0;
    let skippedDuplicateTransactionCount = 0;

    for (const row of rows) {
      const sourceFingerprint = await fingerprint(
        [
          request.accountExternalId,
          row.bookingDate,
          row.sourceDescription,
          String(row.amountCents),
        ].join('\u001f'),
      );
      const existing = await ctx.db
        .query('importedTransactions')
        .withIndex('by_subject_and_source_fingerprint', (index) =>
          index.eq('subject', subject).eq('sourceFingerprint', sourceFingerprint),
        )
        .unique();

      if (existing) {
        skippedDuplicateTransactionCount += 1;
        continue;
      }

      await ctx.db.insert('importedTransactions', {
        accountId: account._id,
        amountCents: row.amountCents,
        bookingDate: row.bookingDate,
        sourceDescription: row.sourceDescription,
        sourceFingerprint,
        subject,
      });
      importedTransactionCount += 1;
    }

    const result = {
      accountId: account._id,
      importedTransactionCount,
      outcome: 'applied' as const,
      skippedDuplicateTransactionCount,
      sourceAsOf,
    };
    await ctx.db.insert('csvImportReceipts', {
      accountExternalId: request.accountExternalId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      result,
      subject,
    });

    return result;
  },
});

export const upsertManualAccount = mutation({
  args: { accountExternalId: v.string(), accountName: v.string() },
  returns: v.object({ accountExternalId: v.string(), state: coverageState }),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateAccount(request);
    const account = await findAccount(ctx, subject, request.accountExternalId);

    if (account) {
      await ctx.db.patch(account._id, { accountName: request.accountName, state: 'manual' });
    } else {
      await ctx.db.insert('financeAccounts', {
        ...request,
        state: 'manual',
        subject,
        workspaceId: await workspaceIdForSubject(subject),
      });
    }

    return { accountExternalId: request.accountExternalId, state: 'manual' } as const;
  },
});

export const setAccountCoverageState = mutation({
  args: { accountExternalId: v.string(), accountName: v.string(), state: coverageState },
  returns: v.object({ accountExternalId: v.string(), state: coverageState }),
  handler: async (ctx, request) => {
    const subject = await requireSubject(ctx);
    validateAccount(request);
    const account = await findAccount(ctx, subject, request.accountExternalId);

    if (account) {
      await ctx.db.patch(account._id, { accountName: request.accountName, state: request.state });
    } else {
      await ctx.db.insert('financeAccounts', {
        ...request,
        subject,
        workspaceId: await workspaceIdForSubject(subject),
      });
    }

    return { accountExternalId: request.accountExternalId, state: request.state };
  },
});

export const getAllowanceCoverage = query({
  args: {},
  returns: v.object({
    accounts: v.array(
      v.object({
        accountExternalId: v.string(),
        accountName: v.string(),
        lastImportedAt: v.optional(v.number()),
        sourceAsOf: v.optional(v.string()),
        state: coverageState,
      }),
    ),
    allowanceQualified: v.boolean(),
    missingAccountExternalIds: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const subject = await requireSubject(ctx);
    const accounts = await ctx.db
      .query('financeAccounts')
      .withIndex('by_subject_and_external_id', (index) => index.eq('subject', subject))
      .collect();
    const normalized = accounts
      .map(({ accountExternalId, accountName, lastImportedAt, sourceAsOf, state }) => ({
        accountExternalId,
        accountName,
        lastImportedAt,
        sourceAsOf,
        state,
      }))
      .sort((left, right) => left.accountExternalId.localeCompare(right.accountExternalId));
    const missingAccountExternalIds = normalized
      .filter((account) => account.state === 'missing')
      .map((account) => account.accountExternalId);

    return {
      accounts: normalized,
      allowanceQualified: missingAccountExternalIds.length === 0,
      missingAccountExternalIds,
    };
  },
});

type CsvRow = { amountCents: number; bookingDate: string; sourceDescription: string };

async function resolveMapping(
  ctx: MutationCtx,
  subject: string,
  headerSignature: string,
  suppliedMapping:
    { amountColumn: string; dateColumn: string; descriptionColumn: string } | undefined,
) {
  const saved = await ctx.db
    .query('savedCsvMappings')
    .withIndex('by_subject_and_header_signature', (index) =>
      index.eq('subject', subject).eq('headerSignature', headerSignature),
    )
    .unique();
  const resolved = suppliedMapping ?? saved;

  if (!resolved) {
    throw new ConvexError({ code: 'csv_mapping_required' });
  }

  if (
    suppliedMapping &&
    (!saved || JSON.stringify(savedMapping(saved)) !== JSON.stringify(suppliedMapping))
  ) {
    if (saved) {
      await ctx.db.patch(saved._id, suppliedMapping);
    } else {
      await ctx.db.insert('savedCsvMappings', { ...suppliedMapping, headerSignature, subject });
    }
  }

  return savedMapping(resolved);
}

function savedMapping(mappingValue: {
  amountColumn: string;
  dateColumn: string;
  descriptionColumn: string;
}) {
  return {
    amountColumn: mappingValue.amountColumn,
    dateColumn: mappingValue.dateColumn,
    descriptionColumn: mappingValue.descriptionColumn,
  };
}

function parseCsv(csv: string): {
  headers: readonly string[];
  rows: readonly Record<string, string>[];
} {
  const cells = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);

  const [rawHeaderCells, ...dataCells] = cells;
  const headerCells = rawHeaderCells?.map((header) => header.trim());
  if (
    !headerCells ||
    headerCells.length === 0 ||
    new Set(headerCells).size !== headerCells.length
  ) {
    throw new ConvexError({ code: 'invalid_csv_headers' });
  }

  return {
    headers: headerCells,
    rows: dataCells.map((cells) => {
      if (cells.length !== headerCells.length) {
        throw new ConvexError({ code: 'invalid_csv_row' });
      }
      return Object.fromEntries(headerCells.map((header, index) => [header, cells[index] ?? '']));
    }),
  };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      result.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new ConvexError({ code: 'invalid_csv_quoting' });
  }

  result.push(cell);
  return result;
}

function toTransactions(
  parsed: { headers: readonly string[]; rows: readonly Record<string, string>[] },
  resolvedMapping: { amountColumn: string; dateColumn: string; descriptionColumn: string },
): CsvRow[] {
  const columns = [
    resolvedMapping.amountColumn,
    resolvedMapping.dateColumn,
    resolvedMapping.descriptionColumn,
  ];
  if (
    new Set(columns).size !== columns.length ||
    !columns.every((column) => parsed.headers.includes(column))
  ) {
    throw new ConvexError({ code: 'invalid_csv_mapping' });
  }

  return parsed.rows.map((row) => {
    const bookingDate = row[resolvedMapping.dateColumn] ?? '';
    const sourceDescription = row[resolvedMapping.descriptionColumn] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate) || sourceDescription.trim().length === 0) {
      throw new ConvexError({ code: 'invalid_csv_transaction' });
    }

    return {
      amountCents: parseAmountCents(row[resolvedMapping.amountColumn] ?? ''),
      bookingDate,
      sourceDescription,
    };
  });
}

function parseAmountCents(value: string): number {
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new ConvexError({ code: 'invalid_csv_amount' });
  }

  const [whole, fractional = ''] = normalized.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
  const signed = normalized.startsWith('-') ? -cents : cents;
  if (!Number.isSafeInteger(signed)) {
    throw new ConvexError({ code: 'invalid_csv_amount' });
  }
  return signed;
}

async function upsertImportedAccount(
  ctx: MutationCtx,
  subject: string,
  request: { accountExternalId: string; accountName: string },
  sourceAsOf: string,
) {
  const account = await findAccount(ctx, subject, request.accountExternalId);
  const patch = {
    accountName: request.accountName,
    lastImportedAt: Date.now(),
    sourceAsOf,
    state: 'imported' as const,
  };
  if (account) {
    await ctx.db.patch(account._id, patch);
    return { ...account, ...patch };
  }

  const id = await ctx.db.insert('financeAccounts', {
    ...patch,
    accountExternalId: request.accountExternalId,
    subject,
    workspaceId: await workspaceIdForSubject(subject),
  });
  return { _id: id, ...patch };
}

function findAccount(ctx: MutationCtx, subject: string, accountExternalId: string) {
  return ctx.db
    .query('financeAccounts')
    .withIndex('by_subject_and_external_id', (index) =>
      index.eq('subject', subject).eq('accountExternalId', accountExternalId),
    )
    .unique();
}

function validateImportRequest(request: {
  accountExternalId: string;
  accountName: string;
  idempotencyKey: string;
}) {
  validateAccount(request);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(request.idempotencyKey)) {
    throw new ConvexError({ code: 'invalid_import_request' });
  }
}

function validateAccount(request: { accountExternalId: string; accountName: string }) {
  if (
    request.accountExternalId.trim().length === 0 ||
    request.accountExternalId.length > 128 ||
    request.accountName.trim().length === 0 ||
    request.accountName.length > 256
  ) {
    throw new ConvexError({ code: 'invalid_account' });
  }
}

async function requireSubject(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) {
    throw new ConvexError({ code: 'authentication_required' });
  }
  return identity.subject;
}

async function workspaceIdForSubject(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject));
  const encoded = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `workspace_${encoded.slice(0, 22)}`;
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
