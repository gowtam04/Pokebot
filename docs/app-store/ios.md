# Oak — iOS App Store Listing

Category: **Reference**. Age rating: **4+**. Price: **Free, no in-app purchases.**

## App Name (30 chars max)

```
Oak – AI Battle Coach
```
**21 / 30 chars.** The bare name "Oak" was unavailable in the App Store, so a short descriptor was appended to make the store name unique. The bundle id (`us.optiwise.oak`), the `oak.optiwise.us` domain, and the in-app "Oak" assistant persona are all unchanged — only the *store display name* carries the descriptor, so no code change is required. "AI Battle Coach" also pulls double duty for ASO: it puts `ai`, `battle`, and `coach` into Apple's most heavily-weighted field (the bare "Oak" wasted it on 3 characters) and names Oak's category-defining wedge — it *coaches*: it reasons and explains, rather than just computing like the manual-tool competitors (ChampDex, VGC Helper). Separator is an en dash; swap for `:` or `|` to taste (all stay ≤30). (App Store name availability is only confirmed at name-reservation time in App Store Connect — "Battle Coach" is a generic phrase, so collision risk is low.)

## Subtitle (30 chars max)

```
Team Builder & Calculator
```
**25 / 30 chars.** Reworked now that "AI" and "Battle" live in the App Name — the subtitle no longer repeats them and instead carries the next tier of high-intent terms. It locks the exact phrase "team builder" (a Tier-1 search term) into a heavily-weighted field, and "Calculator" combines cross-field with the App Name's "Battle" → "battle calculator" (Tier 1) and with the keyword "damage" → "damage calculator" (Tier 2). Zero trademarked words. (5 chars of headroom remain if you later want to append a term.)

## Promotional Text (170 chars max, updatable without resubmission)

```
New: a one-tap format toggle scopes your whole team chat and battle calculator to the current competitive regulation ruleset — no separate app, no manual rule lookups.
```
**167 / 170 chars.**

## Description (4000 chars max)

```
Oak is your AI battle coach — a chat companion for building and reasoning about competitive creature-battle teams. Ask any question about your roster and get a reasoned, cited answer, not a stat dump.

Most reference apps hand you raw numbers and leave the thinking to you. Oak reasons on top of the data: every answer comes with its reasoning, the sources it's grounded in, and explicit "this part is inferred" flags whenever the data doesn't fully cover your question — so you always know what's fact and what's a best guess.

WHAT YOU CAN DO

• Build full competitive teams — set species, ability, held item, all four moves, nature, EVs, IVs, and Tera type for every slot on your roster.
• Import and export teams using the popular Showdown text format — bring a team in from a calculator or a friend, or take yours out to use elsewhere.
• Ask anything in plain English and get the direct answer plus the reasoning behind it, with cited sources and clear flags when something is uncertain or inferred.
• Switch your entire chat and team builder to the official competitive regulation format with one toggle — no separate app, no manual rule lookups.
• Attach a photo or screenshot — a team sheet, a card, an in-game moment — and ask Oak about it directly.
• Drill into any move, ability, type matchup, or damage calculation in a dedicated detail view without losing your place in the conversation.
• Start chatting instantly as a guest, no account required. Sign in with a one-time email code (no password) when you want your chats and teams saved and synced across devices.

Oak is free to use, with no in-app purchases.

ABOUT THIS APP

Oak is an independent, unofficial fan project. It is not affiliated with, endorsed by, sponsored by, or otherwise connected to Nintendo, Game Freak, Creatures Inc., or The Pokémon Company. Game and character names referenced by the underlying data are the property of their respective owners and are mentioned solely to describe what Oak's chat and team builder are compatible with.

Questions or feedback? Reach us at oak.optiwise.us/support.
```
**2,085 / 4000 chars** (well within budget).

## Keywords (100 chars max, hidden, comma-separated, no spaces)

```
type,chart,weakness,coverage,moveset,damage,ev,iv,tera,speed,regulation,showdown,import,reasoning
```
**97 / 100 chars.** Rebuilt for the new App Name/Subtitle: dropped `builder` (now in the Subtitle), `ai` (now in the App Name), and the two lowest-value terms `stat` and `trainer`; added `weakness`, `coverage`, and `speed` — high-intent terms matching the type-matchup and speed-tier features the direct competitors lead with. Full rationale + the deliberately-ceded `vgc` note in `aso-keywords.md`.

## What's New (this release)

```
Welcome to Oak for iPhone — chat-based team reasoning, a full competitive team builder with Showdown-format import/export, and one-tap regulation-format switching, right in your pocket. Sign in with an email code to sync your chats and teams across devices.
```
**257 / 4000 chars** (kept tight since this is a first release, not a changelog).

## Submission checklist (not produced by this listing — flagged for the user)

- **Privacy Policy URL** — `AccountView` already links to `oak.optiwise.us/privacy`, but no policy exists yet. Apple requires a live URL at submission; this must go live first.
- **Support URL** — same placeholder issue for `oak.optiwise.us/support`, referenced above in the Description's contact line.
- **App Icon** — still a placeholder in `Assets.xcassets/AppIcon.appiconset`; needs a final design before screenshots/marketing assets that show the icon can be finalized.
