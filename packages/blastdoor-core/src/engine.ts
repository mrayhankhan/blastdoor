import type {
  ActionProposal,
  BlastRadiusReport,
  Confidence,
  Deploy,
  Evidence,
  GuardrailHit,
  ImpactedService,
  Recommendation,
  Reversibility,
  ServiceNode,
  UndoPlan,
} from './types.ts';
import { REVERSIBILITY_RANK } from './types.ts';

export interface SystemState {
  services: ServiceNode[];
  deploys: Deploy[];
  /** Change freezes, e.g. during a sale. Present means "a human said not now". */
  changeFreeze: { active: boolean; reason: string } | null;
}

/**
 * How long each action takes to converge, in seconds. Used to size the in-flight
 * request loss. These are the numbers an SRE would know by heart for their own stack;
 * making them explicit is the point, because the agent should not be guessing them.
 */
const CONVERGENCE_SECONDS: Record<string, number> = {
  rollback_deploy: 45,
  restart_service: 20,
  scale_service: 15,
  purge_cache: 5,
};

/**
 * Walk the dependency graph outward from a target to find who else feels this.
 *
 * Edges point from caller to callee (`dependsOn`), so to find who is affected by a
 * target going away we walk them backwards: the callers of the target are the ones
 * left holding a failed request.
 *
 * The interesting part is that impact attenuates. A caller that degrades gracefully
 * absorbs the failure and turns 'unavailable' into 'degraded'; anything downstream of
 * *that* sees only latency. Without attenuation every graph traversal concludes "the
 * entire estate is affected", which is true, useless, and trains operators to skim.
 */
export function traverseImpact(
  services: ServiceNode[],
  targetId: string,
  directEffect: 'unavailable' | 'degraded',
): ImpactedService[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const target = byId.get(targetId);
  if (!target) return [];

  // Reverse adjacency: for each service, who calls it.
  const callers = new Map<string, string[]>();
  for (const svc of services) {
    for (const dep of svc.dependsOn) {
      callers.set(dep, [...(callers.get(dep) ?? []), svc.id]);
    }
  }

  const impacted: ImpactedService[] = [
    {
      serviceId: target.id,
      displayName: target.displayName,
      hops: 0,
      effect: directEffect,
      userFacing: target.userFacing,
      reasoning: 'Direct target of the action.',
    },
  ];

  const seen = new Set([targetId]);
  let frontier: Array<{ id: string; effect: ImpactedService['effect']; hops: number }> = [
    { id: targetId, effect: directEffect, hops: 0 },
  ];

  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const node of frontier) {
      for (const callerId of callers.get(node.id) ?? []) {
        if (seen.has(callerId)) continue;
        const caller = byId.get(callerId);
        if (!caller) continue;

        const effect = attenuate(node.effect, caller.degradesGracefully);
        if (effect === 'no-effect') continue;

        seen.add(callerId);
        impacted.push({
          serviceId: caller.id,
          displayName: caller.displayName,
          hops: node.hops + 1,
          effect,
          userFacing: caller.userFacing,
          reasoning: caller.degradesGracefully
            ? `Calls ${byId.get(node.id)?.displayName ?? node.id}, but has a fallback path, so it degrades rather than failing.`
            : `Calls ${byId.get(node.id)?.displayName ?? node.id} with no fallback, so the failure propagates.`,
        });
        next.push({ id: callerId, effect, hops: node.hops + 1 });
      }
    }

    frontier = next;
  }

  // Most severe and most user-facing first — that is the order an operator reads in.
  const severity = { unavailable: 0, degraded: 1, 'elevated-latency': 2, 'no-effect': 3 };
  return impacted.sort(
    (a, b) =>
      severity[a.effect] - severity[b.effect] ||
      Number(b.userFacing) - Number(a.userFacing) ||
      a.hops - b.hops,
  );
}

function attenuate(
  upstreamEffect: ImpactedService['effect'],
  degradesGracefully: boolean,
): ImpactedService['effect'] {
  if (upstreamEffect === 'unavailable') return degradesGracefully ? 'degraded' : 'unavailable';
  if (upstreamEffect === 'degraded') return degradesGracefully ? 'no-effect' : 'elevated-latency';
  return 'no-effect';
}

/**
 * Decide how reversible an action is, and describe the road back.
 *
 * Rollback is the interesting case. Everyone assumes a rollback is safe because it
 * returns to known-good code — but if the deploy carried a schema migration, the
 * database has already moved on, and rolling the code back lands old code on a new
 * schema. That is the single most common way a "safe" rollback makes an incident worse,
 * so it gets first-class treatment here rather than a footnote.
 */
export function resolveUndo(
  proposal: ActionProposal,
  state: SystemState,
): { reversibility: Reversibility; undo: UndoPlan; effect: string } {
  const service = String(proposal.args.service ?? 'unknown');

  switch (proposal.tool) {
    case 'rollback_deploy': {
      const deployId = String(proposal.args.deployId ?? '');
      const deploy = state.deploys.find((d) => d.id === deployId);

      if (!deploy) {
        return {
          reversibility: 'irreversible',
          effect: `Roll ${service} back from an unrecognised deploy (${deployId || 'none given'}).`,
          undo: {
            possible: false,
            procedure: [],
            windowSeconds: null,
            residualLoss: 'Unknown — the target deploy is not in the deploy history.',
          },
        };
      }

      const target = deploy.previousDeployId
        ? state.deploys.find((d) => d.id === deploy.previousDeployId)
        : undefined;

      if (deploy.includesMigration) {
        return {
          reversibility: 'irreversible',
          effect:
            `Roll ${service} back from ${deploy.id} to ${target?.id ?? 'unknown'}. ` +
            `${deploy.id} applied a schema migration, so the code moves back but the schema does not.`,
          undo: {
            possible: false,
            procedure: [],
            windowSeconds: null,
            residualLoss:
              'The migration is already applied. Rolling the code back leaves old code running against a new schema, ' +
              'and rolling forward again will not replay writes rejected in the meantime.',
          },
        };
      }

      if (!target) {
        return {
          reversibility: 'irreversible',
          effect: `Roll ${service} back from ${deploy.id}, but there is no recorded previous deploy.`,
          undo: {
            possible: false,
            procedure: [],
            windowSeconds: null,
            residualLoss: 'No previous deploy recorded, so there is nothing to return to.',
          },
        };
      }

      if (!target.artifactRetained) {
        return {
          reversibility: 'reversible-with-loss',
          effect: `Roll ${service} back from ${deploy.id} to ${target.id}.`,
          undo: {
            possible: true,
            procedure: [`Rebuild ${deploy.sha} from source`, `Redeploy ${service}`],
            windowSeconds: null,
            residualLoss: `The artifact for ${target.id} is no longer retained, so returning here requires a rebuild.`,
          },
        };
      }

      return {
        reversibility: 'reversible',
        effect: `Roll ${service} back from ${deploy.id} (${deploy.summary}) to ${target.id} (${target.summary}).`,
        undo: {
          possible: true,
          procedure: [`Redeploy ${deploy.id} (${deploy.sha})`, `Verify error rate returns to baseline`],
          windowSeconds: null,
          residualLoss: null,
        },
      };
    }

    case 'restart_service': {
      const node = state.services.find((s) => s.id === service);
      const lastReplica = (node?.replicas ?? 0) <= 1;
      return {
        reversibility: 'reversible-with-loss',
        effect: lastReplica
          ? `Restart ${service}, which is running a single replica — this is a full outage for its callers.`
          : `Restart ${service} (${node?.replicas ?? '?'} replicas, rolling).`,
        undo: {
          possible: true,
          procedure: ['The process comes back automatically; no undo step is required.'],
          windowSeconds: null,
          residualLoss: 'In-flight requests at the moment of restart are dropped and not retried.',
        },
      };
    }

    case 'scale_service': {
      const to = Number(proposal.args.replicas ?? 0);
      const node = state.services.find((s) => s.id === service);
      const from = node?.replicas ?? 0;
      return {
        reversibility: 'reversible',
        effect: `Scale ${service} from ${from} to ${to} replicas.`,
        undo: {
          possible: true,
          procedure: [`Scale ${service} back to ${from} replicas`],
          windowSeconds: null,
          residualLoss: to < from ? 'Requests on terminated replicas are dropped.' : null,
        },
      };
    }

    default:
      return {
        reversibility: 'irreversible',
        effect: `Run ${proposal.tool} against ${service}. This tool has no registered undo path.`,
        undo: {
          possible: false,
          procedure: [],
          windowSeconds: null,
          residualLoss: 'Unknown — the action is not modelled, so its effects cannot be bounded.',
        },
      };
  }
}

/**
 * Score how much the evidence actually supports the causal story.
 *
 * The failure this guards against is the agent's most seductive one: it finds a deploy
 * that happened shortly before an error spike and reports a cause. Temporal correlation
 * is not causation, and an operator skimming an approval prompt will not notice the
 * difference unless someone points at it. So correlational evidence is scored, kept, and
 * explicitly labelled as a gap rather than quietly folded into a confident number.
 */
export function scoreConfidence(evidence: Evidence[]): Confidence {
  const basis: string[] = [];
  const gaps: string[] = [];

  const causal = evidence.filter((e) => e.strength === 'causal');
  const correlational = evidence.filter((e) => e.strength === 'correlational');
  const circumstantial = evidence.filter((e) => e.strength === 'circumstantial');

  let score = 10;

  if (causal.length > 0) {
    score += Math.min(55, causal.length * 28);
    basis.push(`${causal.length} direct causal observation(s): ${causal.map((e) => e.claim).join('; ')}`);
  } else {
    gaps.push('No direct causal evidence — nothing observed actually links the change to the symptom.');
  }

  if (correlational.length > 0) {
    score += Math.min(25, correlational.length * 9);
    basis.push(`${correlational.length} correlational signal(s): ${correlational.map((e) => e.claim).join('; ')}`);
    if (causal.length === 0) {
      gaps.push(
        'The case rests on timing alone. Something else changing in the same window would produce the same picture.',
      );
    }
  }

  if (circumstantial.length > 0) {
    score += Math.min(10, circumstantial.length * 4);
    basis.push(`${circumstantial.length} circumstantial detail(s).`);
  }

  const sources = new Set(evidence.map((e) => e.source));
  if (sources.size >= 3) {
    score += 8;
    basis.push(`Corroborated across ${sources.size} independent tools (${[...sources].join(', ')}).`);
  } else if (evidence.length > 0) {
    gaps.push(
      `All evidence comes from ${sources.size} tool(s). A fault in that source would not be visible from here.`,
    );
  }

  if (evidence.length === 0) {
    gaps.push('No evidence was gathered at all.');
  }

  return { score: Math.max(0, Math.min(100, score)), basis, gaps };
}

/**
 * Policy checks that hold regardless of how good the evidence looks.
 *
 * These exist because confidence and permission are different questions. An agent can be
 * entirely correct about the cause and still be wrong to act — during a change freeze,
 * or when the fix takes down the last replica of a payment path.
 */
export function checkGuardrails(
  proposal: ActionProposal,
  state: SystemState,
  impacted: ImpactedService[],
  confidence: Confidence,
): GuardrailHit[] {
  const hits: GuardrailHit[] = [];

  if (state.changeFreeze?.active) {
    hits.push({
      id: 'change-freeze',
      severity: 'block',
      message: `A change freeze is active: ${state.changeFreeze.reason}. Acting requires an explicit human override.`,
    });
  }

  const service = String(proposal.args.service ?? '');
  const node = state.services.find((s) => s.id === service);
  if (proposal.tool === 'restart_service' && (node?.replicas ?? 0) <= 1) {
    hits.push({
      id: 'last-replica',
      severity: 'block',
      message: `${service} has a single replica. Restarting it is a full outage, not a rolling restart.`,
    });
  }

  const userFacingDown = impacted.filter((i) => i.userFacing && i.effect === 'unavailable');
  if (userFacingDown.length > 0) {
    hits.push({
      id: 'user-facing-outage',
      severity: 'warn',
      message: `This makes ${userFacingDown.length} user-facing service(s) unavailable: ${userFacingDown
        .map((i) => i.displayName)
        .join(', ')}.`,
    });
  }

  if (confidence.score < 50) {
    hits.push({
      id: 'weak-evidence',
      severity: 'warn',
      message: `Confidence is ${confidence.score}/100. Acting now is a guess, and the guess is destructive.`,
    });
  }

  return hits;
}

function recommend(
  reversibility: Reversibility,
  confidence: Confidence,
  guardrails: GuardrailHit[],
): Recommendation {
  if (guardrails.some((g) => g.severity === 'block')) return 'reject';
  if (REVERSIBILITY_RANK[reversibility] >= 3 && confidence.score < 80) return 'reject';
  if (confidence.score < 45) return 'reject';
  if (REVERSIBILITY_RANK[reversibility] >= 1 || confidence.score < 75 || guardrails.length > 0) {
    return 'approve-with-caution';
  }
  return 'approve';
}

/**
 * Produce the full report. This is the function the MCP approval gate calls, and its
 * output is what a human actually reads before deciding.
 */
export function computeBlastRadius(
  proposal: ActionProposal,
  state: SystemState,
): BlastRadiusReport {
  const service = String(proposal.args.service ?? '');
  const { reversibility, undo, effect } = resolveUndo(proposal, state);

  const directEffect: 'unavailable' | 'degraded' =
    proposal.tool === 'restart_service' || proposal.tool === 'rollback_deploy'
      ? 'unavailable'
      : 'degraded';

  const impacted = traverseImpact(state.services, service, directEffect);
  const confidence = scoreConfidence(proposal.evidence);
  const guardrails = checkGuardrails(proposal, state, impacted, confidence);
  const recommendation = recommend(reversibility, confidence, guardrails);

  const convergence = CONVERGENCE_SECONDS[proposal.tool] ?? 30;
  const affectedRps = impacted
    .filter((i) => i.effect === 'unavailable' || i.effect === 'degraded')
    .reduce((sum, i) => sum + (state.services.find((s) => s.id === i.serviceId)?.rps ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    action: proposal,
    reversibility,
    effect,
    impacted,
    inFlight: {
      requestsAffected: Math.round(affectedRps * convergence),
      windowSeconds: convergence,
      basis: `${affectedRps.toFixed(0)} rps across affected services for a ${convergence}s convergence window.`,
    },
    undo,
    confidence,
    guardrails,
    recommendation,
    headline: buildHeadline(recommendation, reversibility, impacted, confidence),
  };
}

function buildHeadline(
  recommendation: Recommendation,
  reversibility: Reversibility,
  impacted: ImpactedService[],
  confidence: Confidence,
): string {
  const userFacing = impacted.filter((i) => i.userFacing && i.effect !== 'no-effect').length;
  const reach = `${impacted.length} service(s)${userFacing > 0 ? `, ${userFacing} user-facing` : ''}`;

  if (recommendation === 'reject') {
    return `Do not run this yet — ${reversibility.replace(/-/g, ' ')}, touches ${reach}, confidence ${confidence.score}/100.`;
  }
  if (recommendation === 'approve-with-caution') {
    return `Runnable, but read the undo path first — ${reversibility.replace(/-/g, ' ')}, touches ${reach}, confidence ${confidence.score}/100.`;
  }
  return `Low risk — fully reversible, touches ${reach}, confidence ${confidence.score}/100.`;
}
