# Oak — App Store listing materials

Covers **iOS only**. There is no Android target in this repo (no `android/` directory), so no Google Play listing was produced.

- [`ios.md`](./ios.md) — App Store Connect fields (Name, Subtitle, Promotional Text, Description, Keywords, What's New) with character counts.
- [`aso-keywords.md`](./aso-keywords.md) — keyword research: Tier 1/2/3 terms, the literal iOS Keywords string, and competitor analysis (ProDex, Prokedex, Bulbapedia).
- [`screenshots.md`](./screenshots.md) — 6-frame screenshot production guide with global style notes and aspect ratios.

## Trademark policy applied throughout

Per explicit decision: the words "Pokémon"/"Pokédex" never appear in the App Name, Subtitle, or Keywords field, and appear in the Description exactly once, confined to a single unofficial-fan-app disclaimer paragraph (see `ios.md`). This mirrors the live, approved pattern used by ProDex and is in fact more conservative than every competitor surveyed — see the tradeoff note at the top of `aso-keywords.md`.

## Blockers before App Store Connect submission (not produced by this listing)

- **Privacy Policy must go live** at `oak.optiwise.us/privacy` — the iOS app's Account screen already links there, but no policy exists yet. Apple requires a real, reachable URL at submission time.
- **Support page must go live** at `oak.optiwise.us/support` — same placeholder-URL gap, referenced in the Description's contact line.
- **App Icon is still a placeholder** in `ios/OakApp/Resources/Assets.xcassets/AppIcon.appiconset` — needs a final design; the screenshot guide deliberately stays icon-agnostic so it isn't blocked on this.

## What to sanity-check first

- The `ios.md` Description's disclaimer paragraph — read it once against your actual legal comfort level; it's modeled on ProDex's live, approved wording but trimmed (Oak ships no Nintendo artwork, so the "fair use of images" clause was dropped).
- The Keywords string in `ios.md`/`aso-keywords.md` — paste-ready, but double-check it still reads right once the Subtitle is finalized in App Store Connect (the string was built to avoid duplicating Subtitle words).
