import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LassoClient, type LassoClientOptions } from './lasso/client.js';
import { registerCvrTools } from './tools/cvr.js';

export interface CreateServerOptions {
  client?: LassoClient;
  clientOptions?: LassoClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'lassox-cvr',
    version: '0.4.0',
  });

  const client = options.client ?? new LassoClient(options.clientOptions);
  registerCvrTools(server, client);

  return server;
}
