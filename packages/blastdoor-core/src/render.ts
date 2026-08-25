import type { BlastRadiusReport, ImpactedService } from './types.ts';

const EFFECT_GLYPH: Record<ImpactedService['effect'], string> = {
  unavailable: 'DOWN',
  degraded: 'DEGRADED',
  'elevated-latency': 'SLOW',
  'no-effect': 'OK',
};

const VERDICT_LABEL = {
  approve: 'SAFE TO RUN',
  'approve-with-caution': 'PROCEED WITH CARE',
  reject: 'DO NOT RUN',
} as const;

/**
 * Render the report as the text a human sees in the approval prompt.
 *
 * Ordering is the whole design here. The verdict and the undo path come first, because
 * those are the two things that change the decision; the evidence and the graph come
 * after, because those are what someone reads when they want to disagree with the
 * verdict. An approval card that opens with a wall of evidence gets skimmed, and a
 * skimmed approval is the same as no approval at all.
 */
export function renderApprovalCard(report: BlastRadiusReport): string {
  const lines: string[] = [];
  const rule = '─'.repeat(72);

  lines.push(rule);
  lines.push(`BLASTDOOR · ${VERDICT_LABEL[report.recommendation]}`);
  lines.push(rule);
  lines.push('');
  lines.push(report.headline);
  lines.push('');

  lines.push(`ACTION      ${report.action.tool}(${formatArgs(report.action.args)})`);
  lines.push(`EFFECT      ${report.effect}`);
  lines.push(`REVERSIBLE  ${report.reversibility.replace(/-/g, ' ')}`);
  lines.push('');

  lines.push('UNDO');
  if (report.undo.possible) {
    for (const step of report.undo.procedure) lines.push(`  - ${step}`);
    if (report.undo.windowSeconds !== null) {
      lines.push(`  ! Undo window closes in ${report.undo.windowSeconds}s.`);
    }
  } else {
    lines.push('  - No undo path exists for this action.');
  }
  if (report.undo.residualLoss) {
    lines.push(`  ! Not recoverable: ${report.undo.residualLoss}`);
  }
  lines.push('');

  lines.push(`BLAST RADIUS (${report.impacted.length} services)`);
  for (const svc of report.impacted) {
    const tag = svc.userFacing ? ' [user-facing]' : '';
    lines.push(`  ${EFFECT_GLYPH[svc.effect].padEnd(9)} ${svc.displayName}${tag}  (+${svc.hops} hop)`);
    lines.push(`            ${svc.reasoning}`);
  }
  lines.push('');
  lines.push(
    `IN FLIGHT   ~${report.inFlight.requestsAffected.toLocaleString()} requests over ${report.inFlight.windowSeconds}s`,
  );
  lines.push(`            ${report.inFlight.basis}`);
  lines.push('');

  lines.push(`CONFIDENCE  ${report.confidence.score}/100`);
  for (const b of report.confidence.basis) lines.push(`  + ${b}`);
  for (const g of report.confidence.gaps) lines.push(`  - ${g}`);
  lines.push('');

  if (report.guardrails.length > 0) {
    lines.push('GUARDRAILS');
    for (const g of report.guardrails) {
      lines.push(`  [${g.severity.toUpperCase()}] ${g.message}`);
    }
    lines.push('');
  }

  lines.push('AGENT RATIONALE');
  lines.push(`  ${report.action.rationale}`);
  lines.push('');
  lines.push(rule);

  return lines.join('\n');
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
}

/** Compact one-line summary, for logs and for the session timeline in the console. */
export function renderSummary(report: BlastRadiusReport): string {
  return `[${VERDICT_LABEL[report.recommendation]}] ${report.action.tool} · ${report.reversibility} · ${report.impacted.length} services · confidence ${report.confidence.score}`;
}
