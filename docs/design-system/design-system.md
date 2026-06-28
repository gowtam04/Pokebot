# Oak — Design System

> The visual language for Oak. Frontend teammates should read this **before**
> starting any UI work, alongside the `frontend-design` skill. This document
> provides the *what* (the constraints — tokens, scales, component rules); the
> `frontend-design` skill provides the *how* to make each component look
> exceptional. Every component should still be crafted with care, not
> mechanically assembled from tokens.

## Design Philosophy

**A friendly Pokédex companion with a precise data core.** Oak is a personal
tool for one technically-comfortable Pokémon fan who swings between *serious
competitive team-building* (filter tables, stat math, damage calc, mechanics
reasoning) and *casual Pokédex curiosity* (lookups, sprites, evolutions). The
chrome should feel warm, rounded, and approachable — the delight of a modern
Pokédex device and a polished consumer chat app — while the **data core stays
crisp and legible**: tables, stat figures, and damage math read like an
instrument, not a toy. *Playful chrome, precise data.*

Two ideas anchor everything below:

1. **The chrome is warm; the color comes from the content.** Surfaces are soft,
   warm neutrals. The saturated energy comes from the iconic **18 Pokémon type
   colors**, Pokémon sprites/artwork, and a single Pokédex-red brand accent — not
   from a busy UI.
2. **Transparency is a first-class surface.** Reasoning, citations, inference
   flags, and generation-fallback caveats are part of *every* answer (US-12,
   BR-3/4). They get real, legible, well-differentiated treatments — never buried
   gray fine-print.

**Signature elements** (what makes Oak recognizable):

- A **Pokédex-red header band** with a rounded **Fredoka** wordmark — the app
  reads like a friendly device.
- **Pill-shaped, tinted type badges** in the refined 18-type palette — the
  recurring color motif, everywhere a type appears.
- A **Poké Ball spinner** for tool-activity / loading states.
- A subtle **spring "pop"** on sprite cards and suggestion chips.

---

## Color Palette

All colors are delivered as **CSS custom properties** with light and dark values
(see *Implementation Notes*). Both themes ship from day one (owner decision).
Neutrals carry a deliberate **warm taupe undertone** — never cold blue-gray — to
hold the "warm" feel.

### Brand Colors

| Token            | Role                                                              | Light       | Dark (if different) |
| ---------------- | ----------------------------------------------------------------- | ----------- | ------------------- |
| `--poke-red`     | **Primary** — primary buttons, wordmark, header band, active nav  | `#EE5A5A`   | `#FF6B6B`           |
| `--poke-red-hover`| Primary hover                                                    | `#E04545`   | `#FF7E7E`           |
| `--poke-red-active`| Primary pressed                                                 | `#C93B3B`   | `#F25C5C`           |
| `--poke-red-soft`| Primary tint — selected rows, soft fills, focus halos            | `#FCEBEB`   | `#3A1E1E`           |
| `--sunflower`    | **Secondary** — energy/highlight accents, the "estimate" tag      | `#F5A524`   | `#F8B73E`           |
| `--sunflower-soft`| Secondary tint background                                        | `#FDF1DC`   | `#3A2E14`           |
| `--azure`        | **Accent** — links, focus ring, info, interactive (non-primary)   | `#3AA0E3`   | `#5BB4EF`           |
| `--azure-soft`   | Accent tint — inference callout fill, info chips                  | `#E6F2FB`   | `#16263A`           |

**Why these:** Poké Red is the device/Poké-Ball identity color and carries the
brand. The Sunflower gold reads as "energy/estimate" warmth. Azure keeps links
and focus rings distinct from the red primary so red stays reserved for *the*
primary action. Red + gold + sky is a classic warm, friendly trio that still
leaves the type palette room to sing.

### Neutral Scale (warm)

A single warm-taupe ramp powers backgrounds, borders, and text in both themes.

| Token           | Hex       | Typical use                                       |
| --------------- | --------- | ------------------------------------------------- |
| `--neutral-0`   | `#FFFFFF` | Pure white — light-mode cards                      |
| `--neutral-50`  | `#FBF7F4` | Light-mode page background (warm paper)            |
| `--neutral-100` | `#F3ECE6` | Sunken/subtle fills, zebra rows (light)            |
| `--neutral-200` | `#E9E0D8` | Borders, dividers (light)                          |
| `--neutral-300` | `#D8CCC1` | Strong borders, disabled fills (light)             |
| `--neutral-400` | `#B8A99C` | Placeholder text, disabled text (light)            |
| `--neutral-500` | `#94867A` | Muted/meta text (both themes)                      |
| `--neutral-600` | `#6E625A` | Secondary text (light)                             |
| `--neutral-700` | `#4E453F` | Strong borders/dividers (dark)                     |
| `--neutral-800` | `#332D29` | Elevated surface (dark)                            |
| `--neutral-900` | `#231F1C` | Card/surface (dark)                               |
| `--neutral-950` | `#161311` | Dark-mode page background (warm near-black)        |

### Semantic Colors

Tuned to stay distinct from the brand red.

| Token         | Role               | Light     | Dark      | Soft fill (light / dark)   |
| ------------- | ------------------ | --------- | --------- | -------------------------- |
| `--success`   | Success, "yes/works"| `#2FB573` | `#46C98A` | `#E3F6EC` / `#10301F`      |
| `--warning`   | Caution, staleness | `#F08C00` | `#FBA53B` | `#FDEFD9` / `#3A2A0F`      |
| `--danger`    | Error, "fails/no"  | `#E0394A` | `#FF5C6B` | `#FCE8EA` / `#3A1518`      |
| `--info`      | Info (= `--azure`) | `#3AA0E3` | `#5BB4EF` | `#E6F2FB` / `#16263A`      |

> `--danger` (cool crimson) is intentionally separated from `--poke-red` (warm
> coral) so an *error* never reads as the *brand*. Use `--danger` for failure
> states (move fails, resolution failed); use `--poke-red` for brand/primary.

### Surface Colors

| Token              | Role                                  | Light       | Dark        |
| ------------------ | ------------------------------------- | ----------- | ----------- |
| `--bg`             | Page background                       | `#FBF7F4`   | `#161311`   |
| `--surface`        | Card / answer card / composer         | `#FFFFFF`   | `#231F1C`   |
| `--surface-raised` | Popovers, elevated panels, sticky bars| `#FFFFFF`   | `#332D29`   |
| `--surface-sunken` | Table zebra, code, disclosure bodies  | `#F7F1EB`   | `#1C1916`   |
| `--border`         | Default borders/dividers              | `#E9E0D8`   | `#3A332E`   |
| `--border-strong`  | Emphasis borders, input borders       | `#D8CCC1`   | `#4E453F`   |
| `--text-strong`    | Primary text / headings               | `#2A2521`   | `#F5EFE9`   |
| `--text`           | Body text                             | `#3D362F`   | `#E4DAD0`   |
| `--text-muted`     | Secondary/meta text                   | `#6E625A`   | `#B7A99C`   |
| `--text-faint`     | Captions, disabled, placeholders      | `#94867A`   | `#8A7D72`   |

---

## Type Colors — The 18-Type Palette (Signature)

The most important color system in the product. These are the **refined
canonical** type colors (the modern flat set), tuned for consistent vibrancy.
Each type gets **one solid token**; the badge component derives its tinted fill,
text, and border from that single token via `color-mix`, so contrast stays
correct in both themes from one source of truth.

| Type      | Token (`--type-…`) | Solid hex | Solid-fill text |
| --------- | ------------------ | --------- | --------------- |
| Normal    | `--type-normal`    | `#A8A77A` | dark            |
| Fire      | `--type-fire`      | `#EE8130` | white           |
| Water     | `--type-water`     | `#6390F0` | white           |
| Electric  | `--type-electric`  | `#F7D02C` | dark            |
| Grass     | `--type-grass`     | `#7AC74C` | dark            |
| Ice       | `--type-ice`       | `#96D9D6` | dark            |
| Fighting  | `--type-fighting`  | `#C22E28` | white           |
| Poison    | `--type-poison`    | `#A33EA1` | white           |
| Ground    | `--type-ground`    | `#E2BF65` | dark            |
| Flying    | `--type-flying`    | `#A98FF3` | dark            |
| Psychic   | `--type-psychic`   | `#F95587` | white           |
| Bug       | `--type-bug`       | `#A6B91A` | dark            |
| Rock      | `--type-rock`      | `#B6A136` | dark            |
| Ghost     | `--type-ghost`     | `#735797` | white           |
| Dragon    | `--type-dragon`    | `#6F35FC` | white           |
| Dark      | `--type-dark`      | `#705746` | white           |
| Steel     | `--type-steel`     | `#B7B7CE` | dark            |
| Fairy     | `--type-fairy`     | `#D685AD` | dark            |

### Badge treatment (default: tinted fill)

Pill-shaped, tinted, with the type color as label + border. This is the default
everywhere a type appears (sprite cards, candidate rows, inline in text). The
recipe derives everything from the single `--type` token, so adding/adjusting a
type means changing one value:

```css
.type-badge {                 /* maps to existing src/components/TypeBadge.tsx */
  --type: var(--type-normal); /* overridden by the modifier below */
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font: 600 11px/1 var(--font-body);
  letter-spacing: 0.03em;
  text-transform: capitalize;
  background: color-mix(in srgb, var(--type) 16%, var(--surface));
  color:      color-mix(in srgb, var(--type) 72%, var(--text-strong));
  border: 1px solid color-mix(in srgb, var(--type) 30%, transparent);
}
.type-badge--fire     { --type: var(--type-fire); }
.type-badge--water    { --type: var(--type-water); }
/* …one modifier per type, matching `.type-badge--{slug}` already in the code… */

[data-theme="dark"] .type-badge {
  background: color-mix(in srgb, var(--type) 26%, var(--surface));
  color:      color-mix(in srgb, var(--type) 45%, #ffffff);
}
```

### Badge treatment (emphasis: solid fill)

For filter chips or selected states, a solid fill reads stronger. Use the solid
token as the background and the **Solid-fill text** column above for the label
color (`dark` = `--text-strong`, `white` = `#FFFFFF`). Reach for this sparingly —
the tinted default keeps dense tables calm.

### Usage rules

- A type badge **always** carries its label text — color alone never conveys
  type (accessibility; AC-11.2). The dot-only style is out of scope (owner chose
  the refined tinted treatment).
- Dual-type Pokémon show two badges side by side, primary type first, `6px` gap.
- Type color is for *badges and small accents only* — never tint a full card or
  large surface with a type color; the warm neutral chrome stays in charge.

---

## Typography

### Font Families

| Role            | Font            | Stack / fallback                                   | Why |
| --------------- | --------------- | -------------------------------------------------- | --- |
| **Display**     | **Fredoka**     | `"Fredoka", "Segoe UI", system-ui, sans-serif`     | Rounded, friendly, geometric — the Pokédex-companion voice. Wordmark + card/section titles only. |
| **Body / UI**   | **Nunito Sans** | `"Nunito Sans", system-ui, -apple-system, sans-serif` | Warm rounded terminals, excellent small-size legibility — carries all reading text and UI. |
| **Numeric/Mono**| **JetBrains Mono** | `"JetBrains Mono", ui-monospace, "SF Mono", monospace` | Tabular figures for stat columns, damage math, and dex numbers — alignment and clarity in dense data. |

All three load via `next/font/google` and expose `--font-display`,
`--font-body`, `--font-mono` (see *Implementation Notes*). Avoid the generic
defaults (Inter/Roboto/Arial) — the Fredoka + Nunito Sans pairing *is* the
personality.

### Type Scale

| Name        | Font          | Size / line-height | Weight | Use                                                   |
| ----------- | ------------- | ------------------ | ------ | ----------------------------------------------------- |
| `display`   | Fredoka       | 28px / 1.2         | 600    | Wordmark in the header band                            |
| `title`     | Fredoka       | 22px / 1.3         | 600    | Page/section titles, empty-state headline              |
| `heading`   | Fredoka       | 18px / 1.35        | 500    | Answer-card section titles ("Sources", "Why")          |
| `subhead`   | Nunito Sans   | 16px / 1.4         | 700    | In-answer subheadings (markdown `##`/`###`), table caption |
| `body-lg`   | Nunito Sans   | 16px / 1.6         | 400    | Answer body (`answer_markdown`) — the primary read     |
| `body`      | Nunito Sans   | 15px / 1.55        | 400    | Default UI text, reasoning body, composer input        |
| `small`     | Nunito Sans   | 13px / 1.5         | 500    | Citations, captions, helper text, table cells          |
| `micro`     | Nunito Sans   | 11px / 1.4         | 600    | Badges, tags, dex labels (often `letter-spacing 0.03em`, caps) |
| `mono`      | JetBrains Mono| 14px / 1.5         | 500    | Stat cells, dex numbers, inline figures (tabular)      |
| `mono-lg`   | JetBrains Mono| 24px / 1.2         | 600    | The damage/stat **result** figure in `DamageReadout`   |

### Typography Rules

- **Max line length:** answer body capped at **70ch** for readability; the chat
  thread content column is `820px` max (see *Layout*).
- **Heading hierarchy:** Fredoka is reserved for the wordmark and for
  card/section *chrome* titles. Headings *inside* answer markdown use Nunito Sans
  (subhead) — long-form reading stays in the body font; Fredoka in body text gets
  bubbly and tiring.
- **Numbers are mono:** any stat, dex number, damage value, PP/power/accuracy, or
  computed figure renders in JetBrains Mono with tabular figures
  (`font-variant-numeric: tabular-nums`) so columns align.
- **Sentence case** everywhere except `micro` tags/labels, which may use ALL-CAPS
  with letter-spacing.

---

## Spacing & Layout

### Spacing Scale (4px base)

| Token       | px  | Typical use                                              |
| ----------- | --- | -------------------------------------------------------- |
| `--space-1` | 4   | Icon↔label gaps, badge inner padding                     |
| `--space-2` | 8   | Tight stacks, chip gaps, table cell vertical padding     |
| `--space-3` | 12  | Compact component padding, gap between badges & meta     |
| `--space-4` | 16  | **Base rhythm** — default gap between blocks in a card    |
| `--space-5` | 20  | Card inner padding, message bubble padding               |
| `--space-6` | 24  | Answer-card padding, gap between answer sections          |
| `--space-8` | 32  | Gap between turns in the thread                           |
| `--space-10`| 40  | Page gutters (desktop)                                    |
| `--space-12`| 48  | Section separation, empty-state vertical padding          |
| `--space-16`| 64  | Large hero/empty spacing                                  |

The dominant rhythm is **8/16/24**. Keep it disciplined — uniform spacing is what
makes dense data feel calm.

### Layout

- **Page shell:** sticky **header band** (top) + scrolling thread + sticky
  **composer** (bottom). Desktop-first; collapses cleanly to a single column on
  mobile (it already is one).
- **Content column:** centered, **`max-width: 820px`** for the thread. Answer
  cards fill the column width.
- **Wide content escape hatch:** the `CandidateTable` may exceed the text column;
  it gets `overflow-x: auto` inside the card rather than forcing the column wider.
- **Grid:** no formal column grid is needed (single-column chat). Within cards,
  use flex/stack with the spacing scale. The `subjects[]` sprite cards lay out as
  a wrap-flex row (`gap: --space-3`).
- **Breakpoints:** `sm 480px`, `md 768px`, `lg 1024px`. Below `768px`: page
  gutters drop to `--space-4`, header band compresses, candidate table stays
  scrollable.

---

## Component Patterns

Concrete visual rules for each component already scaffolded in `src/components/`
(structure exists; this is the styling contract). States are described for
default / hover / active / disabled / focus where they apply.

### Buttons

| Variant       | Fill / border                          | Text             | Use                                  |
| ------------- | -------------------------------------- | ---------------- | ------------------------------------ |
| `primary`     | `--poke-red` fill                      | white            | Composer **Send**, primary CTA       |
| `secondary`   | `--surface` fill, `--border-strong`    | `--text-strong`  | Secondary actions                    |
| `ghost`       | transparent                            | `--text-muted`   | Tertiary / icon buttons, disclosures |
| `danger`      | `--danger` fill                        | white            | Destructive (e.g. clear conversation)|

- **Sizes:** `sm` 28px tall / `12px` h-padding / `micro` text; `md` (default) 38px
  / `16px` / `body`; `lg` 46px / `20px` / `body-lg`. Radius `--radius-md` (10px);
  font-weight 600.
- **Hover:** primary → `--poke-red-hover`; secondary/ghost → surface darkens one
  step (`--surface-sunken`). Transition `--motion-fast`.
- **Active:** primary → `--poke-red-active`, translate-y `1px` (gentle press).
- **Disabled:** `--neutral-300` fill / `--text-faint` text, no shadow,
  `cursor: not-allowed`, 60% opacity on icons.
- **Focus:** `--focus-ring` (see Accessibility) — always visible on keyboard.

### Inputs & the Composer

- **Composer** (`Composer.tsx`): docked, sticky bottom bar on `--surface-raised`
  with a top `1px --border`. The text field is a rounded `--radius-lg` (16px)
  pill-ish input, `--surface` fill, `1px --border-strong`, `--space-4` padding,
  `body` text; a circular `--poke-red` Send button (icon) at the right.
- **Focus:** border → `--azure`, plus `--focus-ring` halo. No focus → resting
  border.
- **Disabled** (while a turn streams): input dims to `--surface-sunken`,
  placeholder "Oak is thinking…", Send shows the **Poké Ball spinner**.
- **Generic text input** (if needed elsewhere): same field styling; label in
  `small` weight 700 above the field at `--space-2`; **error state** = border
  `--danger`, helper text `--danger` in `small`, `--space-1` below.
- **Field spacing:** `--space-4` between stacked fields.

### Cards

- **AnswerCard** (the hero, `AnswerCard.tsx`): `--surface` fill, `--radius-lg`
  (16px), `1px --border`, `--shadow-raised`, `--space-6` padding. Internal
  sections separated by `--space-6`; a hairline `--border` divider precedes the
  collapsible **Reasoning** and **Sources** footers. Reading order is fixed by
  `AnswerCard.tsx`: caveat strip → answer body → sprite cards → candidate table →
  damage readout → inference callout → suggestion chips → reasoning → sources.
- **User message bubble:** right-aligned, max `70%` width, `--poke-red-soft` fill,
  `--text-strong`, `--radius-lg` with the bottom-right corner tightened to
  `--radius-sm` (a chat-tail cue), `--space-3 --space-4` padding.
- **Assistant turn:** the full AnswerCard, left-aligned, full column width (no
  bubble — the card *is* the message).
- Cards are not generally hover-interactive (except sprite cards, below).

### Sprite Card (signature)

`SpriteCard.tsx` — sprite/artwork + name + dex number + type badges for
`subjects[]`.

- **Frame:** `--surface-sunken` fill, `--radius-xl` (24px), `1px --border`,
  `--space-4` padding; the sprite sits on a subtle radial "screen" wash
  (`color-mix(--azure 6%, --surface-sunken)`) evoking a Pokédex screen.
- **Sprite:** PokeAPI artwork, `image-rendering: auto` for official art /
  `pixelated` for low-res sprites, centered, max `120px`.
- **Name:** `heading` (Fredoka), dex number in `mono` `--text-muted` (`#0445`
  style: zero-padded `#0006`).
- **Types:** tinted type badges below the name, `--space-2` gap.
- **Hover (signature pop):** `transform: scale(1.03)` + `--shadow-floating`,
  `--motion-spring`. Disable under `prefers-reduced-motion`.
- **Fallback flag:** when `is_fallback`, a `--warning` `micro` pill ("Gen 8") sits
  top-right of the frame (ties to the caveat strip; BR-1/US-13).

### Data Display

**Candidate table** (`CandidateTable.tsx`) — the competitive workhorse; keep it
dense but scannable.

- **Layout:** `--surface` with `overflow-x: auto`; columns: sprite thumb (32px) ·
  name · type badges · key stats (mono, tabular, right-aligned) · ability.
- **Header:** sticky, `--surface-sunken`, `micro` caps `--text-muted`, `1px
  --border` bottom. Sortable columns show a small caret in the active sort
  direction (`sort` field).
- **Rows:** 40px tall, `--space-2 --space-3` cell padding, `1px --border` hairline
  separators; **zebra** via `--surface-sunken` on even rows (subtle). Row
  **hover:** `--poke-red-soft` wash + `cursor: pointer` (rows are clickable →
  "Tell me about <name>" follow-up).
- **Truncation footer:** when `truncated`, a footer row in `small` `--text-muted`:
  "Showing 20 of 142 — refine to narrow." Always honor "N of M".
- **Numbers:** stat cells in `mono`; the sorted column's figures get
  `--text-strong`, others `--text`.

**Status / tag pills** (reused across the card):

- `estimate` tag (damage calc): `--sunflower-soft` fill, `--sunflower`-dark text,
  `micro`, pill — "estimate".
- `generation` badge: `micro` pill; Gen-9 native = `--success-soft`;
  fallback = `--warning-soft` ("Gen 8 data").
- `confidence` (on inferences): `micro` — `high`/`med`/`low` mapped to
  `--success` / `--sunflower` / `--text-muted` dot + label.

### Feedback, Transparency & Overlays

These transparency surfaces are core to Oak (US-12, BR-3/4) and each gets a
distinct, legible treatment — never gray fine-print.

- **CaveatStrip** (`CaveatStrip.tsx`) — uncertainty / generation-fallback banner.
  Full-width strip at the **top** of the card, `--warning-soft` fill, `3px`
  left border in `--warning`, `--radius-md`, warning icon + `small` weight-600
  text. For hard "not in Gen 9" fallback, same layout. Prominent but not alarming.
- **InferenceCallout** (`InferenceCallout.tsx`) — "this is my deduction, not
  stated data" (BR-3). Distinct from caveats: `--azure-soft` fill, `1px dashed
  --azure` border, `--radius-md`, a lightbulb/brain icon, each inference listing
  `claim` + a `confidence` pill + optional `note`. The **dashed** border is the
  visual signal for "inferred, not cited."
- **SourceList** (`SourceList.tsx`) — collapsible "Sources" disclosure at the card
  foot. Closed by default; trigger in `heading` (Fredoka) with a chevron + a
  `micro` count pill. Open body on `--surface-sunken`, each citation = `small`
  text with `source` bold, `detail` muted, and `endpoint_url` as an `--azure`
  link (opens new tab).
- **ReasoningBlock** (`ReasoningBlock.tsx`) — collapsible "Why" disclosure, same
  disclosure pattern as Sources, closed by default; body renders
  `reasoning_markdown` in `body`.
- **DamageReadout** (`DamageReadout.tsx`) — the result figure big in `mono-lg`
  `--text-strong`; an `estimate` tag beside it; an **assumptions** list
  (`small`, `--text-muted`, label: value) and a worked **breakdown** in a
  `--surface-sunken` `mono` block. Min–max range shown as `min–max`.
- **SuggestionChips** (`SuggestionChips.tsx`) — clickable pills for
  resolution/clarification suggestions. `--surface` fill, `1px --border-strong`,
  `--radius-pill`, `small` text; **hover** `--azure` border + `--azure-soft` fill
  + the spring pop; click sends the chosen name as a follow-up turn.
- **Tool-activity / loading:** while a turn streams, show the **Poké Ball
  spinner** + the streamed `tool_activity` label ("📊 querying Pokédex…") as a
  left-aligned, `--text-muted` `small` line where the answer card will appear.
- **Skeleton:** the incoming AnswerCard may show a shimmer skeleton (title bar +
  3 text lines) on `--surface-sunken` if activity labels aren't yet streaming.
- **Empty state** (fresh session, no turns): centered, the Fredoka wordmark, a
  one-line invitation, and **3–4 example-query SuggestionChips** ("Pokémon that
  learn Trick Room and Will-O-Wisp", "Does Fake Out work on Farigiraf?",
  "Fastest Fire types").
- **Transport error** (the SSE `error` event only): an inline `--danger-soft`
  strip with a "Try again" `secondary` button — distinct from in-domain
  answer statuses, which render as normal cards.

---

## Motion & Interaction

| Token             | Value                                  | Use                                      |
| ----------------- | -------------------------------------- | ---------------------------------------- |
| `--motion-fast`   | `140ms cubic-bezier(0.2,0.8,0.2,1)`    | Hover, color, border, focus transitions  |
| `--motion-base`   | `220ms cubic-bezier(0.2,0.8,0.2,1)`    | Disclosure open/close, card entrance     |
| `--motion-spring` | `260ms cubic-bezier(0.34,1.56,0.64,1)` | The signature "pop" — sprite cards, chips |

- **Default:** a single `--motion-fast` ease covers ~80% of interactions (hover,
  focus, button states).
- **Answer entrance:** new turns fade-up `8px` over `--motion-base`; candidate
  rows may stagger in at `~24ms`/row (cap the stagger at ~12 rows).
- **Loading:** the **Poké Ball spinner** (a red/white circle with the center
  button, rotating) is the signature loader; also acceptable as the Send-button
  busy state.
- **Disclosures:** Reasoning/Sources expand with a height/opacity `--motion-base`
  transition and a chevron rotate.
- **`prefers-reduced-motion`:** disable the spring pop, the entrance fade-up, and
  the row stagger; keep instantaneous color/opacity changes only.

---

## Shadows & Elevation

Warm-tinted, soft shadows (never harsh black). In dark mode, lean on border +
surface-step contrast and keep shadows subtle.

| Level             | Token              | Light value                                                        | Use                                |
| ----------------- | ------------------ | ------------------------------------------------------------------ | ---------------------------------- |
| Flat              | —                  | none; rely on `1px --border`                                       | Table rows, inline elements        |
| Raised            | `--shadow-raised`  | `0 1px 2px rgba(74,53,42,.05), 0 4px 12px rgba(74,53,42,.07)`       | Answer cards, sprite cards, composer|
| Floating          | `--shadow-floating`| `0 6px 16px rgba(74,53,42,.10), 0 2px 6px rgba(74,53,42,.08)`       | Hovered sprite card, popovers       |
| Overlay           | `--shadow-overlay` | `0 16px 40px rgba(74,53,42,.18)`                                   | Modals (if any later)               |

Dark mode: roughly halve the alpha and warm the base toward black
(`rgba(0,0,0,.35)` for overlay). Elevation in dark is communicated primarily by
stepping `--surface` → `--surface-raised`.

---

## Iconography

- **Library:** **Phosphor Icons** (`@phosphor-icons/react`), *regular* weight as
  default, *bold* for active/emphasis. Its rounded style matches Fredoka +
  Nunito Sans; Lucide is an acceptable fallback if Phosphor isn't desired.
- **Sizes:** `16px` inline with `small`/`body`, `20px` default UI / buttons,
  `24px` section headers.
- **Stroke/weight:** Phosphor "regular" pairs with body weight; use "bold" only
  where text is 600+.
- **Common icons:** chevron (disclosures), magnifying-glass (resolve/suggest),
  lightbulb or brain (inferences), warning-triangle (caveats), book-open
  (sources), link (citation URLs), paper-plane (Send).

---

## Accessibility

- **Contrast:** target **WCAG AA** — 4.5:1 for body text, 3:1 for large text and
  UI/graphical elements. The tinted type-badge recipe is built to clear AA in
  both themes; verify any **solid-fill** badge against the *Solid-fill text*
  column.
- **Focus ring** (`--focus-ring`): `0 0 0 2px var(--surface), 0 0 0 4px var(--azure)`
  — a 2px azure ring with a surface-colored offset. Always visible on keyboard
  focus; never remove outlines without this replacement.
- **Color is never the only signal:** type badges carry labels; inference vs
  caveat differ by *shape* (dashed azure vs solid warning strip) not just color;
  success/failure answers include an icon + word, not just a hue.
- **Touch targets:** desktop-first, but keep interactive targets ≥ **36×36px**
  (chips, table rows, Send). Composer Send is ≥ 40px.
- **Theme:** respect `prefers-color-scheme` for the default; the manual toggle
  must persist the choice. Both themes are first-class.
- **Motion:** honor `prefers-reduced-motion` (see Motion).
- **Markdown answers:** ensure rendered headings map to real heading levels and
  links are distinguishable by more than color (underline on hover/focus).

---

## Implementation Notes

**Stack reality:** Next.js App Router + React 19, TypeScript strict. **No Tailwind
and no CSS framework** — components already use BEM-ish semantic class names
(`.type-badge--{type}`, `.answer-card`, `.candidate-table`, `.chat-page__header`).
So tokens land as **CSS custom properties in a global stylesheet**, and component
styles target those existing class names.

1. **Tokens file:** create `src/app/globals.css` and import it once in
   `src/app/layout.tsx`. Define all tokens under `:root` (light) and override the
   theme-varying ones under `[data-theme="dark"]`. Default to system via:
   ```css
   :root { /* light tokens */ }
   @media (prefers-color-scheme: dark) {
     :root:not([data-theme="light"]) { /* dark overrides */ }
   }
   [data-theme="dark"] { /* dark overrides (manual toggle) */ }
   ```
   A `data-theme` attribute on `<html>` drives the manual toggle; persist the
   user's choice in `localStorage` (single user — no server state needed).

2. **Fonts:** load via `next/font/google` in `layout.tsx` — `Fredoka`,
   `Nunito_Sans`, `JetBrains_Mono` — and expose them as
   `--font-display`, `--font-body`, `--font-mono` on `<body>`. Set
   `font-feature-settings: "tnum" 1` (tabular nums) on `--font-mono` usages.

3. **Type colors:** define the 18 `--type-{slug}` solid tokens once (theme-stable
   — the same solids in both modes; only the badge *recipe* differs by theme).
   `TypeBadge.tsx` already emits `.type-badge .type-badge--{type}` — add one
   modifier rule per type setting `--type`, and the shared recipe above does the
   rest. One source of truth per type.

4. **Radius scale tokens:** `--radius-sm 6px`, `--radius-md 10px`,
   `--radius-lg 16px`, `--radius-xl 24px`, `--radius-pill 999px`.

5. **Class-name contract:** style the existing BEM-ish names rather than
   introducing a utility system — keep the component JSX untouched where possible
   (the structure is already shipped from Phase 7).

6. **`color-mix` support:** the badge recipe uses `color-mix(in srgb, …)`
   (baseline in all current evergreen browsers; fine for a personal desktop tool).
   If a static fallback is ever needed, precompute the tint/text per type.

7. **Per-component craft:** these tokens are the *constraints*, not the design.
   When building each component, apply the **`frontend-design` skill's** aesthetic
   philosophy — intentional spacing, real hover/empty/loading states, and the
   signature touches (Pokédex header band, Poké Ball spinner, sprite-card pop) —
   so the result feels crafted, not assembled.

**Token home:** `src/app/globals.css` (single source). Component CSS may live
alongside components or in `globals.css`; either way, reference tokens — never
hardcode hex values in component styles.
