import type { LassoClient } from './client.js';
import { selectFields } from './fields.js';

/**
 * Lassox delta endpoints ("Getting changes") — used to keep downstream
 * systems (e.g. a CRM) in sync by asking which entities changed since a
 * timestamp. Wraps /data/cvr/{company|person|place}/delta and
 * /data/cvr/reports/delta with the documented parameters, including the
 * recommended useLastLoad behaviour (defaulted to true here; Lassox flips the
 * upstream default on 2026-08-01).
 */

export type DeltaScope = 'company' | 'person' | 'place' | 'reports';

const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?Z?$/;

export interface CvrChangesInput {
  scope?: DeltaScope;
  /** Minimum update time (ISO date or datetime). */
  since: string;
  /** Optional maximum update time. */
  max?: string;
  pageSize?: number;
  continuationToken?: string;
  /**
   * Filter on LastLoad (publication time) instead of LastUpdated. Recommended
   * by Lassox to avoid missing late-published changes; not relevant for reports.
   */
  useLastLoad?: boolean;
  /** With useLastLoad: max days between LastUpdated and `since` (upstream default 7). */
  maxDaysSinceUpdate?: number;
  /** Return historical value wrappers instead of current values. Not for reports. */
  history?: boolean;
  /** Reports only: return report metadata without the full figures. */
  metadataOnly?: boolean;
  /** Client-side filter: only return changes for these Lasso IDs. */
  lassoIds?: string[];
  /** Dot-path projection applied to each changed entity. */
  fields?: string[];
}

interface DeltaEnvelope {
  results?: Array<{ lassoId?: string }>;
  resultsReturned?: number;
  [key: string]: unknown;
}

export async function getCvrChanges(client: LassoClient, input: CvrChangesInput): Promise<unknown> {
  const scope = input.scope ?? 'company';

  assertDatetime('since', input.since);
  if (input.max) {
    assertDatetime('max', input.max);
  }

  if (scope === 'reports' && input.history) {
    throw new Error('history is not supported for the reports delta.');
  }
  if (scope !== 'reports' && input.metadataOnly) {
    throw new Error('metadataOnly only applies to scope "reports".');
  }

  const path = `/data/cvr/${scope}/delta${input.history ? '/history' : ''}`;
  const envelope = await client.get<DeltaEnvelope>(path, {
    since: input.since,
    max: input.max,
    pageSize: input.pageSize,
    cToken: input.continuationToken,
    useLastLoad: scope === 'reports' ? undefined : (input.useLastLoad ?? true),
    maxDaysSinceUpdate: input.maxDaysSinceUpdate,
    metadataOnly: input.metadataOnly,
  });

  if (!Array.isArray(envelope?.results)) {
    return envelope;
  }

  let results = envelope.results;
  let clientFiltered = false;

  if (input.lassoIds?.length) {
    const wanted = new Set(input.lassoIds.map(id => id.trim()));
    results = results.filter(entity => entity.lassoId && wanted.has(entity.lassoId));
    clientFiltered = true;
  }

  const projected = input.fields
    ? results.map(entity => selectFields(entity, input.fields!))
    : results;

  return {
    ...envelope,
    results: projected,
    ...(clientFiltered
      ? { clientFiltered: true, resultsReturnedAfterFilter: results.length }
      : {}),
  };
}

function assertDatetime(name: string, value: string): void {
  if (!DATETIME_PATTERN.test(value.trim())) {
    throw new Error(`${name} must be an ISO date or datetime, e.g. 2026-07-01 or 2026-07-01T00:00:00.`);
  }
}
