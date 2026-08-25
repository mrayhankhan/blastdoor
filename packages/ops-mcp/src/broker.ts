import { randomUUID } from 'node:crypto';
import type { ActionProposal, BlastRadiusReport } from '../../blastdoor-core/src/types.ts';

/**
 * The approval broker.
 *
 * The safety property this enforces is narrow and worth stating precisely: a destructive
 * tool call cannot reach the target system unless a human, out of band, has issued a
 * token for that exact proposal. Not for that tool, not for that service — for that
 * proposal, identified by a hash of its arguments.
 *
 * This matters because the usual approval pattern ("the agent asks, the human says yes")
 * is only as strong as the description the agent wrote. If the agent can broaden the
 * action between asking and acting, the approval was for something else. Binding the
 * token to the argument hash closes that gap: change the arguments and the token no
 * longer matches.
 */

export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'expired';

export interface Proposal {
  id: string;
  createdAt: string;
  status: ProposalStatus;
  action: ActionProposal;
  report: BlastRadiusReport;
  /** Binds the token to these exact arguments. */
  argsFingerprint: string;
  /** Issued only on human approval; single use. */
  token: string | null;
  /** Who decided, and why. Recorded for the audit trail. */
  decidedBy: string | null;
  decisionNote: string | null;
  expiresAt: string;
}

/** Approvals should not sit around indefinitely; a stale approval is a stale judgement. */
const TTL_MS = 15 * 60 * 1000;

function fingerprint(action: ActionProposal): string {
  const canonical = JSON.stringify({
    tool: action.tool,
    args: Object.fromEntries(Object.entries(action.args).sort(([a], [b]) => a.localeCompare(b))),
  });
  // Short, readable, and good enough to detect argument drift between ask and act.
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = (hash * 31 + canonical.charCodeAt(i)) | 0;
  }
  return `fp_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export class ApprovalBroker {
  private proposals = new Map<string, Proposal>();

  create(action: ActionProposal, report: BlastRadiusReport): Proposal {
    const now = Date.now();
    const proposal: Proposal = {
      id: `prop_${randomUUID().slice(0, 8)}`,
      createdAt: new Date(now).toISOString(),
      status: 'pending',
      action,
      report,
      argsFingerprint: fingerprint(action),
      token: null,
      decidedBy: null,
      decisionNote: null,
      expiresAt: new Date(now + TTL_MS).toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  get(id: string): Proposal | undefined {
    const proposal = this.proposals.get(id);
    if (proposal && proposal.status === 'pending' && Date.parse(proposal.expiresAt) < Date.now()) {
      proposal.status = 'expired';
    }
    return proposal;
  }

  list(): Proposal[] {
    for (const id of this.proposals.keys()) this.get(id);
    return [...this.proposals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  approve(id: string, decidedBy: string, note?: string): { ok: boolean; token?: string; error?: string } {
    const proposal = this.get(id);
    if (!proposal) return { ok: false, error: `No proposal ${id}.` };
    if (proposal.status === 'expired') return { ok: false, error: 'Proposal expired; ask the agent to re-propose.' };
    if (proposal.status !== 'pending') return { ok: false, error: `Proposal is already ${proposal.status}.` };

    proposal.token = `tok_${randomUUID().replace(/-/g, '')}`;
    proposal.status = 'approved';
    proposal.decidedBy = decidedBy;
    proposal.decisionNote = note ?? null;
    return { ok: true, token: proposal.token };
  }

  deny(id: string, decidedBy: string, note?: string): { ok: boolean; error?: string } {
    const proposal = this.get(id);
    if (!proposal) return { ok: false, error: `No proposal ${id}.` };
    if (proposal.status !== 'pending') return { ok: false, error: `Proposal is already ${proposal.status}.` };

    proposal.status = 'denied';
    proposal.decidedBy = decidedBy;
    proposal.decisionNote = note ?? null;
    return { ok: true };
  }

  /**
   * Redeem a token for permission to execute. Single use, bound to the argument
   * fingerprint, and checked against the arguments actually being submitted — so an agent
   * that gets approval for one action and then tries to run a broader one is refused.
   */
  redeem(
    id: string,
    token: string,
    submittedAction: ActionProposal,
  ): { ok: boolean; error?: string; proposal?: Proposal } {
    const proposal = this.get(id);
    if (!proposal) return { ok: false, error: `No proposal ${id}.` };
    if (proposal.status === 'executed') return { ok: false, error: 'This approval was already used.' };
    if (proposal.status !== 'approved') return { ok: false, error: `Proposal is ${proposal.status}, not approved.` };
    if (proposal.token !== token) return { ok: false, error: 'Approval token does not match.' };

    const submitted = fingerprint(submittedAction);
    if (submitted !== proposal.argsFingerprint) {
      return {
        ok: false,
        error:
          `Arguments changed after approval (approved ${proposal.argsFingerprint}, submitted ${submitted}). ` +
          'The human approved a different action. Re-propose it.',
      };
    }

    proposal.status = 'executed';
    proposal.token = null;
    return { ok: true, proposal };
  }
}

export const broker = new ApprovalBroker();
