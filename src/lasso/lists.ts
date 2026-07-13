import type { LassoClient } from './client.js';
import { selectFields } from './fields.js';

/**
 * Lassox Lists (tags) API — the bridge between segments curated in the Lasso
 * portal and MCP consumers. Lists are read with getLists/getListEntities;
 * changeListMembers is the only write operation in this server and only
 * touches list membership, never CVR data.
 */

const LASSO_ID_PATTERN = /^CVR-[123]-\d+$/;
export const MAX_LIST_CHANGE_IDS = 1000;

export interface ListsIndexInput {
  /** Lassox user id for private lists; omit for lists shared across the account. */
  userId?: string;
}

export async function getLists(client: LassoClient, input: ListsIndexInput = {}): Promise<unknown> {
  return client.get('/tags', { userId: input.userId });
}

export interface ListEntitiesInput {
  tagId: string;
  skip?: number;
  take?: number;
  /** Dot-path projection applied to each entity in results. */
  fields?: string[];
}

interface ListEntitiesEnvelope {
  results?: unknown[];
  [key: string]: unknown;
}

export async function getListEntities(client: LassoClient, input: ListEntitiesInput): Promise<unknown> {
  const tagId = input.tagId.trim();
  if (!tagId) {
    throw new Error('tagId is required. Find list ids with lassox_lists_index.');
  }

  const envelope = await client.get<ListEntitiesEnvelope>(
    `/tags/${encodeURIComponent(tagId)}/entities`,
    { skip: input.skip ?? 0, take: input.take ?? 100 },
  );

  if (input.fields && Array.isArray(envelope?.results)) {
    return { ...envelope, results: envelope.results.map(entity => selectFields(entity, input.fields!)) };
  }

  return envelope;
}

export interface ListChangeInput {
  lassoIds: string[];
  tagsToAdd?: string[];
  tagsToRemove?: string[];
}

export async function changeListMembers(client: LassoClient, input: ListChangeInput): Promise<unknown> {
  const lassoIds = (input.lassoIds ?? []).map(id => id.trim());
  if (lassoIds.length === 0 || lassoIds.length > MAX_LIST_CHANGE_IDS) {
    throw new Error(`Provide 1-${MAX_LIST_CHANGE_IDS} lassoIds.`);
  }

  const invalid = lassoIds.filter(id => !LASSO_ID_PATTERN.test(id));
  if (invalid.length > 0) {
    throw new Error(`Invalid Lasso IDs: ${invalid.slice(0, 5).join(', ')}. Use the CVR-{1|2|3}-{id} format.`);
  }

  const tagsToAdd = (input.tagsToAdd ?? []).map(tag => tag.trim()).filter(Boolean);
  const tagsToRemove = (input.tagsToRemove ?? []).map(tag => tag.trim()).filter(Boolean);
  if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
    throw new Error('Provide at least one list id in tagsToAdd or tagsToRemove.');
  }

  const overlap = tagsToAdd.filter(tag => tagsToRemove.includes(tag));
  if (overlap.length > 0) {
    throw new Error(`Lists cannot appear in both tagsToAdd and tagsToRemove: ${overlap.join(', ')}.`);
  }

  const response = await client.post('/tags/change', undefined, {
    lassoIds,
    tagsToAdd,
    tagsToRemove,
  });

  // Lassox returns an empty body on success; echo a summary so the MCP client
  // gets a concrete confirmation of what was requested.
  return {
    ok: true,
    entities: lassoIds.length,
    tagsToAdd,
    tagsToRemove,
    response: response ?? null,
  };
}
