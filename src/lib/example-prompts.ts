/**
 * Starter prompts for the fresh-session empty state (ChatThread). A large,
 * curated pool spanning *all* of Oak's capabilities so that, across repeated
 * visits, a user discovers the full range of help on offer — filters, learnsets,
 * mechanics reasoning, type matchups, stat/damage math, lookups, ability/item
 * effects, evolution, and conditional inference.
 *
 * Phrasing is deliberately **mode-agnostic** (valid in both Standard and
 * Champions) and avoids out-of-scope topics (egg moves, catch locations) so a
 * chip never leads to a dead-end decline. Drawn from the eval golden cases and
 * few-shot examples. Categories below are for authoring only — the array is flat.
 */
export const STARTER_PROMPTS: string[] = [
  // Lookups / profiles
  "Show me Garchomp",
  "What are Dragapult's abilities?",
  "Tell me about Iron Valiant",
  "Gholdengo's stats and typing",
  // Evolution / forms
  "How does Eevee evolve?",
  "What forms does Tauros have?",
  "How do I evolve Applin?",
  // Type matchups
  "What's strong against Dragapult?",
  "What beats Water types?",
  "Is Ground super effective against Flying?",
  "What is Gholdengo weak to?",
  "Best counters to Fairy types",
  // Learnset filters
  "Pokémon that learn Trick Room and Will-O-Wisp",
  "What can learn Spikes?",
  "Who gets both Stealth Rock and Recover?",
  "Pokémon that learn Knock Off and Roost",
  // Compound team-building filters
  "Fastest Fire types",
  "Fire types that learn Will-O-Wisp with Flash Fire",
  "Dragon types with base Speed over 100",
  "Bulkiest Water types",
  "Steel types that can set Stealth Rock",
  // Superlatives
  "Fastest Pokémon in the game",
  "Highest base stat total",
  "Pokémon with base Attack over 130",
  // Move mechanics
  "Does Fake Out work on Farigiraf?",
  "Does Earthquake hit everyone in doubles?",
  "Does Prankster work on Dark types?",
  "How does Fake Out's priority work?",
  // Ability / item effects
  "What does Leftovers do?",
  "What does Armor Tail do?",
  "What does Protosynthesis do?",
  "What item does Snorlax hold in the wild?",
  // Stat math
  "Garchomp's Speed at level 50 with max Speed and Jolly",
  "How much HP does a fully invested Blissey have?",
  // Damage calc
  "Can Garchomp OHKO Gholdengo with Earthquake?",
  "Damage from a 120 BP STAB super-effective hit vs 95 Defense",
  // Conditional inference
  "Can Levitate dodge Earthquake?",
  "Which Pokémon are immune to Ground?",
];

/**
 * Sample `count` distinct prompts from {@link STARTER_PROMPTS} at random, via a
 * partial Fisher–Yates shuffle (sampling without replacement). Uses
 * `Math.random()`, so call it **client-side only** (e.g. inside a `useEffect`)
 * to keep server/client renders byte-stable and avoid a hydration mismatch.
 */
export function pickRandomPrompts(count = 4): string[] {
  const pool = [...STARTER_PROMPTS];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
