# Demo script

Three minutes, one incident, every harness feature on the critical path.
`scripts/demo-drive.ts` runs it against the real MCP server and broker, so the only live
skills required are narrating and holding one button.

**Scenes advance when you press Enter**, not on a timer. The times below are the target
shape of the edit, not a countdown you have to keep up with — take as long as each line
needs and the terminal will wait. The driver prints what it is waiting for, e.g.
`[ Enter AFTER you have walked the rejection card ]`.

## Setup before recording

Four terminals plus a browser. Get all of this running and green *before* you hit record.

```bash
npm run stack        # 1 — the estate            :4000
npm run mcp          # 2 — MCP + broker          :4300 / :4200
npm run console      # 3 — the console           :4100
npm run harness      # 4 — TrueForge             :8790   (auto-patches on Windows)
npm run provision    #     once, after adding a model key
```

Open **http://localhost:4100** and put it beside the terminal you will run the driver in.
Record at 1920×1080. Hide bookmarks and notifications.

Rehearse once with `node scripts/demo-drive.ts --fast` so you know the beats.

---

## Shot list

### 0:00–0:20 · The problem

**On screen:** a plain `[y/N]` approval prompt, either a slide or a mock terminal line.

> "Every agent framework has human-in-the-loop approval. Almost all of it looks like this.
> This prompt teaches the operator nothing — they can't tell whether the rollback is safe,
> what else it takes down, or whether it can be undone. So they approve it, because the
> agent sounded confident and the incident is burning."

Cut to the Blastdoor console, idle, graph slowly rotating.

> "Blastdoor is the same pause, with the report that should have been attached to it."

### 0:20–0:45 · The incident

**Run:** `node scripts/demo-drive.ts` — scene 1 fires.

**On screen:** the metrics table, then the 3D graph.

> "A payment-failures alert. The agent investigates with read-only tools over MCP — it
> cannot change anything yet. The error gradient points back to payments-svc; checkout and
> the gateway are downstream of it."

Drag the graph once so the judge sees it is live 3D, not a picture.

### 0:45–1:20 · The obvious rollback, refused ← **the moment**

**On screen:** scene 2. Switch to the browser as the card lands.

> "The agent finds the deploy that landed six minutes before the spike and proposes rolling
> it back. That is the reasonable move, and Blastdoor refuses it."

Point at, in this order — **do not rush this, it is the whole project**:

1. **`DO NOT RUN`** and *irreversible*.
2. **Undo: none.** "This deploy carried a schema migration. Rolling the code back leaves old
   code against a new schema. There is no way back."
3. **Blast radius** — watch the wave travel outward. "Payments, then checkout, then the
   gateway — in hop order, because that is the path the failure actually takes. 91,000
   requests."
4. **Confidence 28/100.** "And the case is timing alone. Something else changing in the same
   window would look identical."

> "None of that is in `[y/N]`."

### 1:20–1:45 · The sandbox earns the evidence

**On screen:** scene 3 in the terminal.

> "So the agent does what the rejection told it to. It delegates to two subagents, and it
> writes code in the TrueForge sandbox to replay the failing request against the suspect
> deploy and its predecessor."

```
dep-4c21 (suspect)     -> FAIL
dep-3b90 (predecessor) -> PASS
```

> "Fail, then pass. That is causal evidence, and no amount of metric-reading gets you
> there — you have to actually run it."

### 1:45–2:20 · The same action, now with proof

**On screen:** scene 4, back to the browser.

> "Same rollback. Same target. Confidence is now 91, because two independent investigators
> agree and the replay is causal — Blastdoor scores corroboration, not confidence."

> "But it is *still irreversible*. The migration has not gone away. So the verdict is
> 'proceed with care', not 'safe'."

### 2:20–2:45 · Hold to confirm

**On screen:** the approve button.

> "And because it cannot be undone, the console will not let me click it."

**Press and hold.** Let the ring fill. **Release early once** so the shake is visible.

> "Commitment has to accrue. Release early and it cancels. You cannot do this by reflex,
> and unlike a dialog you cannot dismiss it without reading — the wait is the reading time."

Hold it fully. Token appears. Copy it, paste into the terminal.

### 2:45–3:00 · Close

**On screen:** scene 5 executing, then the recovered metric.

> "Executed with a token bound to those exact arguments — single use, and it expires. The
> symptom clears."

> "The agent could never have run that itself. It can only ever produce a well-argued
> request. That is the whole idea."

---

## Things worth showing if you have slack

- `npm run e2e` — nine passing safety assertions in ten seconds. Very persuasive on camera.
- The TrueForge session view, showing the harness driving the tools.
- `npm run provision` — the integration as code rather than a click-through.

## Recording notes

- Talk over the pauses; the driver is timed to leave room.
- If a beat runs long, cut the graph drag rather than the rejection card.
- Do not narrate the architecture. Judges read the README for that; the video is for the
  moment the rollback gets refused.
