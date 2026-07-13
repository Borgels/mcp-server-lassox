import { describe, expect, it, vi } from 'vitest';
import { LassoClient } from '../src/lasso/client.js';
import { changeListMembers, getListEntities, getLists } from '../src/lasso/lists.js';

describe('lists endpoints', () => {
  it('builds the tags index URL with optional userId', async () => {
    expect(await captureUrl(client => getLists(client))).toBe('https://example.test/tags');
    expect(await captureUrl(client => getLists(client, { userId: 'u-1' }))).toBe(
      'https://example.test/tags?userId=u-1',
    );
  });

  it('builds the list entities URL with pagination and encodes the tag id', async () => {
    expect(
      await captureUrl(client => getListEntities(client, { tagId: 'cHfb90', skip: 10, take: 50 })),
    ).toBe('https://example.test/tags/cHfb90/entities?skip=10&take=50');

    expect(await captureUrl(client => getListEntities(client, { tagId: 'a/b' }))).toBe(
      'https://example.test/tags/a%2Fb/entities?skip=0&take=100',
    );
  });

  it('projects fields over list entity results', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        resultsFound: 1,
        results: [{ lassoId: 'CVR-1-1', name: 'Lasso X A/S', noise: 'drop-me' }],
      }),
    );
    const client = makeClient(fetchMock);

    const result = (await getListEntities(client, {
      tagId: 'cHfb90',
      fields: ['lassoId', 'name'],
    })) as { results: unknown[] };

    expect(result.results).toEqual([{ lassoId: 'CVR-1-1', name: 'Lasso X A/S' }]);
  });

  it('rejects empty tag ids', async () => {
    const client = makeClient(vi.fn<typeof fetch>());
    await expect(getListEntities(client, { tagId: '  ' })).rejects.toThrow('tagId is required');
  });
});

describe('changeListMembers', () => {
  it('posts the documented bulk change payload and echoes a summary', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(null));
    const client = makeClient(fetchMock);

    const result = await changeListMembers(client, {
      lassoIds: ['CVR-1-34580820'],
      tagsToAdd: ['cHfb90'],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://example.test/tags/change');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      lassoIds: ['CVR-1-34580820'],
      tagsToAdd: ['cHfb90'],
      tagsToRemove: [],
    });
    expect(result).toMatchObject({ ok: true, entities: 1, tagsToAdd: ['cHfb90'] });
  });

  it('validates lasso ids, tag operations, and overlaps', async () => {
    const client = makeClient(vi.fn<typeof fetch>());

    await expect(changeListMembers(client, { lassoIds: [], tagsToAdd: ['t'] })).rejects.toThrow('1-1000');
    await expect(
      changeListMembers(client, { lassoIds: ['bogus'], tagsToAdd: ['t'] }),
    ).rejects.toThrow('Invalid Lasso IDs');
    await expect(changeListMembers(client, { lassoIds: ['CVR-1-1'] })).rejects.toThrow(
      'tagsToAdd or tagsToRemove',
    );
    await expect(
      changeListMembers(client, { lassoIds: ['CVR-1-1'], tagsToAdd: ['t'], tagsToRemove: ['t'] }),
    ).rejects.toThrow('both tagsToAdd and tagsToRemove');
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
