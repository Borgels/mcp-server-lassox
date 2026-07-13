import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import {
  decodeSegmentCursor,
  encodeSegmentCursor,
  matchesSegment,
  parseEmployeeInterval,
  resolvePostalCodes,
  searchCvrSegment,
  segmentCriteriaHash,
} from '../src/lasso/segment.js';

describe('postal code resolution', () => {
  it('merges explicit codes, ranges, and region ranges', () => {
    const codes = resolvePostalCodes({
      postalCodes: [8000],
      postalCodeRanges: [{ from: 5000, to: 5002 }],
    });

    expect(codes).toEqual([5000, 5001, 5002, 8000]);
  });

  it('expands regions into their approximate postal ranges', () => {
    const codes = resolvePostalCodes({ region: 'sjaelland' });

    expect(codes[0]).toBe(4000);
    expect(codes[codes.length - 1]).toBe(4999);
    expect(codes).toHaveLength(1000);
  });

  it('requires a geographic anchor and points to the Lists bridge', () => {
    expect(() => resolvePostalCodes({ industryCodes: ['21'] })).toThrow(/lassox_lists_index/);
  });

  it('rejects inverted ranges and non-Danish codes', () => {
    expect(() => resolvePostalCodes({ postalCodeRanges: [{ from: 5000, to: 4000 }] })).toThrow('inverted');
    expect(() => resolvePostalCodes({ postalCodes: [123] })).toThrow('4-digit');
  });
});

describe('employee intervals', () => {
  it('parses documented ANTAL_* intervals', () => {
    expect(parseEmployeeInterval('ANTAL_20_49')).toEqual([20, 49]);
    expect(parseEmployeeInterval('ANTAL_1000_999999')).toEqual([1000, 999999]);
    expect(parseEmployeeInterval('other')).toBeUndefined();
    expect(parseEmployeeInterval(undefined)).toBeUndefined();
  });
});

describe('segment matching', () => {
  const pharma = {
    lassoId: 'CVR-1-1',
    industry: { code: '212000' },
    altIndustry1: { code: '461800' },
    employees: { count: 2880 },
    form: { shortDescription: 'A/S' },
    lifeTime: { from: '1989-02-01' },
  };

  it('matches industry code prefixes on main and alt industries', () => {
    expect(matchesSegment(pharma, { industryCodes: ['21'] })).toBe(true);
    expect(matchesSegment(pharma, { industryCodes: ['46'] })).toBe(true);
    expect(matchesSegment(pharma, { industryCodes: ['46'], includeAltIndustries: false })).toBe(false);
    expect(matchesSegment(pharma, { industryCodes: ['10', '11'] })).toBe(false);
  });

  it('filters on employee count with interval fallback', () => {
    expect(matchesSegment(pharma, { employeesMin: 1000 })).toBe(true);
    expect(matchesSegment(pharma, { employeesMin: 3000 })).toBe(false);

    const intervalOnly = { employees: { interval: 'ANTAL_1000_999999' } };
    expect(matchesSegment(intervalOnly, { employeesMin: 1000 })).toBe(true);
    expect(matchesSegment(intervalOnly, { employeesMax: 500 })).toBe(false);

    expect(matchesSegment({}, { employeesMin: 1 })).toBe(false);
  });

  it('filters on company form case-insensitively and founding dates', () => {
    expect(matchesSegment(pharma, { companyForms: ['a/s'] })).toBe(true);
    expect(matchesSegment(pharma, { companyForms: ['ApS'] })).toBe(false);
    expect(matchesSegment(pharma, { foundedBefore: '2000-01-01' })).toBe(true);
    expect(matchesSegment(pharma, { foundedAfter: '2000-01-01' })).toBe(false);
  });
});

describe('continuation tokens', () => {
  it('round-trips and binds to the criteria hash', () => {
    const input = { industryCodes: ['21'], postalCodes: [2880] };
    const hash = segmentCriteriaHash(input, [2880]);
    const token = encodeSegmentCursor({ v: 1, f: hash, i: 0, c: 'abc' });

    expect(decodeSegmentCursor(token, hash)).toEqual({ v: 1, f: hash, i: 0, c: 'abc' });
    expect(() => decodeSegmentCursor(token, 'different')).toThrow('different segment criteria');
    expect(() => decodeSegmentCursor('not-a-token', hash)).toThrow('not a valid');
  });
});

describe('searchCvrSegment', () => {
  it('scans postal codes, filters locally, and reports coverage', async () => {
    const entities: Record<string, unknown> = {
      'CVR-1-1': { lassoId: 'CVR-1-1', name: 'Pharma A/S', industry: { code: '212000' }, employees: { count: 1500 } },
      'CVR-1-2': { lassoId: 'CVR-1-2', name: 'Kiosk ApS', industry: { code: '471110' }, employees: { count: 3 } },
    };

    const fetchMock = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/data/cvr/search') {
        expect(url.searchParams.get('query')).toBe('postalcode:2880');
        return jsonResponse({
          companies: {
            hasNextPage: false,
            results: [{ lassoId: 'CVR-1-1' }, { lassoId: 'CVR-1-2' }],
          },
        });
      }
      return jsonResponse(entities[url.pathname.slice(1)]);
    });

    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await searchCvrSegment(client, {
      industryCodes: ['21'],
      employeesMin: 1000,
      postalCodes: [2880],
      fields: ['lassoId', 'name'],
    });

    expect(result.matched).toBe(1);
    expect(result.results).toEqual([{ lassoId: 'CVR-1-1', name: 'Pharma A/S' }]);
    expect(result.scanned).toBe(2);
    expect(result.requestsUsed).toBe(3);
    expect(result.exhausted).toBe(true);
    expect(result.continuationToken).toBeUndefined();
    expect(result.coverage).toEqual({ postalCodesTotal: 1, postalCodesCompleted: 1 });
  });

  it('stops at the request budget and returns a resumable token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/data/cvr/search') {
        return jsonResponse({
          companies: {
            hasNextPage: false,
            results: Array.from({ length: 30 }, (_, i) => ({ lassoId: `CVR-1-${i}` })),
          },
        });
      }
      return jsonResponse({ lassoId: url.pathname.slice(1), industry: { code: '212000' } });
    });

    const client = new LassoClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await searchCvrSegment(client, {
      industryCodes: ['21'],
      postalCodes: [2880, 2900],
      maxRequests: 10,
    });

    // 1 search page + 9 entity fetches; the page was not fully scanned.
    expect(result.requestsUsed).toBe(10);
    expect(result.scanned).toBe(9);
    expect(result.exhausted).toBe(false);
    expect(result.continuationToken).toBeDefined();
    expect(result.coverage.postalCodesCompleted).toBe(0);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
