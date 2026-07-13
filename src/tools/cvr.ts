import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../lasso/audit.js';
import { searchCapabilities, TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from '../lasso/capabilities.js';
import type { LassoClient } from '../lasso/client.js';
import { MAX_BATCH_CONCURRENCY } from '../lasso/batch.js';
import {
  getCvrEntitiesBatch,
  getCvrEntity,
  getCvrEntityHistory,
  getRelatedEntities,
  searchCvr,
  type CvrBatchProgress,
} from '../lasso/cvr.js';
import { getCreditsafeRating } from '../lasso/creditsafe.js';
import { getCvrChanges } from '../lasso/delta.js';
import { getCvrReports, getFinancialAnalysis } from '../lasso/financials.js';
import { changeListMembers, getListEntities, getLists, MAX_LIST_CHANGE_IDS } from '../lasso/lists.js';
import { getCvrNetwork, getOwnershipGraph } from '../lasso/network.js';
import { checkToolPolicy } from '../lasso/policy.js';
import {
  DEFAULT_SEGMENT_REQUEST_BUDGET,
  MAX_SEGMENT_REQUEST_BUDGET,
  searchCvrSegment,
  type SegmentProgress,
} from '../lasso/segment.js';
import { getCompanyPhoneNumbers, lookupPhoneNumber } from '../lasso/teledata.js';

const entityInputShape = {
  lassoId: z
    .string()
    .trim()
    .regex(/^CVR-[123]-\d+$/, 'Use a CVR Lasso ID like CVR-1-34580820.')
    .optional(),
  entityType: z.enum(['company', 'productionUnit', 'person']).optional(),
  id: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
};

const hasIdentifier = (input: { lassoId?: string; entityType?: string; id?: string | number }): boolean =>
  Boolean(input.lassoId) || (Boolean(input.entityType) && input.id !== undefined);

const entityInputSchema = z
  .object(entityInputShape)
  .refine(hasIdentifier, { message: 'Provide either lassoId or both entityType and id.' });

const fieldsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Optional dot-path field projection to shrink the response — only these fields are returned per entity. Descends nested objects and maps over arrays, e.g. ["name","cvr","status","address.streetName","address.postalCode","industry.text","management.members.name"]. Omit to return the full record (~14 KB per entity).',
  );

const entityWithFieldsSchema = z
  .object({ ...entityInputShape, fields: fieldsSchema })
  .refine(hasIdentifier, { message: 'Provide either lassoId or both entityType and id.' });

const companyEntityInputShape = {
  lassoId: z
    .string()
    .trim()
    .regex(/^CVR-1-\d+$/, 'Use a CVR company Lasso ID like CVR-1-34580820.')
    .optional(),
  entityType: z.literal('company').optional(),
  id: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
};

const personEntityInputShape = {
  lassoId: z
    .string()
    .trim()
    .regex(/^CVR-3-\d+$/, 'Use a CVR person Lasso ID like CVR-3-4004094652.')
    .optional(),
  entityType: z.literal('person').optional(),
  id: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
};

const searchFiltersSchema = z
  .object({
    company: z.string().trim().min(1).optional(),
    city: z.string().trim().min(1).optional(),
    postalCode: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    street: z.string().trim().min(1).optional(),
    streetNo: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    floor: z.string().trim().min(1).optional(),
    side: z.string().trim().min(1).optional(),
    protected: z.boolean().optional(),
    email: z.string().trim().min(1).optional(),
    telephone: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    cvr: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  })
  .optional();

export function registerCvrTools(server: McpServer, client: LassoClient): void {
  server.registerTool(
    'lassox_search_capabilities',
    {
      title: 'Search Lassox Capabilities',
      description:
        'Search the Lassox MCP server capabilities and examples. Use this first when deciding which CVR tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('lassox_search_capabilities', input, async () =>
        jsonToolResult(searchCapabilities(input.query, input.limit)),
      ),
  );

  server.registerTool(
    'cvr_search',
    {
      title: 'Search CVR',
      description:
        'Search Lassox CVR companies and people. Use this to find Lasso IDs before fetching full records. Returns Lassox pagination fields and scores unchanged.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Free-text search, CVR number, Lasso ID, or phone number.'),
        type: z.enum(['company', 'person', 'all']).default('all'),
        status: z.enum(['active', 'inactive', 'all']).default('active'),
        pageSize: z.number().int().min(1).max(100).optional(),
        continuationToken: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Continuation token from a previous search response, sent as cToken.'),
        filters: searchFiltersSchema.describe('Structured filters appended to the Lassox query as filter:value terms.'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_search', input, async () => jsonToolResult(await searchCvr(client, input))),
  );

  server.registerTool(
    'cvr_segment_search',
    {
      title: 'Segment Search (Firmographic Discovery)',
      description:
        'Discover Danish companies matching firmographic criteria: DB07 industry code prefixes, employee counts, company forms, and founding dates — anchored to a geography (postalCodes, postalCodeRanges, or region; required). The Lassox API has no server-side firmographic search, so this tool scans companies per postal code and filters fetched entities locally under a per-call request budget (maxRequests). When the response has exhausted=false, call again with continuationToken to keep scanning. Broad nationwide segments take many calls — prefer lists curated in the Lasso portal (lassox_lists_index) for those. Emits progress notifications when the client sends a progressToken.',
      inputSchema: {
        industryCodes: z
          .array(z.string().trim().regex(/^\d{1,6}$/, 'Use DB07 industry code digits, e.g. "21" or "620100".'))
          .min(1)
          .max(50)
          .optional()
          .describe('DB07 industry codes, exact or prefix ("21" matches all 21xxxx). Checked against industry and altIndustry1-3.'),
        includeAltIndustries: z.boolean().default(true),
        employeesMin: z.number().int().min(0).optional(),
        employeesMax: z.number().int().min(0).optional(),
        companyForms: z
          .array(z.string().trim().min(1))
          .max(20)
          .optional()
          .describe('Company form short names, e.g. ["A/S","ApS"]. Case-insensitive.'),
        foundedAfter: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        foundedBefore: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.enum(['active', 'inactive', 'all']).default('active'),
        postalCodes: z.array(z.number().int().min(1000).max(9999)).max(500).optional(),
        postalCodeRanges: z
          .array(z.object({ from: z.number().int().min(1000).max(9999), to: z.number().int().min(1000).max(9999) }))
          .max(50)
          .optional(),
        region: z.enum(['hovedstaden', 'sjaelland', 'syddanmark', 'midtjylland', 'nordjylland']).optional(),
        pageSize: z.number().int().min(1).max(100).optional().describe('Matches to return per call. Defaults to 25.'),
        maxRequests: z
          .number()
          .int()
          .min(10)
          .max(MAX_SEGMENT_REQUEST_BUDGET)
          .optional()
          .describe(`Upstream request budget per call (search pages + entity fetches). Defaults to ${DEFAULT_SEGMENT_REQUEST_BUDGET}.`),
        concurrency: z.number().int().min(1).max(MAX_BATCH_CONCURRENCY).optional(),
        continuationToken: z.string().trim().min(1).optional().describe('Resume token from a previous cvr_segment_search response.'),
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (input, extra) =>
      runAuditedTool('cvr_segment_search', input, async () =>
        jsonToolResult(
          await searchCvrSegment(client, input, {
            signal: extra?.signal,
            onProgress: makeSegmentProgressReporter(extra),
          }),
        ),
      ),
  );

  server.registerTool(
    'cvr_get_entity',
    {
      title: 'Get CVR Entity',
      description:
        'Fetch current Lassox CVR basic information for a company, production unit, or person. Provide either a Lasso ID or entityType plus id. Pass fields to project the response down to just the dot-paths you need.',
      inputSchema: entityWithFieldsSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_get_entity', input, async () =>
        jsonToolResult(await getCvrEntity(client, input)),
      ),
  );

  server.registerTool(
    'cvr_batch_get_entities',
    {
      title: 'Batch Get CVR Entities',
      description:
        'Fetch current Lassox CVR basic information for many entities (companies, production units, or people) in one call. Lassox has no native batch endpoint, so this fans out single-entity lookups with bounded concurrency, retries rate-limit (HTTP 429) responses, and isolates per-item failures. Returns { total, succeeded, failed, results[] } where each result is { index, label, ok, data | error }. Pass fields to project each entity down to just the dot-paths you need — strongly recommended for large batches, since the full record is ~14 KB per entity (100 items is well over 1 MB). When the MCP client sends a progressToken, incremental notifications/progress are emitted as each item completes.',
      inputSchema: {
        items: z
          .array(entityInputSchema)
          .min(1)
          .max(100)
          .describe('Entities to fetch. Each item is either { lassoId } or { entityType, id }.'),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(MAX_BATCH_CONCURRENCY)
          .optional()
          .describe(`Parallel requests, 1-${MAX_BATCH_CONCURRENCY}. Defaults to 8. Lassox allows 500 requests/minute per API key.`),
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (input, extra) =>
      runAuditedTool('cvr_batch_get_entities', input, async () =>
        jsonToolResult(
          await getCvrEntitiesBatch(client, input, {
            signal: extra?.signal,
            onProgress: makeProgressReporter(extra),
          }),
        ),
      ),
  );

  server.registerTool(
    'cvr_get_entity_history',
    {
      title: 'Get CVR Entity History',
      description:
        'Fetch historical Lassox CVR basic information. Historical fields include value/from/to/current wrappers where Lassox provides them.',
      inputSchema: entityInputSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_get_entity_history', input, async () =>
        jsonToolResult(await getCvrEntityHistory(client, input)),
      ),
  );

  server.registerTool(
    'cvr_get_reports',
    {
      title: 'Get CVR Reports (Key Figures / Nøgletal)',
      description:
        'Fetch Lassox annual report key figures (nøgletal) for a Danish company. Returns Lassox JSON converted from XBRL with metadata, balance-sheet items, EBITDA, employees, auditors, and optional group reports. Provide either a CVR-1 Lasso ID or entityType="company" with the CVR id. Optional ISO 4217 currency code requests Lassox currency conversion.',
      inputSchema: {
        ...companyEntityInputShape,
        currency: z
          .string()
          .trim()
          .regex(/^[A-Z]{3}$/, 'Use an ISO 4217 currency code such as DKK, EUR, or USD.')
          .optional()
          .describe('Optional ISO 4217 currency code for Lassox currency conversion.'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_get_reports', input, async () =>
        jsonToolResult(await getCvrReports(client, input)),
      ),
  );

  server.registerTool(
    'lassox_financial_analysis',
    {
      title: 'Get Lassox Financial Analysis',
      description:
        'Run the Lassox Financial Analysis (Regnskabsanalyse) module on a Danish company. Returns a textual analysis (HTML-formatted, e.g. <br/>, <ul>) covering gross profit, EBITDA, balance sheet, working capital, and credit policy, plus the latest and previous reports. This is a Lassox Module API and may require a separate subscription on your Lassox account.',
      inputSchema: companyEntityInputShape,
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('lassox_financial_analysis', input, async () =>
        jsonToolResult(await getFinancialAnalysis(client, input)),
      ),
  );

  server.registerTool(
    'cvr_get_network',
    {
      title: 'Get CVR Person Network',
      description:
        'Fetch a person\'s professional network from Lassox: every company the person has been connected to, current roles, and time-overlapping relations with other people. Provide either a CVR-3 Lasso ID or entityType="person" with the person id. Lassox Module API; may require a separate subscription.',
      inputSchema: personEntityInputShape,
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_get_network', input, async () =>
        jsonToolResult(await getCvrNetwork(client, input)),
      ),
  );

  server.registerTool(
    'cvr_get_ownership_graph',
    {
      title: 'Get CVR Ownership / Voting Graph',
      description:
        'Build an ownership and voting-rights graph for one or more Danish entities (companies and/or persons). Returns relations (with percentage ranges) and entities (with optional enrichment such as company info, person info, financial reports, and ultimate owner calculations). Lassox Module API; may require a separate subscription. Higher depth values traverse more edges and increase response size — start small.',
      inputSchema: {
        ids: z
          .array(z.string().trim().regex(/^CVR-[123]-\d+$/, 'Each id must be a Lasso ID like CVR-1-34580820.'))
          .min(1)
          .max(25)
          .describe('Lasso IDs to seed the graph from. CVR-1, CVR-2, or CVR-3 prefixes.'),
        relationTypes: z
          .array(z.enum(['ownership', 'votingrights', 'unknownOwnership']))
          .min(1)
          .default(['ownership']),
        enrichments: z
          .array(z.enum(['companyinfo', 'personinfo', 'reports', 'ultimateOwners']))
          .optional(),
        ingoingDepth: z.number().int().min(0).max(10).optional(),
        outgoingDepth: z.number().int().min(0).max(10).optional(),
        onDate: z
          .string()
          .trim()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO 8601 date format YYYY-MM-DD.')
          .optional()
          .describe('Optional historical snapshot date.'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_get_ownership_graph', input, async () =>
        jsonToolResult(await getOwnershipGraph(client, input)),
      ),
  );

  server.registerTool(
    'creditsafe_get_rating',
    {
      title: 'Get Creditsafe Rating',
      description:
        'Fetch the Creditsafe credit rating for a Danish company via Lassox. Returns current and previous international + local scores, descriptions, credit max, currency, and a PDF link. Lassox caches Creditsafe results for 24 hours; set skipCache=true to force a fresh upstream call (may incur extra cost).',
      inputSchema: {
        cvr: z
          .union([
            z.string().trim().regex(/^\d{8}$/, 'CVR must be 8 digits.'),
            z.number().int().min(10000000).max(99999999),
          ])
          .optional(),
        lassoId: z
          .string()
          .trim()
          .regex(/^CVR-1-\d+$/, 'Use a CVR company Lasso ID like CVR-1-34580820.')
          .optional(),
        skipCache: z.boolean().default(false),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('creditsafe_get_rating', input, async () =>
        jsonToolResult(await getCreditsafeRating(client, input)),
      ),
  );

  server.registerTool(
    'teledata_get_company_phones',
    {
      title: 'Get Company Phone Numbers (Teledata)',
      description:
        'Fetch phone numbers registered to a Danish company via the Lassox Teledata data API. Returns each phone number with supplier, registration timestamps, and consent flags. Provide either a CVR-1 Lasso ID or entityType="company" with the CVR id.',
      inputSchema: companyEntityInputShape,
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('teledata_get_company_phones', input, async () =>
        jsonToolResult(await getCompanyPhoneNumbers(client, input)),
      ),
  );

  server.registerTool(
    'teledata_lookup_phone',
    {
      title: 'Lookup Phone Number Owner (Teledata)',
      description:
        'Reverse-lookup a Danish phone number via Lassox Teledata. Returns subscriber name, address, supplier, and protection codes. Set includeCompany=true to enrich with CVR data when the number belongs to a company.',
      inputSchema: {
        phoneNumber: z
          .string()
          .trim()
          .min(6)
          .describe('Phone number, 6-15 digits, optional + prefix. Spaces, dashes, and parentheses are stripped.'),
        includeCompany: z.boolean().default(false),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('teledata_lookup_phone', input, async () =>
        jsonToolResult(await lookupPhoneNumber(client, input)),
      ),
  );

  server.registerTool(
    'lassox_lists_index',
    {
      title: 'List Lassox Lists (Tags)',
      description:
        'Fetch the Lassox lists (tags) visible to the account: id, name, entity count, type, and permissions. Lists are curated in the Lasso portal (e.g. via its target-group search) and are the recommended source for broad segments. Pass userId to read a specific user\'s private lists.',
      inputSchema: {
        userId: z.string().trim().min(1).optional().describe('Lassox user id for private lists; omit for shared lists.'),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('lassox_lists_index', input, async () =>
        jsonToolResult(await getLists(client, input)),
      ),
  );

  server.registerTool(
    'lassox_list_get_entities',
    {
      title: 'Get Lassox List Members',
      description:
        'Fetch the entities in a Lassox list (tag) with skip/take pagination. Find tag ids with lassox_lists_index. Pass fields to project each entity down to just the dot-paths you need.',
      inputSchema: {
        tagId: z.string().trim().min(1).describe('List (tag) id from lassox_lists_index.'),
        skip: z.number().int().min(0).default(0),
        take: z.number().int().min(1).max(1000).default(100),
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('lassox_list_get_entities', input, async () =>
        jsonToolResult(await getListEntities(client, input)),
      ),
  );

  server.registerTool(
    'lassox_list_change',
    {
      title: 'Change Lassox List Membership (WRITE)',
      description:
        'Add or remove entities (Lasso IDs) to/from Lassox lists (tags) in bulk. WRITE operation: modifies list membership in the shared Lasso portal — it never modifies CVR data. Idempotent per (entity, list) pair. Find tag ids with lassox_lists_index.',
      inputSchema: {
        lassoIds: z
          .array(z.string().trim().regex(/^CVR-[123]-\d+$/, 'Each id must be a Lasso ID like CVR-1-34580820.'))
          .min(1)
          .max(MAX_LIST_CHANGE_IDS),
        tagsToAdd: z.array(z.string().trim().min(1)).max(50).optional(),
        tagsToRemove: z.array(z.string().trim().min(1)).max(50).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('lassox_list_change', input, async () =>
        jsonToolResult(await changeListMembers(client, input)),
      ),
  );

  server.registerTool(
    'cvr_get_changes',
    {
      title: 'Get CVR Changes (Delta)',
      description:
        'Fetch entities changed since a timestamp via the Lassox delta endpoints. scope selects companies, persons, places (production units), or annual reports. useLastLoad defaults to true (Lassox-recommended: filters on publication time so late-published changes are not missed). Optional lassoIds filters the page client-side to just those entities; fields projects each result. Paginate with continuationToken. For real-time needs, Lassox monitoring/webhooks are better than tight polling.',
      inputSchema: {
        scope: z.enum(['company', 'person', 'place', 'reports']).default('company'),
        since: z
          .string()
          .trim()
          .min(10)
          .describe('Minimum update time, ISO date or datetime, e.g. 2026-07-01 or 2026-07-01T00:00:00.'),
        max: z.string().trim().min(10).optional().describe('Optional maximum update time.'),
        pageSize: z.number().int().min(1).max(1000).optional(),
        continuationToken: z.string().trim().min(1).optional().describe('Continuation token from a previous response, sent as cToken.'),
        useLastLoad: z.boolean().default(true),
        maxDaysSinceUpdate: z.number().int().min(1).max(365).optional(),
        history: z.boolean().default(false).describe('Return historical value wrappers. Not for scope "reports".'),
        metadataOnly: z.boolean().optional().describe('Reports only: return metadata without full figures.'),
        lassoIds: z
          .array(z.string().trim().regex(/^CVR-[123]-\d+$/))
          .max(1000)
          .optional()
          .describe('Client-side filter: only return changes for these Lasso IDs.'),
        fields: fieldsSchema,
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_get_changes', input, async () =>
        jsonToolResult(await getCvrChanges(client, input)),
      ),
  );

  server.registerTool(
    'cvr_get_related',
    {
      title: 'Get Related CVR Entities',
      description:
        'Fetch related CVR entities using documented relations: company to person/place, or productionUnit to company. Set history=true for relation history.',
      inputSchema: entityInputSchema.extend({
        relatedType: z.enum(['person', 'place', 'company']),
        history: z.boolean().default(false),
      }),
      annotations: TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('cvr_get_related', input, async () =>
        jsonToolResult(await getRelatedEntities(client, input)),
      ),
  );
}

async function runAuditedTool<T>(tool: string, input: unknown, call: () => Promise<T>): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({
      tool,
      action: 'policy_denied',
      target,
      reason: policy.reason,
    });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason });

  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
    });
    throw error;
  }
}

interface ProgressCapableExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/**
 * Builds an onProgress callback that streams MCP progress notifications, but
 * only when the client opted in by sending a progressToken. Returns undefined
 * otherwise so the batch runner skips progress work entirely.
 */
function makeProgressReporter(
  extra: ProgressCapableExtra | undefined,
): ((progress: CvrBatchProgress) => Promise<void>) | undefined {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;
  if (progressToken === undefined || !sendNotification) {
    return undefined;
  }

  return async progress => {
    const status = progress.ok ? 'ok' : `error: ${progress.error ?? 'failed'}`;
    await sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: progress.completed,
        total: progress.total,
        message: `${progress.completed}/${progress.total} — ${progress.label} ${status}`,
      },
    });
  };
}

/** Progress notifications for segment scans, keyed on the request budget. */
function makeSegmentProgressReporter(
  extra: ProgressCapableExtra | undefined,
): ((progress: SegmentProgress) => Promise<void>) | undefined {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;
  if (progressToken === undefined || !sendNotification) {
    return undefined;
  }

  return async progress => {
    await sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: progress.requestsUsed,
        total: progress.requestBudget,
        message: `postal ${progress.postalCode}: scanned ${progress.scanned}, matched ${progress.matched} (${progress.requestsUsed}/${progress.requestBudget} requests)`,
      },
    });
  };
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const value = input as Record<string, unknown>;
  return {
    itemCount: Array.isArray(value.items) ? value.items.length : undefined,
    concurrency: value.concurrency,
    fields: value.fields,
    lassoId: value.lassoId,
    entityType: value.entityType,
    id: value.id,
    relatedType: value.relatedType,
    history: value.history,
    query: value.query,
    type: value.type,
    status: value.status,
    currency: value.currency,
    cvr: value.cvr,
    skipCache: value.skipCache,
    phoneNumber: value.phoneNumber,
    includeCompany: value.includeCompany,
    ids: value.ids,
    relationTypes: value.relationTypes,
    enrichments: value.enrichments,
    ingoingDepth: value.ingoingDepth,
    outgoingDepth: value.outgoingDepth,
    onDate: value.onDate,
    industryCodes: value.industryCodes,
    employeesMin: value.employeesMin,
    employeesMax: value.employeesMax,
    companyForms: value.companyForms,
    region: value.region,
    postalCodeCount: Array.isArray(value.postalCodes) ? value.postalCodes.length : undefined,
    postalCodeRanges: value.postalCodeRanges,
    maxRequests: value.maxRequests,
    tagId: value.tagId,
    userId: value.userId,
    lassoIdCount: Array.isArray(value.lassoIds) ? value.lassoIds.length : undefined,
    tagsToAdd: value.tagsToAdd,
    tagsToRemove: value.tagsToRemove,
    scope: value.scope,
    since: value.since,
    max: value.max,
    useLastLoad: value.useLastLoad,
    metadataOnly: value.metadataOnly,
  };
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
