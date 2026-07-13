import { describe, expect, it } from 'vitest';
import { createLassoxGateway, lassoxGatewayTools } from '../src/gateway.js';

describe('Lasso X gateway export', () => {
  it('exposes a curated company intelligence surface with one gated write', () => {
    expect(lassoxGatewayTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'cvr_search',
      'cvr_get_entity',
      'ownership_graph',
      'cvr_segment_search',
      'lists_index',
      'list_get_entities',
      'list_change',
      'cvr_get_changes',
    ]));

    const writes = lassoxGatewayTools.filter(tool => tool.riskLevel !== 'read');
    expect(writes.map(tool => tool.name)).toEqual(['list_change']);
    // The write tool must stay opt-in.
    expect(writes[0]?.enabledByDefault).toBe(false);
  });

  it('supports local capability search without upstream calls', async () => {
    const gateway = createLassoxGateway({ apiKey: 'test' });
    const result = await gateway.callTool('search_capabilities', { query: 'ownership' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeTruthy();
  });
});
