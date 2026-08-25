/**
 * HTTP surface for the approval broker, consumed by the console.
 *
 * This runs alongside the stdio MCP transport rather than inside it because the human and
 * the agent arrive from different directions: the agent speaks MCP over stdio, the
 * operator speaks HTTP from a browser. Keeping the broker addressable from both is what
 * makes the approval an out-of-band act rather than something the agent can talk itself
 * into.
 */
import { createServer, type Server } from 'node:http';
import { broker } from './broker.ts';
import { renderApprovalCard } from '../../blastdoor-core/src/render.ts';

export function startBrokerApi(port = Number(process.env.BROKER_PORT ?? 4200)): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const chunks: Buffer[] = [];

    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const send = (payload: unknown, status = 200) => {
        res.statusCode = status;
        res.end(JSON.stringify(payload, null, 2));
      };

      try {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};

        if (req.method === 'GET' && url.pathname === '/api/proposals') {
          return send({
            proposals: broker.list().map((p) => ({
              id: p.id,
              createdAt: p.createdAt,
              status: p.status,
              tool: p.action.tool,
              args: p.action.args,
              rationale: p.action.rationale,
              recommendation: p.report.recommendation,
              headline: p.report.headline,
              reversibility: p.report.reversibility,
              confidence: p.report.confidence,
              impacted: p.report.impacted,
              inFlight: p.report.inFlight,
              undo: p.report.undo,
              guardrails: p.report.guardrails,
              evidence: p.action.evidence,
              argsFingerprint: p.argsFingerprint,
              expiresAt: p.expiresAt,
              decidedBy: p.decidedBy,
              decisionNote: p.decisionNote,
              card: renderApprovalCard(p.report),
            })),
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/approve') {
          const { proposalId, decidedBy, note } = body as Record<string, string>;
          const result = broker.approve(proposalId, decidedBy || 'operator', note);
          return send(result, result.ok ? 200 : 400);
        }

        if (req.method === 'POST' && url.pathname === '/api/deny') {
          const { proposalId, decidedBy, note } = body as Record<string, string>;
          const result = broker.deny(proposalId, decidedBy || 'operator', note);
          return send(result, result.ok ? 200 : 400);
        }

        return send({ error: `No route for ${req.method} ${url.pathname}` }, 404);
      } catch (err) {
        return send({ error: (err as Error).message }, 400);
      }
    });
  });

  // If the port is taken there is almost certainly a stale broker still running, and
  // carrying on regardless would be worse than failing. The agent would create proposals
  // in this process while the operator approved them in the other one's console — the
  // approvals would never match, and the operator would believe they had authorised
  // something that had not been authorised at all. That confusion is exactly what this
  // project exists to prevent, so refuse to start and say why.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[broker-api] FATAL: port ${port} is already in use.\n` +
          `  Another Blastdoor broker is running. Two brokers means the agent and the console\n` +
          `  would be looking at different sets of proposals, so this process will not start.\n` +
          `  Stop the other instance, or set BROKER_PORT to a free port on both sides.`,
      );
    } else {
      console.error(`[broker-api] FATAL: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.error(`[broker-api] listening on http://localhost:${port}`);
  });

  return server;
}
