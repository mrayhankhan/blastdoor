/**
 * Streamable-HTTP entrypoint, for TrueForge.
 *
 * TrueForge attaches MCP servers by URL — its manifest type is literally `remote` — so a
 * stdio-only server cannot be wired into the harness at all. This exposes exactly the same
 * tool set over HTTP.
 *
 * A fresh McpServer and transport are created per session rather than shared, because the
 * streamable-HTTP transport keeps per-session state and reusing one across connections
 * lets two clients read each other's stream.
 *
 *   node packages/ops-mcp/src/http.ts       # http://localhost:4300/mcp
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { buildServer, STACK } from './tools.ts';
import { startBrokerApi } from './broker-api.ts';

const PORT = Number(process.env.OPS_MCP_PORT ?? 4300);

startBrokerApi();

/** Live sessions, keyed by the session id the transport assigns. */
const sessions = new Map<string, StreamableHTTPServerTransport>();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, targetStack: STACK }));
    return;
  }

  if (url.pathname !== '/mcp') {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No route for ${url.pathname}. MCP is served at /mcp.` }));
    return;
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    await existing.handleRequest(req, res);
    return;
  }

  // New session: build a server and transport pair and let the transport own the id.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => sessions.set(id, transport),
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await buildServer().connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ops-mcp] FATAL: port ${PORT} is already in use. Stop the other instance first.`);
  } else {
    console.error(`[ops-mcp] FATAL: ${err.message}`);
  }
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.error(`[ops-mcp] streamable-http ready at http://localhost:${PORT}/mcp`);
  console.error(`[ops-mcp] target stack at ${STACK}`);
});
