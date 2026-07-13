export interface LassoPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_READ_TOOLS = new Set([
  'lassox_search_capabilities',
  'cvr_search',
  'cvr_segment_search',
  'cvr_get_entity',
  'cvr_batch_get_entities',
  'cvr_get_entity_history',
  'cvr_get_related',
  'cvr_get_reports',
  'cvr_get_changes',
  'lassox_financial_analysis',
  'lassox_lists_index',
  'lassox_list_get_entities',
  'cvr_get_network',
  'cvr_get_ownership_graph',
  'creditsafe_get_rating',
  'teledata_get_company_phones',
  'teledata_lookup_phone',
]);

// The only write surface in this server. It changes Lassox list membership
// (tags) — never CVR data, which stays read-only by design.
const ALLOWED_WRITE_TOOLS = new Set(['lassox_list_change']);

export function checkToolPolicy(toolName: string): LassoPolicyDecision {
  if (ALLOWED_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Lassox tool' };
  }

  if (ALLOWED_WRITE_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'allowlisted Lassox write tool (list membership only)' };
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
