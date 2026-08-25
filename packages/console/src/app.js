/**
 * Blastdoor console.
 *
 * The design constraint that drove everything: the person reading this is deciding under
 * time pressure, and the cost of them skimming is an outage. So the page is ordered by
 * what changes the decision — verdict, then what breaks, then whether it can be undone,
 * then how good the evidence is — rather than by what is easiest to render.
 *
 * The approve button deliberately does not say "Approve". It names the action and, when
 * the action is irreversible, it says so on the button itself. A button that reads
 * "Approve — irreversible" is much harder to click by reflex than one that reads "OK".
 */

const BROKER = window.BLASTDOOR_BROKER ?? 'http://localhost:4200';
const POLL_MS = 1500;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const connEl = document.getElementById('conn');
const countEl = document.getElementById('count');

/** Tokens are shown once, in the browser, so the operator can hand them to the agent. */
const issuedTokens = new Map();
/** Keeps focus and typed notes from being blown away by the poll loop. */
const noteDrafts = new Map();

const EFFECT_LABEL = {
  unavailable: 'DOWN',
  degraded: 'DEGRADED',
  'elevated-latency': 'SLOW',
  'no-effect': 'OK',
};

const VERDICT_LABEL = {
  reject: 'Do not run',
  'approve-with-caution': 'Proceed with care',
  approve: 'Safe to run',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function confidenceTone(score) {
  if (score < 45) return 'tone-danger';
  if (score < 75) return 'tone-warn';
  return 'tone-safe';
}

function reversibilityTone(reversibility) {
  if (reversibility === 'irreversible') return 'tone-danger';
  if (reversibility === 'reversible') return 'tone-safe';
  return 'tone-warn';
}

function formatCall(tool, args) {
  const pairs = Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ');
  return `${tool}({ ${pairs} })`;
}

function renderFacts(p) {
  const facts = el('dl', 'facts');

  const reversibility = el('div', 'fact');
  reversibility.append(el('dt', null, 'Reversibility'));
  const rdd = el('dd', reversibilityTone(p.reversibility), p.reversibility.replace(/-/g, ' '));
  reversibility.append(rdd);
  facts.append(reversibility);

  const userFacing = p.impacted.filter((i) => i.userFacing && i.effect !== 'no-effect').length;
  const blast = el('div', 'fact');
  blast.append(el('dt', null, 'Blast radius'));
  const bdd = el('dd', userFacing > 0 ? 'tone-danger' : null, `${p.impacted.length} services`);
  bdd.append(el('small', null, userFacing > 0 ? `${userFacing} user-facing` : 'none user-facing'));
  blast.append(bdd);
  facts.append(blast);

  const flight = el('div', 'fact');
  flight.append(el('dt', null, 'Requests at risk'));
  const fdd = el('dd', null, `~${p.inFlight.requestsAffected.toLocaleString()}`);
  fdd.append(el('small', null, `over ${p.inFlight.windowSeconds}s`));
  flight.append(fdd);
  facts.append(flight);

  const undo = el('div', 'fact');
  undo.append(el('dt', null, 'Undo'));
  const udd = el('dd', p.undo.possible ? 'tone-safe' : 'tone-danger', p.undo.possible ? 'Available' : 'None');
  undo.append(udd);
  facts.append(undo);

  return facts;
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
    wrap.append(el('p', 'none', 'There is no undo path for this action.'));
  }
  if (p.undo.residualLoss) {
    wrap.append(el('p', 'residual', `Not recoverable: ${p.undo.residualLoss}`));
  }
  return wrap;
}

function renderBlast(p) {
  const wrap = el('div', 'blast');
  for (const svc of p.impacted) {
    const hop = el('div', 'hop');
    hop.dataset.effect = svc.effect;
    hop.append(el('div', 'hop-effect', EFFECT_LABEL[svc.effect] ?? svc.effect));

    const right = el('div');
    const name = el('div', 'hop-name', svc.displayName);
    name.append(el('span', 'tag', svc.userFacing ? `user-facing · +${svc.hops} hop` : `+${svc.hops} hop`));
    right.append(name);
    right.append(el('div', 'hop-why', svc.reasoning));
    hop.append(right);
    wrap.append(hop);
  }
  return wrap;
}

function renderConfidence(p) {
  const wrap = el('div');

  const head = el('div', 'confidence-head');
  head.append(el('span', `confidence-score ${confidenceTone(p.confidence.score)}`, String(p.confidence.score)));
  head.append(el('span', 'confidence-of', 'out of 100'));
  wrap.append(head);

  const meter = el('div', 'meter');
  const bar = el('span');
  bar.style.width = `${p.confidence.score}%`;
  bar.style.background =
    p.confidence.score < 45 ? 'var(--danger)' : p.confidence.score < 75 ? 'var(--warn)' : 'var(--safe)';
  meter.append(bar);
  wrap.append(meter);

  const reasons = el('ul', 'reasons');
  for (const b of p.confidence.basis) reasons.append(el('li', 'plus', b));
  for (const g of p.confidence.gaps) reasons.append(el('li', 'gap', g));
  wrap.append(reasons);

  return wrap;
}

function renderActions(p) {
  const actions = el('div', 'actions');

  const note = el('input', 'note');
  note.type = 'text';
  note.placeholder = 'Why are you approving or denying this? (recorded in the audit trail)';
  note.value = noteDrafts.get(p.id) ?? '';
  note.addEventListener('input', () => noteDrafts.set(p.id, note.value));
  actions.append(note);

  const deny = el('button', 'btn-deny', 'Deny');
  deny.addEventListener('click', () => decide(p.id, 'deny', note.value));
  actions.append(deny);

  const irreversible = p.reversibility === 'irreversible';
  const approve = el('button', 'btn-approve', irreversible ? 'Approve — irreversible' : `Approve ${p.tool}`);
  approve.dataset.risky = String(irreversible);
  approve.addEventListener('click', () => decide(p.id, 'approve', note.value));
  actions.append(approve);

  return actions;
}

function renderToken(p) {
  const token = issuedTokens.get(p.id);
  if (!token) return null;

  const wrap = el('div', 'token');
  wrap.append(el('p', null, 'Approved. Give this token to the agent so it can execute the action:'));
  wrap.append(el('code', null, token));
  return wrap;
}

function renderCard(p) {
  const card = el('article', 'card');
  card.dataset.verdict = p.recommendation;

  const verdict = el('div', 'verdict', VERDICT_LABEL[p.recommendation] ?? p.recommendation);
  verdict.dataset.verdict = p.recommendation;
  card.append(verdict);

  const body = el('div', 'card-body');
  body.append(el('h2', 'headline', p.headline));
  body.append(el('div', 'call', formatCall(p.tool, p.args)));
  body.append(renderFacts(p));
  body.append(renderSection('If this goes wrong', renderUndo(p)));
  body.append(renderSection(`Blast radius — ${p.impacted.length} services`, renderBlast(p)));
  body.append(renderSection('Confidence in the diagnosis', renderConfidence(p)));

  if (p.guardrails.length > 0) {
    const rails = el('div');
    for (const g of p.guardrails) {
      const row = el('div', 'guardrail');
      row.dataset.sev = g.severity;
      row.append(el('b', null, g.severity.toUpperCase()));
      row.append(el('span', null, g.message));
      rails.append(row);
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
    const decided = el(
      'div',
      'decided',
      `${p.status} by ${p.decidedBy ?? 'unknown'}${p.decisionNote ? ` — "${p.decisionNote}"` : ''}`,
    );
    card.append(decided);
  }

  return card;
}

async function decide(proposalId, action, note) {
  try {
    const res = await fetch(`${BROKER}/api/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalId, decidedBy: 'operator', note }),
    });
    const data = await res.json();
    if (data.token) issuedTokens.set(proposalId, data.token);
    noteDrafts.delete(proposalId);
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
    connEl.textContent = 'live';
    connEl.className = 'pill pill-live';
  } catch {
    connEl.textContent = 'broker offline';
    connEl.className = 'pill pill-down';
    return;
  }

  const pending = proposals.filter((p) => p.status === 'pending').length;
  countEl.textContent = `${pending} pending`;
  emptyEl.style.display = proposals.length === 0 ? '' : 'none';

  // Preserve the focused note field across the poll so typing is not interrupted.
  const focusedId = document.activeElement?.closest?.('.card')?.dataset?.proposalId;

  listEl.replaceChildren();
  for (const p of proposals) {
    const card = renderCard(p);
    card.dataset.proposalId = p.id;
    listEl.append(card);
  }

  if (focusedId) {
    listEl.querySelector(`[data-proposal-id="${focusedId}"] .note`)?.focus();
  }
}

refresh();
setInterval(refresh, POLL_MS);
