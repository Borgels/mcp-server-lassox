import { searchCapabilities } from './lasso/capabilities.js';
import { LassoClient, type LassoClientOptions } from './lasso/client.js';
import { getCvrEntity, getCvrEntityHistory, searchCvr } from './lasso/cvr.js';
import { getCvrChanges } from './lasso/delta.js';
import { getCvrReports, getFinancialAnalysis } from './lasso/financials.js';
import { changeListMembers, getListEntities, getLists } from './lasso/lists.js';
import { getOwnershipGraph } from './lasso/network.js';
import { searchCvrSegment } from './lasso/segment.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export interface LassoxGatewayOptions extends LassoClientOptions {}

const emptySearchInput = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'number', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

const entityInput = {
  type: 'object',
  properties: {
    lassoId: { type: 'string', description: 'Lassox id such as CVR-1-34580820.' },
    entityType: { type: 'string', enum: ['company', 'productionUnit', 'person'] },
    id: { type: ['string', 'number'] },
  },
  additionalProperties: false,
} satisfies GatewayJsonObject;

export const lassoxGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'search_capabilities',
    title: 'Search Lasso X capabilities',
    description: 'Find supported CVR, company intelligence, and ownership tools.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: emptySearchInput,
  },
  {
    name: 'cvr_search',
    title: 'Search CVR',
    description: 'Search Danish companies and people through Lasso X CVR data.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['company', 'person', 'all'] },
        status: { type: 'string', enum: ['active', 'inactive', 'all'] },
        pageSize: { type: 'number', minimum: 1, maximum: 100 },
        continuationToken: { type: 'string' },
        filters: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cvr_get_entity',
    title: 'Get CVR entity',
    description: 'Fetch current CVR basic information for a company, production unit, or person.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: entityInput,
  },
  {
    name: 'cvr_get_entity_history',
    title: 'Get CVR entity history',
    description: 'Fetch historical CVR basic information from Lassox.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: entityInput,
  },
  {
    name: 'cvr_get_reports',
    title: 'Get CVR reports',
    description: 'Fetch annual report key figures for a Danish company.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        lassoId: { type: 'string' },
        entityType: { type: 'string', enum: ['company'] },
        id: { type: ['string', 'number'] },
        currency: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'financial_analysis',
    title: 'Get Lasso X financial analysis',
    description: 'Run the Lasso X financial analysis module for a Danish company.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: entityInput,
  },
  {
    name: 'cvr_segment_search',
    title: 'Segment search (firmographic discovery)',
    description:
      'Discover companies by industry code prefix, employee count, company form, and founding date within a postal-code geography. Bounded scan; resume with continuationToken.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        industryCodes: { type: 'array', items: { type: 'string' } },
        includeAltIndustries: { type: 'boolean' },
        employeesMin: { type: 'number' },
        employeesMax: { type: 'number' },
        companyForms: { type: 'array', items: { type: 'string' } },
        foundedAfter: { type: 'string' },
        foundedBefore: { type: 'string' },
        status: { type: 'string', enum: ['active', 'inactive', 'all'] },
        postalCodes: { type: 'array', items: { type: 'number' } },
        postalCodeRanges: {
          type: 'array',
          items: {
            type: 'object',
            required: ['from', 'to'],
            properties: { from: { type: 'number' }, to: { type: 'number' } },
            additionalProperties: false,
          },
        },
        region: {
          type: 'string',
          enum: ['hovedstaden', 'sjaelland', 'syddanmark', 'midtjylland', 'nordjylland'],
        },
        pageSize: { type: 'number', minimum: 1, maximum: 100 },
        maxRequests: { type: 'number', minimum: 10, maximum: 500 },
        continuationToken: { type: 'string' },
        fields: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lists_index',
    title: 'List Lasso X lists (tags)',
    description: 'Fetch the Lasso X lists (tags) visible to the account.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_get_entities',
    title: 'Get Lasso X list members',
    description: 'Fetch the entities in a Lasso X list (tag) with skip/take pagination.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['tagId'],
      properties: {
        tagId: { type: 'string' },
        skip: { type: 'number', minimum: 0 },
        take: { type: 'number', minimum: 1, maximum: 1000 },
        fields: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_change',
    title: 'Change Lasso X list membership',
    description:
      'Add or remove entities (Lasso IDs) to/from Lasso X lists (tags). Write operation: changes list membership only, never CVR data.',
    riskLevel: 'write',
    enabledByDefault: false,
    inputSchema: {
      type: 'object',
      required: ['lassoIds'],
      properties: {
        lassoIds: { type: 'array', items: { type: 'string' } },
        tagsToAdd: { type: 'array', items: { type: 'string' } },
        tagsToRemove: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cvr_get_changes',
    title: 'Get CVR changes (delta)',
    description:
      'Fetch entities changed since a timestamp (companies, persons, places, or reports) for downstream sync.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['since'],
      properties: {
        scope: { type: 'string', enum: ['company', 'person', 'place', 'reports'] },
        since: { type: 'string' },
        max: { type: 'string' },
        pageSize: { type: 'number', minimum: 1, maximum: 1000 },
        continuationToken: { type: 'string' },
        useLastLoad: { type: 'boolean' },
        maxDaysSinceUpdate: { type: 'number' },
        history: { type: 'boolean' },
        metadataOnly: { type: 'boolean' },
        lassoIds: { type: 'array', items: { type: 'string' } },
        fields: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ownership_graph',
    title: 'Get ownership graph',
    description: 'Build an ownership and voting-rights graph for one or more CVR entities.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        relationTypes: { type: 'array', items: { type: 'string' } },
        enrichments: { type: 'array', items: { type: 'string' } },
        ingoingDepth: { type: 'number', minimum: 0, maximum: 10 },
        outgoingDepth: { type: 'number', minimum: 0, maximum: 10 },
        onDate: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

export function createLassoxGateway(options: LassoxGatewayOptions = {}) {
  const client = new LassoClient(options);

  return {
    tools: lassoxGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
      switch (toolName) {
        case 'search_capabilities':
          return jsonResult('Found Lasso X capabilities.', searchCapabilities(
            stringValue(input.query) ?? '',
            numberValue(input.limit) ?? 20,
          ));

        case 'cvr_search':
          return jsonResult('Found CVR results.', await searchCvr(client, input as unknown as Parameters<typeof searchCvr>[1]));

        case 'cvr_get_entity':
          return jsonResult('Fetched CVR entity.', await getCvrEntity(client, input as Parameters<typeof getCvrEntity>[1]));

        case 'cvr_get_entity_history':
          return jsonResult('Fetched CVR entity history.', await getCvrEntityHistory(client, input as Parameters<typeof getCvrEntityHistory>[1]));

        case 'cvr_get_reports':
          return jsonResult('Fetched CVR reports.', await getCvrReports(client, input as Parameters<typeof getCvrReports>[1]));

        case 'financial_analysis':
          return jsonResult('Fetched financial analysis.', await getFinancialAnalysis(client, input as Parameters<typeof getFinancialAnalysis>[1]));

        case 'ownership_graph':
          return jsonResult('Fetched ownership graph.', await getOwnershipGraph(client, input as unknown as Parameters<typeof getOwnershipGraph>[1]));

        case 'cvr_segment_search':
          return jsonResult('Ran segment search.', await searchCvrSegment(client, input as unknown as Parameters<typeof searchCvrSegment>[1]));

        case 'lists_index':
          return jsonResult('Fetched Lasso X lists.', await getLists(client, input as Parameters<typeof getLists>[1]));

        case 'list_get_entities':
          return jsonResult('Fetched list members.', await getListEntities(client, input as unknown as Parameters<typeof getListEntities>[1]));

        case 'list_change':
          return jsonResult('Changed list membership.', await changeListMembers(client, input as unknown as Parameters<typeof changeListMembers>[1]));

        case 'cvr_get_changes':
          return jsonResult('Fetched CVR changes.', await getCvrChanges(client, input as unknown as Parameters<typeof getCvrChanges>[1]));

        default:
          return errorResult(`Unsupported Lasso X gateway tool: ${toolName}`);
      }
    },
  };
}

function stringValue(value: GatewayJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: GatewayJsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
