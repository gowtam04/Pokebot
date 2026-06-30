# Oak — ASO Keyword Research (iOS)

**Scope:** iOS only (no Android target exists in this repo). **Trademark policy:** no use of the words "Pokémon"/"Pokédex" anywhere in the App Name, Subtitle, or Keywords field — every term below is generic genre/mechanic vocabulary. (The Description in `ios.md` is allowed exactly one disclaimer-paragraph mention, per the agreed trademark policy.)

## Deliberate tradeoff — read this first

All three competitor apps researched below use "pokemon"/"pokedex" freely in their own metadata — that single term family is almost certainly the single highest-volume search term for this entire app category. By choosing to never use it anywhere in Oak's discoverable metadata, **Oak is giving up the top-of-funnel "pokemon team builder" / "pokedex" search traffic that every competitor captures.** This isn't an oversight — it's the explicit, agreed tradeoff for maximizing App Store review/approval odds over raw discoverability. The keyword strategy below is built entirely around the generic mechanic vocabulary Oak can win on instead (team building, battle math, format-specific reasoning), which doubles as Oak's genuine differentiator vs. static dex apps.

## Competitor analysis

| App | What they do with the trademark | What to mirror | What NOT to mirror |
|---|---|---|---|
| **ProDex - Complete Game Guide** (id 1485409731) | Avoids "Pokémon"/"Pokédex" in App Name and Subtitle ("Dex, TeamBuilder, Catch, Shiny"); names "Pokémon"/Nintendo/Game Freak only inside one disclaimer paragraph in the Description. | This exact pattern — trademark confined to one disclaimer block. Their comma-separated subtitle style (short generic nouns) is a good model for Oak's own subtitle. | Their disclaimer also covers "fair use of copyrighted images" — Oak ships no Nintendo artwork/sprites at all, so that clause doesn't apply and should be dropped, not copied. |
| **Prokedex** | Uses "Pokémon" liberally throughout its description and tagline ("Most complete Pokédex app for Android and iOS"), not confined to a disclaimer. | Their disclaimer wording is thorough (names Nintendo, GAME FREAK, The Pokémon Company, copyright years) — useful as a wording reference for Oak's own (trimmed) disclaimer. | Their liberal in-body use of "Pokémon" — Oak's agreed policy is stricter (disclaimer-only). |
| **Bulbapedia - Wiki for Pokémon** (id 1242159382) | Uses "Pokémon" directly in the App Name itself — the most permissive end of what's currently live and approved, presumably leaning on its standing as an established community wiki brand. | Nothing directly — it's the example of how far competitors go that Oak is deliberately not matching. | App-Name-level trademark use. Cited here only to calibrate how conservative Oak's choice is relative to the live competitive set. |

## Tier 1 — must win (high relevance, core differentiators)

| Term | Rationale | Competition |
|---|---|---|
| team builder | Oak's most concrete, marketable feature (full competitive sets, Showdown-format import/export) | Medium — every competitor has some team-builder feature, but few pair it with a chat agent |
| battle calculator | Matches Oak's damage-calc/battle-math reasoning; also literally Oak's subtitle phrasing | Medium |
| type chart | Common, well-understood search term for the type-matchup feature (artifact viewer) | Medium-heavy (generic reference apps win here too) |
| moveset | Direct match to the learnset/moveset-filtering capability | Light-medium |
| tera | Current-generation mechanic Oak's team builder and reasoning fully support; lower competition since it's recent | Light |

## Tier 2 — worth fighting for (long-tail, indie-winnable)

| Term | Rationale |
|---|---|
| damage calculator | Long-tail combo of Tier 1 "battle calculator" + "damage" keyword; precise intent, light competition once de-branded from the trademark term |
| ev iv calculator | Specific competitive-breeding/stat-optimization search; Oak's team builder covers EVs/IVs explicitly |
| showdown import | Captures users who already have a team string from a calculator/friend and want to bring it in — a real, frequent workflow in Oak's team builder |
| regulation format | Matches the Champions-style format toggle — a feature most static dex apps don't have at all |
| reasoning chat | Oak's actual category-defining differentiator (cited reasoning vs. plain lookup); low competition because almost no competitor frames itself this way |
| ai battle assistant | Captures the growing "AI app" search behavior without naming the franchise |
| trainer assistant | Generic but on-theme long-tail combo with "ai"/"battle" |
| stat calculator | Broader net than "ev iv calculator," catches base-stat and superlative ("fastest") queries Oak answers |

## Tier 3 — cede (don't waste field space)

| Term | Why cede |
|---|---|
| dex / pokedex-style terms | Explicitly excluded by the trademark policy — see tradeoff note above |
| creature collector | Generic genre term with heavy competition from non-Pokémon monster-collecting games; too broad to win |
| game guide | Dominated by large multi-title guide apps (incl. ProDex's own category framing); not a fight worth picking |

## iOS Keyword field — literal string (97 / 100 chars)

```
builder,type,chart,moveset,damage,stat,ev,iv,tera,regulation,showdown,import,trainer,reasoning,ai
```

Notes on construction:
- No spaces after commas (each saved character matters at this budget).
- Singular forms only (`stat` not `stats`, `moveset` not `movesets`) — Apple matches plurals automatically.
- Deliberately omits every word already indexed via the App Name (`Oak`) or Subtitle (`Team Chat, Battle Calculator` → covers "team," "chat," "battle," "calculator") so no field space is wasted on duplication.
- Adjacent placement of `builder`/`type`/`chart`/`moveset` lets Apple's auto-combination produce useful compound matches ("type chart", "builder type") alongside the cross-field combination with "team" (subtitle) → "team builder".
- `showdown` refers to the third-party Showdown battle-simulator text format (a Smogon-community convention, not a Nintendo trademark) — kept because it's the literal name of the import/export format Oak's team builder supports, not because it's exempt from the "no Pokémon trademark" policy (it's simply a different mark entirely).

## Google Play guidance

Not applicable — Oak's iOS app has no Android counterpart in this repo, so there is no Google Play listing to optimize.
