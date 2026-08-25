/**
 * HTTP surface for the pretend production estate.
 *
 * The MCP server talks to this over the network rather than importing it in-process, so
 * the agent's tools are genuinely reaching an external system it does not control. That
 * distinction matters: an agent wired to an in-process mock proves nothing about whether
 * the tool boundary works.
 *
 *   node packages/target-stack/src/server.ts     # listens on :4000
 */
import { createServer } from 'node:http';
import { world } from './world.ts';

const PORT = Number(process.env.TARGET_STACK_PORT ?? 4000);

type Handler = (url: URL, body: unknown) => unknown;

const routes: Record<string, Handler> = {
  'GET /api/topology': () => ({ services: world.services, changeFreeze: world.changeFreeze }),

  'GET /api/deploys': (url) => {
    const service = url.searchParams.get('service');
    const deploys = service ? world.deploys.filter((d) => d.service === service) : world.deploys;
    return { deploys: [...deploys].sort((a, b) => b.deployedAt.localeCompare(a.deployedAt)) };
  },

  'GET /api/metrics': (url) => {
    const service = url.searchParams.get('service');
    const all = world.metrics();
    return { metrics: service ? all.filter((m) => m.service === service) : all };
  },

  'GET /api/traces': (url) => ({
    traces: world.traces(url.searchParams.get('service') ?? undefined, Number(url.searchParams.get('limit') ?? 8)),
  }),

  'GET /api/logs': (url) => ({
    logs: world.logs(url.searchParams.get('service') ?? 'payments-svc', Number(url.searchParams.get('limit') ?? 10)),
  }),

  'GET /api/actions': () => ({ actions: world.actionLog }),

  // The endpoint the agent's sandbox code calls to turn a correlation into a cause.
  'POST /api/replay': (_url, body) => {
    const { service, deployId, requestShape } = body as Record<string, string>;
    return world.replay(service, deployId, requestShape ?? 'recorded failing request');
  },

  'POST /api/execute': (_url, body) => {
    const { tool, args } = body as { tool: string; args: Record<string, unknown> };
    const result = world.execute(tool, args ?? {});
    world.record({
      tool,
      args: args ?? {},
      outcome: result.ok ? 'executed' : 'rejected',
      note: result.message,
    });
    return result;
  },

  'POST /api/fault/inject': (_url, body) => {
    const { faultId } = body as { faultId: string };
    return { injected: world.injectFault(faultId) };
  },

  'POST /api/fault/clear': (_url, body) => {
    const { faultId } = body as { faultId: string };
    world.clearFault(faultId);
    return { cleared: faultId };
  },

  'POST /api/freeze': (_url, body) => {
    const { active, reason } = body as { active: boolean; reason?: string };
    world.changeFreeze = active ? { active: true, reason: reason ?? 'Unspecified freeze' } : null;
    return { changeFreeze: world.changeFreeze };
  },

  'POST /api/reset': () => {
    world.reset();
    return { reset: true };
  },
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');

    const handler = routes[key];
    if (!handler) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `No route for ${key}`, routes: Object.keys(routes) }));
      return;
    }

    try {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      res.end(JSON.stringify(handler(url, body), null, 2));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[target-stack] listening on http://localhost:${PORT}`);
  console.log(`[target-stack] routes: ${Object.keys(routes).join(', ')}`);
});
