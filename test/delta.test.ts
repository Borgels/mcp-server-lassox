import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import { getCvrChanges } from '../src/lasso/delta.js';

describe('getCvrChanges', () => {
  it('builds the company delta URL with the recommended useLastLoad default', async () => {
    const url = await captureUrl(client =>
      getCvrChanges(client, { since: '2026-07-01', max: '2026-07-02', pageSize: 50 }),
    );

    expect(url).toBe(
      'https://example.test/data/cvr/company/delta?since=2026-07-01&max=2026-07-02&pageSize=50&useLastLoad=true',
    );
  });

  it('supports history, scopes, and continuation tokens', async () => {
    const url = await captureUrl(client =>
      getCvrChanges(client, {
        scope: 'place',
        since: '2026-07-01T00:00:00',
        history: true,
        continuationToken: 'next',
        useLastLoad: false,
        maxDaysSinceUpdate: 14,
      }),
    );

    expect(url).toBe(
      'https://example.test/data/cvr/place/delta/history?since=2026-07-01T00%3A00%3A00&cToken=next&useLastLoad=false&maxDaysSinceUpdate=14',
    );
  });

  it('builds the reports delta URL without useLastLoad and with metadataOnly', async () => {
    const url = await captureUrl(client =>
      getCvrChanges(client, { scope: 'reports', since: '2026-07-01', metadataOnly: true }),
    );

    expect(url).toBe('https://example.test/data/cvr/reports/delta?since=2026-07-01&metadataOnly=true');
  });

  it('rejects invalid parameter combinations and timestamps', async () => {
    const client = makeClient(vi.fn<typeof fetch>());

    await expect(getCvrChanges(client, { since: 'sidste uge' })).rejects.toThrow('ISO date');
    await expect(
      getCvrChanges(client, { scope: 'reports', since: '2026-07-01', history: true }),
    ).rejects.toThrow('history is not supported');
    await expect(
      getCvrChanges(client, { scope: 'company', since: '2026-07-01', metadataOnly: true }),
    ).rejects.toThrow('metadataOnly only applies');
  });

  it('filters client-side on lassoIds and projects fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        resultsFound: 3,
        results: [
          { lassoId: 'CVR-1-1', name: 'A', noise: true },
          { lassoId: 'CVR-1-2', name: 'B', noise: true },
        ],
      }),
    );
    const client = makeClient(fetchMock);

    const result = (await getCvrChanges(client, {
      since: '2026-07-01',
      lassoIds: ['CVR-1-2'],
      fields: ['lassoId', 'name'],
    })) as Record<string, unknown>;

    expect(result.results).toEqual([{ lassoId: 'CVR-1-2', name: 'B' }]);
    expect(result.clientFiltered).toBe(true);
    expect(result.resultsReturnedAfterFilter).toBe(1);
    expect(result.resultsFound).toBe(3);
  });
});

function makeClient(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): LassoClient {
  return new LassoClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

async function captureUrl(call: (client: LassoClient) => Promise<unknown>): Promise<string> {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
  await call(makeClient(fetchMock));
  return String(fetchMock.mock.calls[0]?.[0]);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
