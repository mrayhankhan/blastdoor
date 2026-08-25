import { DEPLOYS, SERVICES } from '../../blastdoor-core/src/fixture.ts';
import type { Deploy, ServiceNode } from '../../blastdoor-core/src/types.ts';

/**
 * The mutable state of the pretend production estate.
 *
 * This exists so the demo is deterministic. A demo that depends on a real system
 * misbehaving on cue will fail on camera, and the one thing worse than no demo is a demo
 * that does not reproduce. Faults here are injected explicitly and always produce the
 * same evidence trail.
 */

export interface Fault {
  id: string;
  service: string;
  /** Which deploy introduced it, so the deploy history tells a coherent story. */
  introducedByDeploy: string;
  kind: 'provider-timeout' | 'memory-leak' | 'bad-copy';
  errorRatePct: number;
  p99LatencyMs: number;
  description: string;
}

export interface ActionRecord {
  id: string;
  at: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: 'executed' | 'blocked-awaiting-approval' | 'rejected';
  note: string;
}

export const FAULT_LIBRARY: Record<string, Fault> = {
  'payment-timeout': {
    id: 'payment-timeout',
    service: 'payments-svc',
    introducedByDeploy: 'dep-4c21',
    kind: 'provider-timeout',
    errorRatePct: 11.2,
    p99LatencyMs: 4180,
    description:
      'Raising the provider timeout from 2s to 4s pushed p99 past the upstream checkout deadline, ' +
      'so checkout now abandons calls that payments is still waiting on.',
  },
  'cache-leak': {
    id: 'cache-leak',
    service: 'sessions-cache',
    introducedByDeploy: 'dep-2a44',
    kind: 'memory-leak',
    errorRatePct: 1.8,
    p99LatencyMs: 640,
    description: 'Session entries are written without a TTL, so resident memory grows without eviction.',
  },
  'checkout-copy': {
    id: 'checkout-copy',
    service: 'checkout-api',
    introducedByDeploy: 'dep-9f12',
    kind: 'bad-copy',
    errorRatePct: 6.4,
    p99LatencyMs: 890,
    description: 'A funnel copy change introduced a null dereference on the guest-checkout path.',
  },
};

export class World {
  services: ServiceNode[];
  deploys: Deploy[];
  activeFaults: Fault[] = [];
  actionLog: ActionRecord[] = [];
  changeFreeze: { active: boolean; reason: string } | null = null;

  constructor() {
    this.services = SERVICES.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
    this.deploys = DEPLOYS.map((d) => ({ ...d }));
  }

  reset(): void {
    this.services = SERVICES.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
    this.deploys = DEPLOYS.map((d) => ({ ...d }));
    this.activeFaults = [];
    this.actionLog = [];
    this.changeFreeze = null;
  }

  injectFault(faultId: string): Fault {
    const fault = FAULT_LIBRARY[faultId];
    if (!fault) throw new Error(`Unknown fault: ${faultId}`);
    if (!this.activeFaults.some((f) => f.id === fault.id)) this.activeFaults.push(fault);
    return fault;
  }

  clearFault(faultId: string): void {
    this.activeFaults = this.activeFaults.filter((f) => f.id !== faultId);
  }

  /**
   * Current error rate and latency per service.
   *
   * Faults propagate to callers here in the same shape the blast-radius engine predicts,
   * which is what lets the agent observe the symptom on `checkout-api` and have to work
   * back to a cause on `payments-svc`. If faults only showed up on the faulty service the
   * investigation would be trivial and the demo would prove nothing.
   */
  metrics(): Array<{ service: string; errorRatePct: number; p99LatencyMs: number; rps: number }> {
    const byId = new Map(this.services.map((s) => [s.id, s]));
    const worst = new Map<string, { errorRatePct: number; p99LatencyMs: number }>();

    // Seed every service with its healthy baseline, then let each fault flow outward
    // along caller edges. This has to be transitive to stay consistent with the
    // blast-radius engine's traversal — if the engine predicts the edge gateway goes down
    // but the metrics show it healthy, the two halves of the system disagree and the
    // agent is investigating a world that does not match the one it will act on.
    for (const svc of this.services) {
      worst.set(svc.id, { errorRatePct: 0.4, p99LatencyMs: 120 });
    }

    const callers = new Map<string, string[]>();
    for (const svc of this.services) {
      for (const dep of svc.dependsOn) {
        callers.set(dep, [...(callers.get(dep) ?? []), svc.id]);
      }
    }

    for (const fault of this.activeFaults) {
      const seen = new Set<string>([fault.service]);
      let frontier = [{ id: fault.service, errorRate: fault.errorRatePct, p99: fault.p99LatencyMs }];
      bump(fault.service, fault.errorRatePct, fault.p99LatencyMs);

      while (frontier.length > 0) {
        const next: typeof frontier = [];

        for (const node of frontier) {
          for (const callerId of callers.get(node.id) ?? []) {
            if (seen.has(callerId)) continue;
            const caller = byId.get(callerId);
            if (!caller) continue;

            // A caller with a fallback absorbs most of the failure; one without passes
            // nearly all of it on. Either way the signal weakens with distance, which is
            // what makes the agent's job of tracing back to the origin non-trivial.
            const errorRate = node.errorRate * (caller.degradesGracefully ? 0.25 : 0.85);
            const p99 = node.p99 * (caller.degradesGracefully ? 0.4 : 0.95);
            if (errorRate <= 0.4) continue;

            seen.add(callerId);
            bump(callerId, errorRate, p99);
            next.push({ id: callerId, errorRate, p99 });
          }
        }

        frontier = next;
      }
    }

    function bump(id: string, errorRatePct: number, p99LatencyMs: number): void {
      const current = worst.get(id) ?? { errorRatePct: 0.4, p99LatencyMs: 120 };
      worst.set(id, {
        errorRatePct: Math.max(current.errorRatePct, errorRatePct),
        p99LatencyMs: Math.max(current.p99LatencyMs, p99LatencyMs),
      });
    }

    return this.services.map((svc) => {
      const m = worst.get(svc.id) ?? { errorRatePct: 0.4, p99LatencyMs: 120 };
      return {
        service: svc.id,
        errorRatePct: Number(m.errorRatePct.toFixed(2)),
        p99LatencyMs: Math.round(m.p99LatencyMs),
        rps: byId.get(svc.id)?.rps ?? 0,
      };
    });
  }

  /** Synthetic traces, weighted so failing traces terminate in the faulty service. */
  traces(service?: string, limit = 8): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const fault = this.activeFaults[0];

    for (let i = 0; i < limit; i++) {
      const failing = fault ? i % 3 !== 2 : false;
      out.push({
        traceId: `tr-${(i + 1).toString().padStart(4, '0')}`,
        entry: service ?? 'edge-gateway',
        status: failing ? 'error' : 'ok',
        durationMs: failing ? (fault?.p99LatencyMs ?? 800) + i * 12 : 90 + i * 5,
        terminatesIn: failing ? (fault?.service ?? 'unknown') : 'ledger-db',
        error: failing ? fault?.kind ?? null : null,
      });
    }
    return out;
  }

  logs(service: string, limit = 10): Array<Record<string, unknown>> {
    const fault = this.activeFaults.find((f) => f.service === service);
    return Array.from({ length: limit }, (_, i) => ({
      at: new Date(Date.parse('2026-08-25T13:48:00Z') + i * 30_000).toISOString(),
      service,
      level: fault && i % 2 === 0 ? 'error' : 'info',
      message:
        fault && i % 2 === 0
          ? `${fault.kind}: ${fault.description.slice(0, 60)}...`
          : `handled request ok`,
    }));
  }

  /**
   * Replay a recorded request shape against a specific deploy of a service.
   *
   * This is what turns a correlation into a cause. Observing that an error rate rose
   * after a deploy is timing; showing that the same request fails on the new version and
   * succeeds on the old one is evidence. The agent cannot get that from reading metrics —
   * it has to write code that actually runs the comparison, which is what the sandbox is
   * for.
   *
   * Deterministic by construction: the outcome depends only on whether the deploy under
   * test introduced an active fault.
   */
  replay(service: string, deployId: string, requestShape: string): {
    service: string;
    deployId: string;
    requestShape: string;
    outcome: 'pass' | 'fail';
    latencyMs: number;
    detail: string;
  } {
    const deploy = this.deploys.find((d) => d.id === deployId);
    if (!deploy) {
      return {
        service,
        deployId,
        requestShape,
        outcome: 'fail',
        latencyMs: 0,
        detail: `Unknown deploy ${deployId} — nothing to replay against.`,
      };
    }

    const fault = this.activeFaults.find(
      (f) => f.service === service && f.introducedByDeploy === deployId,
    );

    if (fault) {
      return {
        service,
        deployId,
        requestShape,
        outcome: 'fail',
        latencyMs: fault.p99LatencyMs,
        detail: `Reproduced on ${deployId}: ${fault.kind}. ${fault.description}`,
      };
    }

    return {
      service,
      deployId,
      requestShape,
      outcome: 'pass',
      latencyMs: 118,
      detail: `${requestShape} completed normally on ${deployId}.`,
    };
  }

  record(entry: Omit<ActionRecord, 'id' | 'at'>): ActionRecord {
    const rec: ActionRecord = {
      id: `act-${(this.actionLog.length + 1).toString().padStart(3, '0')}`,
      at: new Date().toISOString(),
      ...entry,
    };
    this.actionLog.push(rec);
    return rec;
  }

  /**
   * Actually perform a destructive action. Only ever reached after a human approval,
   * because the MCP layer will not call this without a valid approval token.
   */
  execute(tool: string, args: Record<string, unknown>): { ok: boolean; message: string } {
    const service = String(args.service ?? '');

    switch (tool) {
      case 'rollback_deploy': {
        const deployId = String(args.deployId ?? '');
        const deploy = this.deploys.find((d) => d.id === deployId);
        if (!deploy) return { ok: false, message: `Unknown deploy ${deployId}.` };

        this.activeFaults = this.activeFaults.filter((f) => f.introducedByDeploy !== deployId);
        this.deploys = this.deploys.filter((d) => d.id !== deployId);
        return {
          ok: true,
          message: `Rolled ${service} back from ${deployId}. Faults introduced by that deploy cleared.`,
        };
      }
      case 'restart_service': {
        this.activeFaults = this.activeFaults.filter(
          (f) => !(f.service === service && f.kind === 'memory-leak'),
        );
        return { ok: true, message: `Restarted ${service}.` };
      }
      case 'scale_service': {
        const node = this.services.find((s) => s.id === service);
        if (!node) return { ok: false, message: `Unknown service ${service}.` };
        node.replicas = Number(args.replicas ?? node.replicas);
        return { ok: true, message: `Scaled ${service} to ${node.replicas} replicas.` };
      }
      default:
        return { ok: false, message: `Unsupported action ${tool}.` };
    }
  }
}

export const world = new World();
