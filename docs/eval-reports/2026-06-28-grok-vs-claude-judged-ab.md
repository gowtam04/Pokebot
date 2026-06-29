# Agent A/B: Grok 4.3 vs Claude on the judged golden suite

**Date:** 2026-06-28
**Author:** generated from a live `npm run eval` A/B run
**Harness change that enabled this:** the new `eval/run.ts --model=<key>` flag (lets the
judged suite run on any registered agent model; defaults to Grok). Added alongside an
additive Grok prompt `<output_contract>` (this run already includes that prompt).

---

## TL;DR

- On the **quality rubric, Grok 4.3 is marginally ahead on every dimension** (notably
  inference-flagging) and ~2× faster per turn.
- On **cases passed, Claude edges it 10 vs 9** — but that one-case gap is driven almost
  entirely by **structural-assertion conformance** (exact citation `source` prefixes,
  `mustInclude` substrings, exact `status`), **not answer quality**.
- The bigger lever for the score is **not the model** — it's (a) tightening
  citation-format / substring expectations in the eval (or the prompt's citation
  conventions), and (b) reconciling several **stale out-of-scope golden cases** whose
  expectations now contradict the prompt's scope policy.

---

## What was measured

| | |
|---|---|
| Suite | Full judged golden suite, **G1–G25** (25 cases) |
| Agent (run A) | **xAI Grok 4.3** (`--model=grok-4.3`, the default) |
| Agent (run B) | **Claude Sonnet 4.6** (`--model=claude`, `ANTHROPIC_MODEL=claude-sonnet-4-6`) |
| Judge (both) | **Claude Sonnet 4.6** (`env.ANTHROPIC_MODEL`) |
| Data source | **Live Postgres index** (`pokebot@localhost:5432/pokebot`; SV 1313 rows, Champions 314) |
| Mode | `standard` (Gen 9 / Scarlet-Violet) |
| Pass criterion | All structural assertions pass **and** every rubric dimension ≥ its threshold |

**Commands run** (keys sourced from `.env.local`, `DATABASE_URL` pointed at the live index):

```bash
tsx eval/run.ts --model=grok-4.3   # run A
tsx eval/run.ts --model=claude     # run B
```

**Caveat on the judge:** for run B the agent *and* the judge are both Claude
(same family). The runner deliberately keeps the judge on Claude to compare apples-to-apples,
but same-family self-preference would, if anything, **inflate** Claude's scores — yet Claude
still only matched Grok. So the "Grok is at least as good" read is conservative.

---

## Headline results

| Metric | **Grok 4.3** | **Claude 4.6** | Δ (Grok − Claude) |
|---|---|---|---|
| **Cases passed** | 9 / 25 | **10 / 25** | −1 |
| answer_correctness | **1.60** | 1.56 | +0.04 |
| inference_flagging | **1.88** | 1.60 | **+0.28** |
| mechanics_precision | **1.76** | 1.72 | +0.04 |
| scope_adherence | **1.68** | 1.60 | +0.08 |
| transparency | **1.84** | 1.80 | +0.04 |
| Typical agent latency | ~9 s | ~15 s | ~2× faster |
| Wall-clock (full suite) | ~10.6 min | ~22.8 min | ~2× faster |

Rubric scale is 0–2 per dimension (judge-assigned).

---

## Per-case verdicts

✓ = pass, ✗ = fail. **Bold** rows are where the two models differ.

| Case | Grok | Claude | | Case | Grok | Claude |
|---|---|---|---|---|---|---|
| **G1** | ✗ | ✓ | | G13 | ✓ | ✓ |
| G2 | ✗ | ✗ | | G14 | ✗ | ✗ |
| G3 | ✗ | ✗ | | G15 | ✓ | ✓ |
| G4 | ✓ | ✓ | | G16 | ✗ | ✗ |
| G5 | ✓ | ✓ | | G17 | ✗ | ✗ |
| G6 | ✗ | ✗ | | G18 | ✗ | ✗ |
| G7 | ✓ | ✓ | | G19 | ✓ | ✓ |
| **G8** | ✗ | ✓ | | **G20** | ✓ | ✗ |
| G9 | ✗ | ✗ | | G21 | ✗ | ✗ |
| G10 | ✗ | ✗ | | G22 | ✗ | ✗ |
| G11 | ✗ | ✗ | | G23 | ✓ | ✓ |
| G12 | ✗ | ✗ | | **G24** | ✓ | ✗ |
| | | | | **G25** | ✗ | ✓ |

- Both pass (7): G4, G5, G7, G13, G15, G19, G23
- Grok-only pass (2): **G20, G24**
- Claude-only pass (3): **G1, G8, G25**

---

## The 5 differing cases — what actually happened

| Case | Grok | Claude | Cause | Real quality gap? |
|---|---|---|---|---|
| **G1** | ✗ | ✓ | Grok's learnset citations didn't match required prefixes `learnset/trick-room`, `learnset/will-o-wisp` | **No** — citation format |
| **G8** | ✗ | ✓ | Grok returned `insufficient_data` on an answerable filter (Fire-types, base Speed >100, learns Will-O-Wisp) instead of querying | **Yes — genuine Grok miss** |
| **G25** | ✗ | ✓ | Grok wrote "0× / takes no damage" but not the literal word **"immune"** (`mustInclude`) | **No** — phrasing |
| **G20** | ✓ | ✗ | Claude declined egg moves as out-of-scope; golden case expects `answered` | Stale case (see below) |
| **G24** | ✓ | ✗ | Claude cited `leftovers` instead of required prefix `item/leftovers` | **No** — citation format |

So of the 5 differences, **3 are pure formatting** (G1, G25, G24), **1 is a stale-case
scope conflict** (G20), and **only G8 is a real answer-quality miss** (Grok bailing on an
answerable query).

---

## Failure-type breakdown (across all failed cases)

| | Structural assertion fails | Rubric-zero (quality) dings |
|---|---|---|
| Grok | 23 | 7 |
| Claude | 17 | 12 |

Read: **Grok's failures skew structural** (citation/substring formatting) while its quality
holds up; **Claude takes more genuine quality zeros** (e.g. G17, G18, G20, G21) but conforms
to citation formats slightly more often — which is why it scrapes one extra pass despite the
lower rubric.

---

## Key findings & follow-ups (model-independent)

1. **Grok G8 — bailing on an answerable filter.** Grok returned `insufficient_data` for a
   query it should have answered with `query_pokedex`. This is the failure mode the new Grok
   `<output_contract>` targets; consider adding an explicit "never return
   `insufficient_data` for an answerable filter/superlative — query first" rule.

2. **Stale out-of-scope golden cases.** G14 (wild held items / Leftovers), G20 (egg moves),
   and G21 (catch locations) expect `status: answered`, but `src/agent/prompts/domain.ts`
   explicitly lists egg moves and locations as **out of scope**. Both models (correctly, per
   the prompt) decline and both "fail" these. This is an **eval-vs-prompt drift**, not a model
   defect — decide whether these are in scope and align the prompt and the golden suite.

3. **Structural assertions are brittle relative to good answers.** Many fails are exact
   `mustCite` source prefixes (`type/ground`, `item/leftovers`, `learnset/...`) and
   `mustInclude` substrings (`"immune"`, `"dragon"`, `"gen-"`, `"estimate"`) — a correct
   answer phrased differently still fails. Worth either loosening these to semantic checks or
   codifying the exact citation-source convention in the prompt so models hit it reliably.

4. **Model choice is close to a wash on quality.** Grok is marginally better on the rubric and
   ~2× faster/cheaper per turn; Claude is marginally better at structural conformance. Neither
   is a clear quality winner on this suite — so latency/cost (favoring Grok, the current
   default) is the deciding factor unless the structural/scope issues above are fixed first.

---

## How to reproduce

```bash
# from repo root, with XAI_API_KEY + ANTHROPIC_API_KEY set and DATABASE_URL
# pointed at a built index (e.g. the docker db: postgres://pokebot:pokebot@localhost:5432/pokebot)
tsx eval/run.ts --model=grok-4.3
tsx eval/run.ts --model=claude

# subset / regression variants:
tsx eval/run.ts --model=claude --case=G8,G20      # specific cases
tsx eval/run.ts --model=grok-4.3 --rebuild        # G1/G5/G6/G7/G17/G25 regression set
tsx eval/run.ts --model=claude --json             # machine-readable report
```

Valid `--model` keys: `grok-4.3`, `claude`, `gpt-5.5`. An unknown key prints the valid
list and exits non-zero before touching the DB.

## Raw artifacts

Full per-case judge output (every tool trace, rubric reason, and structural failure) is
saved next to this report:

- `2026-06-28-grok-4.3.judged.txt`
- `2026-06-28-claude-sonnet-4.6.judged.txt`
