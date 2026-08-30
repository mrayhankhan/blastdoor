/**
 * Blastdoor console.
 *
 * Ordering is the design. The page is laid out by what changes the decision — verdict,
 * where this action sits on the reversibility ladder, what breaks, whether it can be
 * undone, then how good the evidence is — rather than by what is easiest to render. A
 * report that opens with a wall of evidence gets skimmed, and a skimmed approval is the
 * same as no approval at all.
 */
import { BlastGraph } from './graph.js';
import { DEMO_PROPOSALS, DEMO_TOPOLOGY } from './demo-data.js';

const BROKER = window.BLASTDOOR_BROKER ?? 'http://localhost:4200';
const STACK = window.BLASTDOOR_STACK ?? 'http://localhost:4000';
const POLL_MS = 1500;

/**
 * Demo mode. The full system is three processes and none of them exist on static
 * hosting, so the public deployment falls back to a captured proposal instead of showing
 * an error. It is labelled wherever it appears — a safety tool that quietly presented
 * fabricated state as live would be precisely the wrong thing to ship.
 */
let demoMode = false;
/** How long an irreversible action must be held before it commits. */
const HOLD_MS = 1600;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const connEl = document.getElementById('conn');
const countEl = document.getElementById('count');
const tooltipEl = document.getElementById('tooltip');

/** Tokens are shown once, client-side, so the operator can hand one to the agent. */
const issuedTokens = new Map();
/** Preserved across polls so typing is never interrupted by a refresh. */
const noteDrafts = new Map();
/** Which proposal is currently driving the 3D scene. */
let armedProposalId = null;
let lastSignature = '';

const EFFECT = {
  unavailable: { label: 'DOWN', glyph: '●' },
  degraded: { label: 'DEGRADED', glyph: '◐' },
  'elevated-latency': { label: 'SLOW', glyph: '○' },
  'no-effect': { label: 'OK', glyph: '○' },
};

const VERDICT = {
  reject: { label: 'Do not run', icon: '✕' },
  'approve-with-caution': { label: 'Proceed with care', icon: '⚠' },
  approve: { label: 'Safe to run', icon: '✓' },
};

const LADDER = [
  { key: 'reversible', short: 'Reversible', tone: 'good' },
  { key: 'reversible-within-window', short: 'Timed undo', tone: 'warning' },
  { key: 'reversible-with-loss', short: 'Lossy undo', tone: 'serious' },
  { key: 'irreversible', short: 'No undo', tone: 'critical' },
];

// ── 3D scene ────────────────────────────────────────────────────────────────

const graph = new BlastGraph(document.getElementById('stage'), {
  onHover: (hit) => {
    if (!hit) {
      tooltipEl.dataset.show = 'false';
      document.querySelectorAll('.hop[data-focused="true"]').forEach((el) => (el.dataset.focused = 'false'));
      return;
    }
    const effect = hit.effect ? EFFECT[hit.effect] : null;
    tooltipEl.innerHTML = '';
    tooltipEl.append(el('div', 'tip-name', hit.data.displayName));
    tooltipEl.append(
      el(
        'div',
        'tip-meta',
        effect
          ? `${effect.label} · +${hit.hops} hop · ${hit.data.rps} rps · ${hit.data.replicas}x`
          : `unaffected · ${hit.data.rps} rps · ${hit.data.replicas}x`,
      ),
    );
    tooltipEl.dataset.show = 'true';
    if (hit.cursor) {
      tooltipEl.style.left = `${hit.cursor.x}px`;
      tooltipEl.style.top = `${hit.cursor.y}px`;
    }
    // Cross-highlight the matching row in the panel.
    document.querySelectorAll('.hop').forEach((row) => {
      row.dataset.focused = String(row.dataset.serviceId === hit.id);
    });
  },
  onSelect: (hit) => {
    const row = document.querySelector(`.hop[data-service-id="${hit.id}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
});

// Exposed so the scene can be driven from the browser console during a demo or while
// debugging layout — e.g. __blastdoor.graph.replay() to re-run the wave on cue.
window.__blastdoor = { graph };

document.getElementById('replay').addEventListener('click', () => graph.replay());
document.getElementById('reset-view').addEventListener('click', () => {
  graph.spin.autoSpin = true;
  graph.spin.radius = 34;
  graph.spin.phi = 0.18;
  graph.focused = null;
});

fetch(`${STACK}/api/topology`)
  .then((r) => r.json())
  .then((t) => graph.setTopology(t.services))
  .catch(() => graph.setTopology(DEMO_TOPOLOGY));

// ── rendering helpers ───────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toneForConfidence(score) {
  if (score < 45) return 'critical';
  if (score < 75) return 'warning';
  return 'good';
}

function toneForReversibility(rev) {
  return LADDER.find((r) => r.key === rev)?.tone ?? 'critical';
}

function renderCall(tool, args) {
  const wrap = el('div', 'call');
  wrap.append(document.createTextNode(`${tool}({ `));
  Object.entries(args).forEach(([k, v], i, arr) => {
    wrap.append(el('span', 'arg-key', `${k}: `));
    wrap.append(el('span', 'arg-val', JSON.stringify(v)));
    if (i < arr.length - 1) wrap.append(document.createTextNode(', '));
  });
  wrap.append(document.createTextNode(' })'));
  return wrap;
}

/**
 * The reversibility ladder. Showing all four states with one lit makes the severity
 * relative — "irreversible" means more when you can see the three safer rungs it is not.
 */
function renderLadder(reversibility) {
  const ladder = el('div', 'ladder');
  for (const rung of LADDER) {
    const node = el('div', 'rung');
    node.dataset.active = String(rung.key === reversibility);
    node.dataset.tone = rung.tone;
    node.append(el('span', 'rung-bar'));
    node.append(el('span', 'rung-label', rung.short));
    ladder.append(node);
  }
  return ladder;
}

function renderMetrics(p) {
  const metrics = el('dl', 'metrics');
  const userFacing = p.impacted.filter((i) => i.userFacing && i.effect !== 'no-effect').length;

  const blast = el('div', 'metric');
  blast.append(el('dt', null, 'Blast radius'));
  const bdd = el('dd', userFacing > 0 ? 'tone-critical' : null, String(p.impacted.length));
  bdd.append(el('small', null, userFacing > 0 ? `${userFacing} user-facing` : 'none user-facing'));
  blast.append(bdd);
  metrics.append(blast);

  const flight = el('div', 'metric');
  flight.append(el('dt', null, 'At risk'));
  const fdd = el('dd', null, `~${(p.inFlight.requestsAffected / 1000).toFixed(1)}k`);
  fdd.append(el('small', null, `requests / ${p.inFlight.windowSeconds}s`));
  flight.append(fdd);
  metrics.append(flight);

  const undo = el('div', 'metric');
  undo.append(el('dt', null, 'Undo'));
  const udd = el('dd', p.undo.possible ? 'tone-good' : 'tone-critical', p.undo.possible ? 'Yes' : 'None');
  udd.append(el('small', null, p.undo.possible ? `${p.undo.procedure.length} steps` : 'one-way door'));
  undo.append(udd);
  metrics.append(undo);

  return metrics;
}

function renderSection(title, body) {
  const section = el('div', 'section');
  section.append(el('h3', null, title));
  section.append(body);
  return section;
}

function renderUndo(p) {
  const wrap = el('div', 'undo');
  if (p.undo.possible) {
    const ol = el('ol');
    for (const step of p.undo.procedure) ol.append(el('li', null, step));
    wrap.append(ol);
  } else {
    const none = el('p', 'none');
    none.append(el('span', null, '✕'));
    none.append(el('span', null, 'There is no undo path for this action.'));
    wrap.append(none);
  }
  if (p.undo.residualLoss) wrap.append(el('p', 'residual', `Not recoverable: ${p.undo.residualLoss}`));
  return wrap;
}

function renderBlast(p) {
  const wrap = el('div', 'blast');
  p.impacted.forEach((svc, i) => {
    const hop = el('div', 'hop');
    hop.dataset.effect = svc.effect;
    hop.dataset.serviceId = svc.serviceId;
    hop.dataset.focused = 'false';
    hop.style.animationDelay = `${i * 55}ms`;

    const meta = EFFECT[svc.effect] ?? { label: svc.effect, glyph: '○' };
    const effectCell = el('div', 'hop-effect');
    effectCell.append(el('span', 'glyph', meta.glyph));
    effectCell.append(el('span', null, meta.label));
    hop.append(effectCell);

    const right = el('div');
    const name = el('div', 'hop-name', svc.displayName);
    name.append(el('span', 'tag', svc.userFacing ? `user-facing · +${svc.hops}` : `+${svc.hops} hop`));
    right.append(name);
    right.append(el('div', 'hop-why', svc.reasoning));
    hop.append(right);

    hop.addEventListener('mouseenter', () => graph.focus(svc.serviceId));
    hop.addEventListener('click', () => graph.focus(svc.serviceId));
    wrap.append(hop);
  });
  return wrap;
}

/** Radial gauge. The sweep is the magnitude — it arrives at the number rather than stating it. */
function renderConfidence(p) {
  const row = el('div', 'gauge-row');
  const tone = toneForConfidence(p.confidence.score);

  const gauge = el('div', 'gauge');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 108 108');
  svg.setAttribute('width', '108');
  svg.setAttribute('height', '108');

  const r = 46;
  const circumference = 2 * Math.PI * r;

  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('class', 'gauge-track');
  track.setAttribute('cx', '54');
  track.setAttribute('cy', '54');
  track.setAttribute('r', String(r));
  svg.append(track);

  const fill = document.createElementNS(NS, 'circle');
  fill.setAttribute('class', 'gauge-fill');
  fill.setAttribute('cx', '54');
  fill.setAttribute('cy', '54');
  fill.setAttribute('r', String(r));
  fill.setAttribute('stroke', `var(--${tone})`);
  fill.setAttribute('stroke-dasharray', String(circumference));
  fill.setAttribute('stroke-dashoffset', String(circumference));
  svg.append(fill);
  gauge.append(svg);

  const center = el('div', 'gauge-center');
  const score = el('div', `gauge-score tone-${tone}`, '0');
  center.append(score);
  center.append(el('div', 'gauge-of', 'confidence'));
  gauge.append(center);
  row.append(gauge);

  const reasons = el('ul', 'reasons');
  p.confidence.basis.forEach((b, i) => {
    const li = el('li', 'plus', b);
    li.style.animationDelay = `${300 + i * 90}ms`;
    reasons.append(li);
  });
  p.confidence.gaps.forEach((g, i) => {
    const li = el('li', 'gap', g);
    li.style.animationDelay = `${300 + (p.confidence.basis.length + i) * 90}ms`;
    reasons.append(li);
  });
  row.append(reasons);

  // Commit the true values synchronously.
  //
  // The animation must never be load-bearing for correctness. requestAnimationFrame does
  // not fire in a background tab, and an approval console spends most of its life in one:
  // a proposal arrives, the operator switches to the tab, and if the sweep owned the
  // value they would be reading a confidence of 0 on a real decision. So the final state
  // is set now and the motion is layered on top only when someone is actually watching.
  const finalOffset = circumference * (1 - p.confidence.score / 100);
  fill.setAttribute('stroke-dashoffset', String(finalOffset));
  score.textContent = String(p.confidence.score);

  animateWhenVisible(() => {
    // Rewind to empty, then let the CSS transition carry it to the committed value.
    fill.style.transition = 'none';
    fill.setAttribute('stroke-dashoffset', String(circumference));
    requestAnimationFrame(() => {
      fill.style.transition = '';
      fill.setAttribute('stroke-dashoffset', String(finalOffset));
      countUp(score, p.confidence.score, 1400);
    });
  });

  return row;
}

/**
 * Run an entrance animation only when the document is actually visible, deferring it to
 * the moment it becomes visible otherwise. Reduced-motion users skip it entirely — the
 * values are already correct without it.
 */
function animateWhenVisible(run) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (!document.hidden) {
    run();
    return;
  }

  const once = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', once);
    run();
  };
  document.addEventListener('visibilitychange', once);
}

function countUp(node, target, duration) {
  const start = performance.now();
  const step = (now) => {
    // Clamped at both ends. Capping at 1 alone assumes the clock only moves forward, and
    // the easing below is a cubic: one negative t turns the readout into a large negative
    // number — on this element, a confidence score someone is about to make an irreversible
    // decision from.
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    // Same easing as the arc, so the number and the sweep land together.
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = String(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
    else node.textContent = String(target);
  };
  requestAnimationFrame(step);
}

/**
 * Hold-to-confirm.
 *
 * A one-way door should not be one click away from a tired person, so commitment has to
 * accrue. Releasing early cancels and the button shakes. Reversible actions get a normal
 * click, because making safe things laborious teaches people to rush through the
 * ceremony — the friction only means something if it is reserved for what deserves it.
 */
function wireApprove(button, irreversible, commit) {
  if (!irreversible) {
    button.addEventListener('click', commit);
    return;
  }

  let timer = null;

  const start = (e) => {
    e.preventDefault();
    if (timer) return;
    button.dataset.holding = 'true';
    button.dataset.cancelled = 'false';
    timer = setTimeout(() => {
      timer = null;
      button.dataset.holding = 'false';
      commit();
    }, HOLD_MS);
  };

  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    button.dataset.holding = 'false';
    button.dataset.cancelled = 'true';
    setTimeout(() => (button.dataset.cancelled = 'false'), 400);
  };

  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', cancel);
  button.addEventListener('pointerleave', cancel);
  button.addEventListener('pointercancel', cancel);
  // Keyboard equivalent: space or enter held down repeats keydown, so require a hold too.
  button.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') start(e);
  });
  button.addEventListener('keyup', cancel);
  button.addEventListener('blur', cancel);
}

function renderActions(p) {
  const actions = el('div', 'actions');

  const note = el('input', 'note');
  note.type = 'text';
  note.placeholder = 'Why are you approving or denying this? (recorded in the audit trail)';
  note.value = noteDrafts.get(p.id) ?? '';
  note.addEventListener('input', () => noteDrafts.set(p.id, note.value));
  actions.append(note);

  const row = el('div', 'button-row');

  const deny = el('button', 'btn-deny', 'Deny');
  deny.type = 'button';
  deny.addEventListener('click', () => decide(p.id, 'deny', note.value));
  row.append(deny);

  const irreversible = p.reversibility === 'irreversible';
  const approve = el('button', 'btn-approve');
  approve.type = 'button';
  approve.dataset.hold = String(irreversible);
  approve.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
  approve.append(el('span', 'fill'));
  const label = el('span', 'label');
  label.append(el('span', null, irreversible ? 'Hold to approve' : `Approve ${p.tool}`));
  approve.append(label);
  wireApprove(approve, irreversible, () => decide(p.id, 'approve', note.value));
  row.append(approve);

  actions.append(row);

  if (irreversible) {
    actions.append(el('p', 'hold-hint', `This cannot be undone — hold for ${(HOLD_MS / 1000).toFixed(1)}s to confirm`));
  }

  return actions;
}

function renderToken(p) {
  const token = issuedTokens.get(p.id);
  if (!token) return null;

  const wrap = el('div', 'token');
  wrap.append(el('p', null, 'Approved. Give this token to the agent so it can execute the action:'));
  const row = el('div', 'token-row');
  row.append(el('code', null, token));
  const copy = el('button', 'btn-copy', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(token);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1600);
  });
  row.append(copy);
  wrap.append(row);
  return wrap;
}

function renderCard(p) {
  const card = el('article', 'card');
  card.dataset.verdict = p.recommendation;
  card.dataset.proposalId = p.id;

  const meta = VERDICT[p.recommendation] ?? { label: p.recommendation, icon: '' };
  const verdict = el('div', 'verdict');
  verdict.dataset.verdict = p.recommendation;
  verdict.append(el('span', 'verdict-icon', meta.icon));
  verdict.append(el('span', null, meta.label));
  card.append(verdict);

  const body = el('div', 'card-body');
  body.append(el('h2', 'headline', p.headline));
  body.append(renderCall(p.tool, p.args));
  body.append(renderSection('Reversibility', renderLadder(p.reversibility)));
  body.append(renderMetrics(p));
  body.append(renderSection('If this goes wrong', renderUndo(p)));
  body.append(renderSection(`Blast radius — ${p.impacted.length} services`, renderBlast(p)));
  body.append(renderSection('Confidence in the diagnosis', renderConfidence(p)));

  if (p.guardrails.length > 0) {
    const rails = el('div');
    for (const g of p.guardrails) {
      const rowEl = el('div', 'guardrail');
      rowEl.dataset.sev = g.severity;
      rowEl.append(el('b', null, g.severity.toUpperCase()));
      rowEl.append(el('span', null, g.message));
      rails.append(rowEl);
    }
    body.append(renderSection('Policy', rails));
  }

  body.append(renderSection("Agent's reasoning", el('p', 'rationale', p.rationale)));
  card.append(body);

  if (p.status === 'pending') {
    card.append(renderActions(p));
  } else {
    const token = renderToken(p);
    if (token) card.append(token);
    const decided = el('div', 'decided');
    decided.dataset.status = p.status;
    decided.append(el('span', 'status-chip', p.status));
    decided.append(
      el('span', null, `by ${p.decidedBy ?? 'unknown'}${p.decisionNote ? ` — "${p.decisionNote}"` : ''}`),
    );
    card.append(decided);
  }

  return card;
}

// ── data flow ───────────────────────────────────────────────────────────────

async function decide(proposalId, action, note) {
  // In demo mode the decision is resolved locally so the hold-to-confirm interaction is
  // still explorable on the public deployment. Nothing is executed, and the issued token
  // is obviously fake.
  if (demoMode) {
    const proposal = DEMO_PROPOSALS.find((p) => p.id === proposalId);
    if (proposal) {
      proposal.status = action === 'approve' ? 'approved' : 'denied';
      proposal.decidedBy = 'you (demo)';
      proposal.decisionNote = note || null;
      if (action === 'approve') issuedTokens.set(proposalId, 'tok_demo_not_a_real_approval_token');
    }
    noteDrafts.delete(proposalId);
    lastSignature = '';
    await refresh();
    return;
  }

  try {
    const res = await fetch(`${BROKER}/api/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalId, decidedBy: 'operator', note }),
    });
    const data = await res.json();
    if (data.token) issuedTokens.set(proposalId, data.token);
    noteDrafts.delete(proposalId);
    lastSignature = '';
    await refresh();
  } catch (err) {
    console.error('decision failed', err);
  }
}

async function refresh() {
  let proposals;
  try {
    const res = await fetch(`${BROKER}/api/proposals`);
    proposals = (await res.json()).proposals ?? [];
    demoMode = false;
    connEl.textContent = 'live';
    connEl.className = 'pill pill-live';
  } catch {
    // No broker reachable. On the public deployment that is expected, so show the
    // captured proposal rather than an empty screen — but never claim it is live.
    demoMode = true;
    proposals = DEMO_PROPOSALS;
    connEl.textContent = 'demo — no live broker';
    connEl.className = 'pill pill-demo';
  }

  const pending = proposals.filter((p) => p.status === 'pending').length;
  countEl.textContent = `${pending} pending`;
  emptyEl.style.display = proposals.length === 0 ? '' : 'none';
  document.body.dataset.live = String(pending > 0);

  // Re-render only when something actually changed, so the entry animations and the
  // gauge sweep are not restarted on every poll.
  const signature = proposals.map((p) => `${p.id}:${p.status}`).join('|');
  if (signature === lastSignature) return;
  lastSignature = signature;

  const focusedId = document.activeElement?.closest?.('.card')?.dataset?.proposalId;
  listEl.replaceChildren();
  for (const p of proposals) listEl.append(renderCard(p));
  if (focusedId) listEl.querySelector(`[data-proposal-id="${focusedId}"] .note`)?.focus();

  // Arm the 3D scene with the newest pending proposal.
  const armed = proposals.find((p) => p.status === 'pending') ?? proposals[0];
  if (armed && armed.id !== armedProposalId) {
    armedProposalId = armed.id;
    graph.setImpact(armed.impacted);
  } else if (!armed) {
    armedProposalId = null;
    graph.clearImpact();
  }
}

refresh();
setInterval(refresh, POLL_MS);
