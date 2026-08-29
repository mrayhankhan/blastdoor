/**
 * stdio entrypoint. Used by the end-to-end suite, which drives the real MCP protocol over
 * a spawned process — the closest thing to how a local harness would talk to it.
 *
 *   node packages/ops-mcp/src/stdio.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer, STACK } from './tools.ts';
import { startBrokerApi } from './broker-api.ts';

startBrokerApi();

const server = buildServer();
await server.connect(new StdioServerTransport());
console.error(`[ops-mcp] stdio transport ready; target stack at ${STACK}`);
