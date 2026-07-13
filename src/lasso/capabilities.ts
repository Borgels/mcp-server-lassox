export type CapabilityRisk = 'read' | 'write';

export interface LassoCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** For the list-membership write tool: not read-only, but non-destructive and idempotent. */
export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const LASSO_CAPABILITIES: LassoCapability[] = [
  {
    id: 'lassox_search_capabilities',
    title: 'Search Lassox Capabilities',
    description: 'Find the Lassox MCP tool to use for CVR lookup, history, relations, or search.',
    risk: 'read',
    examples: [{ query: 'company search' }],
    identifierFormats: ['Tool id such as cvr_search or cvr_get_entity.'],
    safetyNotes: ['Discovery only. Does not call Lassox.'],
    keywords: ['discover', 'search tools', 'help', 'capabilities'],
  },
  {
    id: 'cvr_search',
    title: 'Search CVR',
    description:
      'Search Lassox CVR companies and people. Use this to find Lasso IDs before fetching full records.',
    risk: 'read',
    examples: [{ query: 'Lasso X', type: 'company', pageSize: 5 }],
    identifierFormats: ['Free text', 'CVR number', 'phone number', 'Lasso ID'],
    safetyNotes: ['Read-only. Returns Lassox pagination fields and scores unchanged.'],
    keywords: ['search', 'company', 'person', 'cvr', 'lookup'],
  },
  {
    id: 'cvr_get_entity',
    title: 'Get CVR Entity',
    description:
      'Fetch current CVR basic information for a company, production unit, or person.',
    risk: 'read',
    examples: [
      { entityType: 'company', id: '34580820' },
      { lassoId: 'CVR-1-34580820', fields: ['name', 'cvr', 'status', 'address.streetName'] },
    ],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}', 'CVR-3-{personId}'],
    safetyNotes: [
      'Read-only. Does not fetch historical field wrappers.',
      'Optional fields[] projects the response to just those dot-paths to reduce size.',
    ],
    keywords: ['current', 'entity', 'company', 'production unit', 'person', 'fields', 'projection'],
  },
  {
    id: 'cvr_batch_get_entities',
    title: 'Batch Get CVR Entities',
    description:
      'Fetch current CVR basic information for many entities in one call. Fans out single-entity lookups with bounded concurrency, retries HTTP 429, and isolates per-item failures. Emits MCP progress notifications when the client sends a progressToken.',
    risk: 'read',
    examples: [
      {
        items: [{ entityType: 'company', id: '34580820' }, { lassoId: 'CVR-1-34580821' }],
        concurrency: 8,
        fields: ['name', 'cvr', 'status', 'address.postalCode', 'industry.text'],
      },
    ],
    identifierFormats: ['Array of { lassoId } or { entityType, id } items.'],
    safetyNotes: [
      'Read-only. Lassox has no native batch endpoint; this fans out individual lookups.',
      'Per-item failures are isolated and reported in results[]; the call does not throw on a single bad item.',
      'Respects the 500 requests/minute Lassox rate limit via bounded concurrency and 429 retry.',
      'Pass fields[] to project each entity to just those dot-paths — recommended for large batches (full records are ~14 KB each).',
    ],
    keywords: [
      'batch',
      'bulk',
      'multiple',
      'many',
      'list',
      'mass',
      'entities',
      'companies',
      'parallel',
      'progress',
      'fields',
      'projection',
      'filter',
    ],
  },
  {
    id: 'cvr_get_entity_history',
    title: 'Get CVR Entity History',
    description: 'Fetch historical CVR basic information for a company, production unit, or person.',
    risk: 'read',
    examples: [{ lassoId: 'CVR-1-34580820' }],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}', 'CVR-3-{personId}'],
    safetyNotes: ['Read-only. Historical responses are returned unchanged from Lassox.'],
    keywords: ['history', 'historical', 'entity', 'changes'],
  },
  {
    id: 'cvr_get_related',
    title: 'Get Related CVR Entities',
    description:
      'Fetch documented related entities: company to person/place, or production unit to company.',
    risk: 'read',
    examples: [{ entityType: 'company', id: '34580820', relatedType: 'person' }],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}'],
    safetyNotes: ['Read-only. Unsupported relation combinations are rejected before calling Lassox.'],
    keywords: ['related', 'relation', 'person', 'place', 'production unit'],
  },
  {
    id: 'cvr_get_reports',
    title: 'Get CVR Reports (Key Figures / Nøgletal)',
    description:
      'Fetch annual report key figures (nøgletal) for a Danish company, converted by Lassox from XBRL.',
    risk: 'read',
    examples: [
      { entityType: 'company', id: '34580820' },
      { lassoId: 'CVR-1-34580820', currency: 'EUR' },
    ],
    identifierFormats: ['CVR-1-{cvr}'],
    safetyNotes: [
      'Read-only. Only company Lasso IDs (CVR-1-*) are accepted.',
      'Optional ISO 4217 currency code triggers Lassox currency conversion.',
    ],
    keywords: [
      'reports',
      'nøgletal',
      'key figures',
      'finance',
      'financial',
      'xbrl',
      'annual report',
      'regnskab',
      'ebitda',
    ],
  },
  {
    id: 'cvr_get_network',
    title: 'Get CVR Person Network',
    description:
      'Fetch a person\'s professional network from Lassox: connected companies, current roles, and time-overlapping relations with other people.',
    risk: 'read',
    examples: [
      { entityType: 'person', id: '4004094652' },
      { lassoId: 'CVR-3-4004094652' },
    ],
    identifierFormats: ['CVR-3-{personId}'],
    safetyNotes: [
      'Read-only. Only person Lasso IDs (CVR-3-*) are accepted.',
      'Lassox Module API. May require a separate subscription.',
    ],
    keywords: ['network', 'netværk', 'person', 'roles', 'connections', 'professional'],
  },
  {
    id: 'cvr_get_ownership_graph',
    title: 'Get CVR Ownership / Voting Graph',
    description:
      'Build an ownership and voting-rights graph for one or more entities, with optional enrichment (company info, person info, financial reports, ultimate owners).',
    risk: 'read',
    examples: [
      {
        ids: ['CVR-1-34580820'],
        relationTypes: ['ownership'],
        enrichments: ['companyinfo', 'ultimateOwners'],
        outgoingDepth: 2,
      },
    ],
    identifierFormats: ['CVR-1-{cvr}', 'CVR-2-{pNumber}', 'CVR-3-{personId}'],
    safetyNotes: [
      'Read-only. Lassox Module API; may require a separate subscription.',
      'Higher depth values traverse more edges and increase response size — start small.',
      'Up to 25 seed ids and depth 0-10 are accepted.',
    ],
    keywords: [
      'ownership',
      'ejerstruktur',
      'voting',
      'votingrights',
      'ubo',
      'ultimate owners',
      'beneficial',
      'graph',
      'shareholders',
    ],
  },
  {
    id: 'creditsafe_get_rating',
    title: 'Get Creditsafe Rating',
    description:
      'Fetch the Creditsafe credit rating for a Danish company via Lassox. Returns current and previous scores, descriptions, credit max, currency, and a PDF link.',
    risk: 'read',
    examples: [
      { cvr: '34580820' },
      { lassoId: 'CVR-1-34580820', skipCache: true },
    ],
    identifierFormats: ['8-digit CVR', 'CVR-1-{cvr}'],
    safetyNotes: [
      'Read-only. Lassox caches Creditsafe responses for 24 hours.',
      'skipCache=true forces a fresh upstream call and may incur extra cost.',
    ],
    keywords: ['creditsafe', 'credit', 'rating', 'kredit', 'score', 'risk', 'due diligence'],
  },
  {
    id: 'teledata_get_company_phones',
    title: 'Get Company Phone Numbers (Teledata)',
    description: 'Fetch phone numbers registered to a Danish company via the Lassox Teledata API.',
    risk: 'read',
    examples: [{ entityType: 'company', id: '34580820' }, { lassoId: 'CVR-1-34580820' }],
    identifierFormats: ['CVR-1-{cvr}'],
    safetyNotes: ['Read-only. Only company Lasso IDs are accepted.'],
    keywords: ['teledata', 'phone', 'phonenumbers', 'telefon', 'numbers', 'subscriber'],
  },
  {
    id: 'teledata_lookup_phone',
    title: 'Lookup Phone Number Owner (Teledata)',
    description:
      'Reverse-lookup a Danish phone number via Lassox Teledata. Returns subscriber name, address, supplier, and protection codes.',
    risk: 'read',
    examples: [
      { phoneNumber: '70201020' },
      { phoneNumber: '+4570201020', includeCompany: true },
    ],
    identifierFormats: ['6-15 digit phone number, optional + prefix'],
    safetyNotes: [
      'Read-only. Returns publicly-registered subscriber data; respect Danish privacy rules.',
      'Set includeCompany=true to enrich with CVR data when the number belongs to a company.',
    ],
    keywords: ['teledata', 'phone', 'lookup', 'reverse', 'telefon', 'subscriber', 'owner'],
  },
  {
    id: 'lassox_financial_analysis',
    title: 'Get Lassox Financial Analysis',
    description:
      'Run the Lassox Financial Analysis (Regnskabsanalyse) module on a Danish company. Returns HTML-formatted textual analysis plus the latest and previous reports.',
    risk: 'read',
    examples: [
      { entityType: 'company', id: '34580820' },
      { lassoId: 'CVR-1-34580820' },
    ],
    identifierFormats: ['CVR-1-{cvr}'],
    safetyNotes: [
      'Read-only. Only company Lasso IDs (CVR-1-*) are accepted.',
      'Lassox Module API. May require a separate subscription on your Lassox account.',
      'Response text contains HTML formatting tags such as <br/> and <ul>.',
    ],
    keywords: [
      'financial analysis',
      'regnskabsanalyse',
      'module',
      'analysis',
      'credit',
      'ebitda',
      'working capital',
    ],
  },
  {
    id: 'cvr_segment_search',
    title: 'Segment Search (Firmographic Discovery)',
    description:
      'Discover companies matching firmographic criteria: industry code prefixes, employee counts, company forms, founding dates — anchored to postal codes, postal ranges, or a Danish region. Scans postal codes via Lassox search and filters fetched entities locally under a per-call request budget; resumable via continuationToken.',
    risk: 'read',
    examples: [
      {
        industryCodes: ['21'],
        employeesMin: 1000,
        region: 'hovedstaden',
        maxRequests: 300,
      },
      {
        industryCodes: ['10', '11'],
        employeesMin: 50,
        employeesMax: 500,
        postalCodeRanges: [{ from: 7400, to: 7500 }],
      },
    ],
    identifierFormats: ['DB07 industry code prefixes', '4-digit postal codes', 'Danish region names'],
    safetyNotes: [
      'Read-only. The Lassox API has no server-side firmographic search, so this scans postal codes and filters locally.',
      'A geographic anchor (postalCodes, postalCodeRanges, or region) is required; broad segments take many calls — for nationwide segments use lists curated in the Lasso portal instead.',
      'Bounded by maxRequests per call; resume with continuationToken until exhausted=true.',
    ],
    keywords: [
      'segment',
      'discovery',
      'prospecting',
      'firmographic',
      'industry',
      'branchekode',
      'employees',
      'region',
      'målgruppe',
      'target group',
    ],
  },
  {
    id: 'lassox_lists_index',
    title: 'List Lassox Lists (Tags)',
    description:
      'Fetch the Lassox lists (tags) visible to the account — id, name, entity count, and permissions. Lists are curated in the Lasso portal (e.g. via target-group search) and consumed here.',
    risk: 'read',
    examples: [{}, { userId: 'user-id-for-private-lists' }],
    identifierFormats: ['Optional Lassox userId for private lists.'],
    safetyNotes: ['Read-only. Lists are created and curated in the Lasso portal; the API cannot create lists.'],
    keywords: ['lists', 'tags', 'lister', 'segments', 'portal', 'index'],
  },
  {
    id: 'lassox_list_get_entities',
    title: 'Get Lassox List Members',
    description:
      'Fetch the entities in a Lassox list (tag) with skip/take pagination. Pass fields to project each entity down to the dot-paths you need.',
    risk: 'read',
    examples: [{ tagId: 'cHfb90', take: 100 }, { tagId: 'cHfb90', fields: ['lassoId', 'name'] }],
    identifierFormats: ['tagId from lassox_lists_index.'],
    safetyNotes: ['Read-only.'],
    keywords: ['list members', 'tag entities', 'lists', 'segment members'],
  },
  {
    id: 'lassox_list_change',
    title: 'Change Lassox List Membership',
    description:
      'Add or remove entities (Lasso IDs) to/from Lassox lists (tags) in bulk. The only write tool in this server — it changes list membership, never CVR data.',
    risk: 'write',
    examples: [
      { lassoIds: ['CVR-1-34580820'], tagsToAdd: ['cHfb90'] },
      { lassoIds: ['CVR-1-34580820'], tagsToRemove: ['cHfb90'] },
    ],
    identifierFormats: ['CVR-{1|2|3}-{id} Lasso IDs', 'tagId from lassox_lists_index.'],
    safetyNotes: [
      'WRITE operation: modifies list membership in the shared Lasso portal.',
      'Non-destructive and idempotent per (entity, list) pair; CVR data itself is never modified.',
    ],
    keywords: ['add to list', 'remove from list', 'tag', 'untag', 'write', 'membership'],
  },
  {
    id: 'cvr_get_changes',
    title: 'Get CVR Changes (Delta)',
    description:
      'Fetch entities changed since a timestamp via the Lassox delta endpoints — companies, persons, production units (places), or annual reports. Use for keeping downstream systems (e.g. a CRM) in sync. Supports useLastLoad (recommended, default true), pagination, optional client-side filtering to a set of Lasso IDs, and field projection.',
    risk: 'read',
    examples: [
      { scope: 'company', since: '2026-07-01', pageSize: 50 },
      { scope: 'reports', since: '2026-07-01', metadataOnly: true },
      { scope: 'company', since: '2026-07-01', lassoIds: ['CVR-1-34580820'], fields: ['lassoId', 'name', 'status'] },
    ],
    identifierFormats: ['ISO date or datetime for since/max.'],
    safetyNotes: [
      'Read-only. useLastLoad=true is the Lassox-recommended default to avoid missing late-published changes.',
      'For real-time needs consider Lassox monitoring/webhooks instead of tight polling loops.',
    ],
    keywords: ['delta', 'changes', 'sync', 'since', 'poll', 'updates', 'crm sync', 'pipedrive'],
  },
];

export function searchCapabilities(query: string, limit = 20): LassoCapability[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return LASSO_CAPABILITIES.slice(0, limit);
  }

  return LASSO_CAPABILITIES.map(capability => ({
    capability,
    score: scoreCapability(capability, normalized),
  }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: LassoCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
