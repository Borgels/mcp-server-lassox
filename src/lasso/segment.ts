import { callWithRateLimitRetry, runBatch } from './batch.js';
import type { LassoClient } from './client.js';
import { selectFields } from './fields.js';

/**
 * Firmographic segment discovery over the Lassox CVR API.
 *
 * The Lassox search endpoint only supports free text plus address/contact
 * filters (`postalcode:`, `city:`, ...) — industry, employee counts, company
 * form, and founding date are NOT queryable server-side. This module therefore
 * runs a bounded scan-and-filter pipeline: it enumerates companies per postal
 * code via filter-only searches, fetches candidate entities with the existing
 * rate-limit-aware batch machinery, and applies the firmographic criteria
 * locally. A per-call request budget plus a continuation token keeps every
 * call bounded; broad nationwide segments should instead be curated in the
 * Lasso portal and consumed through the Lists tools.
 */

export type SegmentStatus = 'active' | 'inactive' | 'all';

export type DanishRegion =
  | 'hovedstaden'
  | 'sjaelland'
  | 'syddanmark'
  | 'midtjylland'
  | 'nordjylland';

export interface PostalCodeRange {
  from: number;
  to: number;
}

/**
 * Administrative regions approximated by postal code ranges. Postal codes do
 * not map perfectly onto regions at the boundaries; callers needing precision
 * should pass explicit postalCodes/postalCodeRanges instead.
 */
export const REGION_POSTAL_RANGES: Record<DanishRegion, PostalCodeRange[]> = {
  hovedstaden: [{ from: 1000, to: 3799 }],
  sjaelland: [{ from: 4000, to: 4999 }],
  syddanmark: [{ from: 5000, to: 7299 }],
  midtjylland: [{ from: 7300, to: 8999 }],
  nordjylland: [{ from: 9000, to: 9999 }],
};

export const DEFAULT_SEGMENT_PAGE_SIZE = 25;
export const MAX_SEGMENT_PAGE_SIZE = 100;
export const DEFAULT_SEGMENT_REQUEST_BUDGET = 150;
export const MAX_SEGMENT_REQUEST_BUDGET = 500;
const SEARCH_PAGE_SIZE = 100;
const MAX_RESOLVED_POSTAL_CODES = 4000;

export const DEFAULT_SEGMENT_FIELDS = [
  'lassoId',
  'name',
  'cvr',
  'status',
  'industry.code',
  'industry.text',
  'employees.count',
  'address.postalCode',
  'address.city',
  'address.postalDistrict',
];

export interface SegmentSearchInput {
  /** DB07 industry codes, exact or prefix ("21" matches all 21xxxx). */
  industryCodes?: string[];
  /** Also match altIndustry1-3 codes. Defaults to true. */
  includeAltIndustries?: boolean;
  employeesMin?: number;
  employeesMax?: number;
  /** Company form short descriptions, e.g. "A/S", "ApS". Case-insensitive. */
  companyForms?: string[];
  /** ISO date (YYYY-MM-DD); compared against lifeTime.from. */
  foundedAfter?: string;
  foundedBefore?: string;
  status?: SegmentStatus;
  postalCodes?: number[];
  postalCodeRanges?: PostalCodeRange[];
  region?: DanishRegion;
  /** Matches to return per call. */
  pageSize?: number;
  /** Upstream requests to spend per call (search pages + entity fetches). */
  maxRequests?: number;
  concurrency?: number;
  continuationToken?: string;
  /** Dot-path projection for matched companies. Defaults to DEFAULT_SEGMENT_FIELDS. */
  fields?: string[];
}

export interface SegmentProgress {
  requestsUsed: number;
  requestBudget: number;
  scanned: number;
  matched: number;
  postalCode: number;
}

export interface SegmentSearchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SegmentProgress) => void | Promise<void>;
}

export interface SegmentSearchResult {
  matched: number;
  results: unknown[];
  /** Candidate companies examined (entity fetched or filtered from search). */
  scanned: number;
  requestsUsed: number;
  exhausted: boolean;
  continuationToken?: string;
  coverage: {
    postalCodesTotal: number;
    postalCodesCompleted: number;
  };
  note?: string;
}

interface ScanCursor {
  v: 1;
  /** Hash binding the token to the criteria it was issued for. */
  f: string;
  /** Index into the resolved postal code list. */
  i: number;
  /** Lassox continuation token within the current postal code, if any. */
  c: string | null;
}

interface SearchEnvelope {
  companies?: {
    continuationToken?: string;
    hasNextPage?: boolean;
    results?: Array<{ lassoId?: string }>;
  };
}

interface CandidateEntity {
  lassoId?: string;
  status?: string;
  form?: { code?: number; shortDescription?: string };
  industry?: { code?: string | number } | null;
  altIndustry1?: { code?: string | number } | null;
  altIndustry2?: { code?: string | number } | null;
  altIndustry3?: { code?: string | number } | null;
  employees?: { count?: number | null; interval?: string | null } | null;
  lifeTime?: { from?: string | null } | null;
}

export function resolvePostalCodes(input: SegmentSearchInput): number[] {
  const codes = new Set<number>();

  for (const code of input.postalCodes ?? []) {
    assertPostalCode(code);
    codes.add(code);
  }

  const ranges = [...(input.postalCodeRanges ?? [])];
  if (input.region) {
    ranges.push(...REGION_POSTAL_RANGES[input.region]);
  }

  for (const range of ranges) {
    assertPostalCode(range.from);
    assertPostalCode(range.to);
    if (range.to < range.from) {
      throw new Error(`Postal code range is inverted: ${range.from}-${range.to}.`);
    }
    for (let code = range.from; code <= range.to; code += 1) {
      codes.add(code);
    }
  }

  if (codes.size === 0) {
    throw new Error(
      'cvr_segment_search needs a geographic anchor: postalCodes, postalCodeRanges, or region. ' +
        'The Lassox API has no nationwide firmographic search, so unanchored segments cannot be ' +
        'scanned within the request budget. For broad segments, build the list with the Lasso ' +
        "portal's target-group search and read it via lassox_lists_index / lassox_list_get_entities.",
    );
  }

  if (codes.size > MAX_RESOLVED_POSTAL_CODES) {
    throw new Error(
      `The criteria resolve to ${codes.size} postal codes (max ${MAX_RESOLVED_POSTAL_CODES}). Narrow the geography.`,
    );
  }

  return [...codes].sort((a, b) => a - b);
}

function assertPostalCode(code: number): void {
  if (!Number.isInteger(code) || code < 1000 || code > 9999) {
    throw new Error(`Danish postal codes are 4-digit integers (1000-9999); got ${code}.`);
  }
}

/** Parses Lassox employee intervals such as "ANTAL_20_49" or "ANTAL_1000_999999". */
export function parseEmployeeInterval(interval: string | null | undefined): [number, number] | undefined {
  const match = /^ANTAL_(\d+)_(\d+)$/.exec(interval ?? '');
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2])];
}

export function matchesSegment(entity: CandidateEntity, input: SegmentSearchInput): boolean {
  if (input.industryCodes?.length) {
    const prefixes = input.industryCodes.map(code => code.trim()).filter(Boolean);
    const includeAlt = input.includeAltIndustries ?? true;
    const candidates = [
      entity.industry,
      ...(includeAlt ? [entity.altIndustry1, entity.altIndustry2, entity.altIndustry3] : []),
    ];
    const codes = candidates
      .map(candidate => candidate?.code)
      .filter(code => code !== undefined && code !== null)
      .map(String);
    if (!codes.some(code => prefixes.some(prefix => code.startsWith(prefix)))) {
      return false;
    }
  }

  if (input.employeesMin !== undefined || input.employeesMax !== undefined) {
    const min = input.employeesMin ?? 0;
    const max = input.employeesMax ?? Number.POSITIVE_INFINITY;
    const count = entity.employees?.count;
    if (typeof count === 'number') {
      if (count < min || count > max) {
        return false;
      }
    } else {
      // Fall back to the registered interval; match when it overlaps [min, max].
      const interval = parseEmployeeInterval(entity.employees?.interval);
      if (!interval || interval[1] < min || interval[0] > max) {
        return false;
      }
    }
  }

  if (input.companyForms?.length) {
    const wanted = new Set(input.companyForms.map(form => form.trim().toLowerCase()).filter(Boolean));
    const form = entity.form?.shortDescription?.trim().toLowerCase();
    if (!form || !wanted.has(form)) {
      return false;
    }
  }

  if (input.foundedAfter || input.foundedBefore) {
    const founded = entity.lifeTime?.from;
    if (!founded) {
      return false;
    }
    if (input.foundedAfter && founded < input.foundedAfter) {
      return false;
    }
    if (input.foundedBefore && founded > input.foundedBefore) {
      return false;
    }
  }

  return true;
}

/** Stable hash binding a continuation token to the criteria it was issued for. */
export function segmentCriteriaHash(input: SegmentSearchInput, postalCodes: number[]): string {
  const canonical = JSON.stringify({
    industryCodes: [...(input.industryCodes ?? [])].sort(),
    includeAltIndustries: input.includeAltIndustries ?? true,
    employeesMin: input.employeesMin ?? null,
    employeesMax: input.employeesMax ?? null,
    companyForms: [...(input.companyForms ?? [])].map(form => form.toLowerCase()).sort(),
    foundedAfter: input.foundedAfter ?? null,
    foundedBefore: input.foundedBefore ?? null,
    status: input.status ?? 'active',
    postalCodes,
  });

  let hash = 5381;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

export function encodeSegmentCursor(cursor: ScanCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSegmentCursor(token: string, expectedHash: string): ScanCursor {
  let cursor: ScanCursor;
  try {
    cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as ScanCursor;
  } catch {
    throw new Error('continuationToken is not a valid cvr_segment_search token.');
  }

  if (cursor.v !== 1 || typeof cursor.i !== 'number' || typeof cursor.f !== 'string') {
    throw new Error('continuationToken is not a valid cvr_segment_search token.');
  }

  if (cursor.f !== expectedHash) {
    throw new Error(
      'continuationToken was issued for different segment criteria. Restart without the token or reuse the original criteria.',
    );
  }

  return cursor;
}

export async function searchCvrSegment(
  client: LassoClient,
  input: SegmentSearchInput,
  options: SegmentSearchOptions = {},
): Promise<SegmentSearchResult> {
  const postalCodes = resolvePostalCodes(input);
  const criteriaHash = segmentCriteriaHash(input, postalCodes);
  const pageSize = clamp(input.pageSize ?? DEFAULT_SEGMENT_PAGE_SIZE, 1, MAX_SEGMENT_PAGE_SIZE);
  const requestBudget = clamp(
    input.maxRequests ?? DEFAULT_SEGMENT_REQUEST_BUDGET,
    10,
    MAX_SEGMENT_REQUEST_BUDGET,
  );
  const fields = input.fields ?? DEFAULT_SEGMENT_FIELDS;
  const status = input.status ?? 'active';

  let cursor: ScanCursor = input.continuationToken
    ? decodeSegmentCursor(input.continuationToken, criteriaHash)
    : { v: 1, f: criteriaHash, i: 0, c: null };

  if (cursor.i >= postalCodes.length) {
    throw new Error('continuationToken points past the end of the postal code list.');
  }

  const results: unknown[] = [];
  let scanned = 0;
  let requestsUsed = 0;

  const reportProgress = async () => {
    await options.onProgress?.({
      requestsUsed,
      requestBudget,
      scanned,
      matched: results.length,
      postalCode: postalCodes[cursor.i] ?? postalCodes[postalCodes.length - 1]!,
    });
  };

  while (cursor.i < postalCodes.length && requestsUsed < requestBudget && results.length < pageSize) {
    if (options.signal?.aborted) {
      break;
    }

    const postalCode = postalCodes[cursor.i]!;
    requestsUsed += 1;
    const envelope = await callWithRateLimitRetry(
      () =>
        client.get<SearchEnvelope>('/data/cvr/search', {
          query: `postalcode:${postalCode}`,
          type: 'company',
          status,
          pageSize: SEARCH_PAGE_SIZE,
          cToken: cursor.c,
        }),
      { signal: options.signal },
    );

    const companies = envelope.companies;
    const candidates = (companies?.results ?? [])
      .map(result => result.lassoId)
      .filter((lassoId): lassoId is string => typeof lassoId === 'string');

    // Fetch entities within the remaining budget; leftover candidates are
    // re-visited via the continuation token (the search page is re-read then).
    const fetchable = Math.max(0, Math.min(candidates.length, requestBudget - requestsUsed));
    const toFetch = candidates.slice(0, fetchable);
    const pageFullyScanned = toFetch.length === candidates.length;

    if (toFetch.length > 0) {
      const settled = await runBatch(
        toFetch,
        lassoId =>
          callWithRateLimitRetry(() => client.get<CandidateEntity>(`/${lassoId}`), {
            signal: options.signal,
          }),
        { concurrency: input.concurrency, signal: options.signal },
      );

      requestsUsed += toFetch.length;

      for (const item of settled) {
        if (!item.ok) {
          // A failed candidate lookup is skipped rather than failing the scan.
          continue;
        }
        scanned += 1;
        const entity = item.value;
        if (matchesSegment(entity, input) && results.length < pageSize) {
          results.push(selectFields(entity, fields));
        }
      }

      await reportProgress();
    }

    if (!pageFullyScanned) {
      // Budget ran out mid-page: resume on the same page next call.
      break;
    }

    if (companies?.hasNextPage && companies.continuationToken) {
      cursor = { ...cursor, c: companies.continuationToken };
    } else {
      cursor = { ...cursor, i: cursor.i + 1, c: null };
    }
  }

  const exhausted = cursor.i >= postalCodes.length;

  return {
    matched: results.length,
    results,
    scanned,
    requestsUsed,
    exhausted,
    continuationToken: exhausted ? undefined : encodeSegmentCursor(cursor),
    coverage: {
      postalCodesTotal: postalCodes.length,
      postalCodesCompleted: Math.min(cursor.i, postalCodes.length),
    },
    note: exhausted
      ? undefined
      : 'Scan is not exhausted — call again with continuationToken to keep scanning the remaining postal codes.',
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
