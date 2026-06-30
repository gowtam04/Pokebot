# Oak — App Store Screenshot Guide (iOS)

6 frames, ordered competitive-first (team building / battle math leads, casual Q&A and onboarding support it) per the agreed audience priority. Written as a production spec for a designer or an image-generation workflow — no trademarked wording appears anywhere in this guide, consistent with the rest of `docs/app-store/`.

## Global style notes (apply to every frame)

- **Color palette** (from `docs/design-system/design-system.md`, used purely as color — never named in any on-screen text):
  - Primary ("brand red"): `#EE5A5A` (light) / `#FF6B6B` (dark)
  - Secondary ("brand gold"): `#F5A524` (light) / `#F8B73E` (dark)
  - Accent ("brand azure"): `#3AA0E3` (light) / `#5BB4EF` (dark)
  - Neutral background: warm off-white `#FBF7EE` / dark mode near-black `#1C1A18`
  - 18-color type-badge palette (small pill-shaped tags) recurs in Frame 5 — keep these vivid against neutral backgrounds so they read as the app's signature motif.
- **Typography**: geometric/rounded sans-serif (system-feel, like SF Pro Rounded), medium-to-bold weight for headlines, regular weight for subheadlines and in-app UI text.
- **Mood across the set**: friendly and confident, with a precise, data-trustworthy undertone — playful chrome around precise data, never silly or cluttered.
- **Device mockup**: generic iPhone Pro-style frame (no real-device photography, no third-party logos). Vary tilt/position per frame for rhythm, per the notes below.
- **Loading/activity motif**: where a frame needs to suggest "the agent is working," use a simple dual-tone circular spinner (red/white split) — a generic loading indicator, not any franchise-specific iconography.

## Aspect ratio guidance

- Primary target: iPhone 6.9" class (iPhone 17 Pro Max-equivalent) — **1320×2868 px**.
- Apple currently auto-generates smaller required sizes from the largest uploaded set; still prepare a 6.7" fallback set — **1290×2796 px** — in case manual upload is needed.
- Oak is iPhone-only (no iPad target in v1) — do not prepare iPad-sized frames.

---

### Frame 1 of 6 — Hook: reasoned, cited answers

**Headline:** "Answers, Not Just Data"
**Subheadline:** "Ask anything — get reasoning, sources, and honesty about what's uncertain."
**App screen featured:** The Chat tab's thread view (`ChatThreadScreen`), scrolled to a fully expanded `AnswerCardView` — the answer markdown text, an expanded "Reasoning" section beneath it, 2–3 small citation chips, and one visible inference/uncertainty flag (icon + short label, not color-only).
**Composition and device:** iPhone mockup centered, tilted ~8° clockwise. Headline sits above the device; subheadline directly beneath the headline, above the device's top edge.
**Background and color treatment:** Soft top-to-bottom gradient from warm cream `#FBF7EE` to a pale red-tinted cream `#F7E9E6` — introduces the brand red without overwhelming a frame about trust and clarity.
**Mood and energy:** Calm, confident, trustworthy — this frame has to work as a standalone hook.

### Frame 2 of 6 — Core feature: competitive team builder

**Headline:** "Build Your Battle Team"
**Subheadline:** "Full competitive sets — species, item, moves, nature, EVs, IVs, Tera type."
**App screen featured:** The team editor screen (Teams feature) with one roster slot mid-edit — move-slot pickers, a nature dropdown, and EV sliders all visible and partially filled — plus 2–3 other completed slots shown collapsed in a list below it.
**Composition and device:** Device centered, no tilt (this frame is about precision, not motion). Headline above the device.
**Background and color treatment:** Bold gradient from brand red `#EE5A5A` to a deeper red `#D94545`; the editor's light-card UI floats with a soft drop shadow for contrast.
**Mood and energy:** Energetic, capable — "you can build something real here."

### Frame 3 of 6 — Core feature: team import/export

**Headline:** "Import Teams Instantly"
**Subheadline:** "Paste a team string from your favorite calculator — Oak builds it for you."
**App screen featured:** The team-import sheet, showing a block of pasted team text on one side visually transforming (via a small arrow/transform motif) into a populated, formatted team list on the other.
**Composition and device:** Device centered; a small secondary translucent card floats beside the phone showing a "paste" icon/cursor, illustrating the import action without needing extra screen real estate inside the mockup.
**Background and color treatment:** Light gradient from white to brand azure `#3AA0E3` at the edges — ties the frame to the accent color used for actions/links in the real app.
**Mood and energy:** Efficient, frictionless — emphasize speed.

### Frame 4 of 6 — Core feature: regulation-format toggle

**Headline:** "Switch Formats Instantly"
**Subheadline:** "One toggle scopes your entire chat to the current competitive ruleset."
**App screen featured:** The header/toolbar area showing the format toggle control mid-tap (a two-state switch), with the chat content below visibly reflecting the alternate format's data/tag.
**Composition and device:** Device tilted ~8° counter-clockwise (opposite of Frame 1, for set rhythm). Headline above the device.
**Background and color treatment:** Split-gradient background — left half fades from brand gold `#F5A524`, right half fades from brand red `#EE5A5A` — visually representing "before/after the switch."
**Mood and energy:** Precise, in control.

### Frame 5 of 6 — Core feature: artifact viewer drill-down

**Headline:** "See the Math Behind It"
**Subheadline:** "Drill into damage calcs and type matchups without losing your chat."
**App screen featured:** The chat shown dimmed/blurred in the background, with the artifact-viewer bottom sheet raised over it mid-drag, displaying either a damage-calculation breakdown or a type-matchup grid using the 18-color type-badge palette.
**Composition and device:** Device centered, cropped slightly at the bottom edge so the bottom sheet appears to emerge from the frame's bottom third, emphasizing the edge-to-edge sheet feel.
**Background and color treatment:** Light neutral `#F4F1EA` — kept deliberately quiet so the colorful type badges are the visual focus.
**Mood and energy:** Detailed, satisfying — the "aha, now I get it" moment.

### Frame 6 of 6 — Social proof / CTA: guest vs. account

**Headline:** "Start Free, Sync Anywhere"
**Subheadline:** "Chat instantly as a guest. Sign in with an email code to save it all."
**App screen featured:** The Account tab, showing the guest-state tier section alongside a secondary callout of the email one-time-code sign-in sheet (email field + 6-digit code field).
**Composition and device:** Main device centered; a smaller, semi-transparent secondary phone frame offset behind/beside it displaying the sign-in sheet — a two-device "before/after" storytelling composition.
**Background and color treatment:** A soft closing "brand wash" — all three brand colors (red, gold, azure) blended at low opacity into the neutral background, with a slightly stronger gold accent in one corner to feel like a warm close to the set.
**Mood and energy:** Welcoming, low-friction — this is the closing CTA frame.
