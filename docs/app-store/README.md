# Oak — App Store listing materials

Covers **iOS only**. There is no Android target in this repo (no `android/` directory), so no Google Play listing was produced.

**Store name:** `Oak – AI Battle Coach` · **Subtitle:** `Team Builder & Calculator`. The bare name "Oak" was taken in the App Store, so a descriptor was appended — this changes only the App Store *display name*, not the bundle id (`us.optiwise.oak`), the `oak.optiwise.us` domain, or the in-app "Oak" assistant persona.

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

- The `ios.md` Description's disclaimer paragraph — read it once against your actual legal comfort level. It's a plain non-affiliation/unofficial disclaimer (matching Apple's own third-party-trademark guidance) and **deliberately omits any "fair use" claim** — fair use is an affirmative defense only a court can decide, so stating it in store copy carries no legal weight, isn't recognized by App Review, and can read as an admission of using protected IP. (Naming "Pokémon" to describe compatibility is covered by trademark *nominative* fair use, established by conduct, not by a self-applied label.) Heads-up — contrary to an earlier note here, Oak **does display copyrighted images at runtime**: official artwork + sprites hot-linked from the PokeAPI/Showdown CDNs (`web/src/lib/sprites.ts`, iOS `SpriteImage`), not bundled in the binary. That image use, not the listing wording, is the real IP exposure; it's accepted as a tolerated risk in the iPhone-app `decisions.md` (ADR-11).
- The Keywords string in `ios.md`/`aso-keywords.md` — paste-ready, but double-check it still reads right once the Subtitle is finalized in App Store Connect (the string was built to avoid duplicating Subtitle words).
