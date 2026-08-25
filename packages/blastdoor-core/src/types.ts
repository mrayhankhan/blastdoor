/**
 * Core vocabulary for reasoning about destructive operations.
 *
 * The central idea: an approval prompt is only useful if the human reading it learns
 * something they did not already know. "Allow rollback of deploy 4c21? [y/N]" teaches
 * nothing. So every type here exists to carry a specific fact the operator would
 * otherwise have to go and look up under time pressure, at 3am, while an incident burns.
 */

/**
 * How badly wrong this can go, and whether the road back exists.
 *
 * This is deliberately not a boolean. Most real operations are not cleanly reversible
 * or irreversible — they are reversible only within a window, or reversible except for
 * the data that was in flight. Collapsing that nuance is how operators get surprised.
 */
export type Reversibility =
  /** State can be restored exactly. Nothing is lost. */
  | 'reversible'
  /** The action can be undone, but only before `undoWindowSeconds` elapses. */
  | 'reversible-within-window'
  /** State can be restored, but work in flight at the moment of execution is lost. */
  | 'reversible-with-loss'
  /** There is no undo. */
  | 'irreversible';

/** Ordered worst-last, so severities can be compared numerically. */
export const REVERSIBILITY_RANK: Record<Reversibility, number> = {
  reversible: 0,
  'reversible-within-window': 1,
  'reversible-with-loss': 2,
  irreversible: 3,
};

export interface ServiceNode {
  id: string;
  displayName: string;
  /** Services this one calls. Edges point in the direction of the request. */
  dependsOn: string[];
  /** Current requests per second, used to size in-flight impact. */
  rps: number;
  /** How many replicas are currently serving. Restarting the last one is an outage. */
  replicas: number;
  /**
   * Whether the service can absorb a dependency being briefly unavailable.
   * A service with a circuit breaker and a cache degrades; one without fails hard.
   * This is what turns a dependency edge into an actual user-visible impact.
   */
  degradesGracefully: boolean;
  /** Customer-facing services are ranked higher when summarising impact. */
  userFacing: boolean;
}

export interface Deploy {
  id: string;
  service: string;
  /** ISO timestamp. */
  deployedAt: string;
  sha: string;
  summary: string;
  /** The deploy this one replaced, i.e. where a rollback would land. */
  previousDeployId: string | null;
  /** Whether the artifact for this deploy is still retained and can be re-pulled. */
  artifactRetained: boolean;
  /** Migrations make rollback lossy, because the schema moved forward. */
  includesMigration: boolean;
}

/** A single piece of evidence the agent gathered before proposing an action. */
export interface Evidence {
  id: string;
  /** Which read-only tool produced this. */
  source: string;
  claim: string;
  /**
   * How directly this supports the causal story.
   * 'correlational' means "these things happened near each other in time",
   * which is the most common and most misleading kind of incident evidence.
   */
  strength: 'causal' | 'correlational' | 'circumstantial';
  /**
   * Which subagent produced this, when the work was delegated. Corroboration from
   * independent investigators is worth more than the same claim restated, and the
   * operator can only weigh that if they can see who found what.
   */
  investigator?: string;
  observedAt: string;
}

export interface ActionProposal {
  /** The destructive tool the agent wants to call. */
  tool: string;
  args: Record<string, unknown>;
  /** The agent's own account of why this action follows from the evidence. */
  rationale: string;
  evidence: Evidence[];
}

/** One service that will feel this action, and how. */
export interface ImpactedService {
  serviceId: string;
  displayName: string;
  /** 0 = the direct target, 1 = its caller, and so on outward. */
  hops: number;
  effect: 'unavailable' | 'degraded' | 'elevated-latency' | 'no-effect';
  userFacing: boolean;
  /** Why the traversal concluded this, in one line a human can check. */
  reasoning: string;
}

export interface UndoPlan {
  possible: boolean;
  /** Concrete steps, not prose. Empty when `possible` is false. */
  procedure: string[];
  /** Null when there is no deadline on undoing. */
  windowSeconds: number | null;
  /** What cannot be recovered even after a successful undo. */
  residualLoss: string | null;
}

export interface Confidence {
  /** 0-100. Deliberately coarse: this is a prior, not a measurement. */
  score: number;
  /** The reasons the score is as high as it is. */
  basis: string[];
  /** The reasons it is not higher. These are the most important lines in the report. */
  gaps: string[];
}

/** A policy violation that should stop or qualify the action regardless of evidence. */
export interface GuardrailHit {
  id: string;
  severity: 'block' | 'warn';
  message: string;
}

export type Recommendation = 'approve' | 'approve-with-caution' | 'reject';

/**
 * The artifact the whole system exists to produce: everything a human needs in order to
 * say yes or no in about fifteen seconds, without opening another tab.
 */
export interface BlastRadiusReport {
  generatedAt: string;
  action: ActionProposal;
  reversibility: Reversibility;
  /** Plain-language statement of what actually changes. */
  effect: string;
  impacted: ImpactedService[];
  /** Requests expected to be lost or degraded while the action takes effect. */
  inFlight: {
    requestsAffected: number;
    windowSeconds: number;
    basis: string;
  };
  undo: UndoPlan;
  confidence: Confidence;
  guardrails: GuardrailHit[];
  recommendation: Recommendation;
  /** One sentence a tired operator can act on. */
  headline: string;
}
