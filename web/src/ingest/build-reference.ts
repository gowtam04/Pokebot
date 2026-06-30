/**
 * build-reference.ts — pre-build reference_cache payloads from @pkmn.
 *
 * @pkmn is local + deterministic, so (unlike the old lazy PokeAPI read-through)
 * every move/ability/type/item/evolution detail is built eagerly per format at
 * ingest. Output payload shapes match the tool contracts in schemas.ts exactly
 * (MoveDetail, AbilityDetail, TypeMatchupsDetail, EvolutionChainDetail,
 * ItemDetail); only the effect TEXT differs from the old PokeAPI prose (it now
 * comes from Showdown desc/shortDesc — an accepted, documented drift).
 */

import type { Format } from "@/data/formats";
import {
  slugFor,
  slugify,
  type FormatSource,
  type PkmnDex,
  type PkmnSpecies,
} from "@/data/pkmn/gen-provider";
import type {
  MoveDetail,
  AbilityDetail,
  TypeMatchupsDetail,
  EvolutionChainDetail,
  ItemDetail,
} from "@/agent/schemas";

export type RefKind =
  | "move"
  | "ability"
  | "type"
  | "evolution"
  | "item"
  | "encounters";

export interface ReferenceRow {
  format: Format;
  /** e.g. "move/fake-out", "type/ground", "evolution-chain/eevee". */
  resource_key: string;
  resource_kind: RefKind;
  /** JSON-serialized normalized detail (the tool output shape). */
  payload: string;
  endpoint_url: string;
  fetched_at: number;
}

/** Citation source label (replaces the old PokeAPI URL; field is optional). */
export const SOURCE_LABEL = "@pkmn/dex (Pokémon Showdown)";

// ---------------------------------------------------------------------------
// Normalizers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * @pkmn spread targets — moves that strike 2+ Pokémon. `allAdjacent` also hits
 * your own ally (the spread reduction applies); `allAdjacentFoes` hits only the
 * opposing side. Damaging spread moves take a per-target damage reduction
 * (default 0.75 in doubles), unless the move overrides it via `spreadModifier`.
 */
const SPREAD_TARGETS = new Set(["allAdjacent", "allAdjacentFoes"]);
const DEFAULT_SPREAD_MODIFIER = 0.75;

export function normalizeMove(m: {
  name: string;
  type: string;
  category: string;
  basePower: number;
  accuracy: number | true;
  pp: number;
  priority: number;
  target: string;
  spreadModifier?: number;
  shortDesc?: string;
  desc?: string;
}): MoveDetail {
  const dc = m.category.toLowerCase();
  const damage_class: "physical" | "special" | "status" =
    dc === "physical" || dc === "special" ? dc : "status";
  const isSpread = SPREAD_TARGETS.has(m.target);
  const spread_modifier_doubles =
    damage_class !== "status" && isSpread
      ? m.spreadModifier ?? DEFAULT_SPREAD_MODIFIER
      : null;
  return {
    found: true,
    display_name: m.name,
    type: slugify(m.type),
    damage_class,
    power: typeof m.basePower === "number" && m.basePower > 0 ? m.basePower : null,
    accuracy: m.accuracy === true ? null : m.accuracy,
    pp: typeof m.pp === "number" ? m.pp : null,
    priority: m.priority ?? 0,
    target: m.target,
    hits_allies: m.target === "allAdjacent",
    spread_modifier_doubles,
    effect_short: m.shortDesc ?? "",
    effect_full: m.desc || m.shortDesc || "",
  };
}

export function normalizeAbility(a: {
  name: string;
  shortDesc?: string;
  desc?: string;
}): AbilityDetail {
  return {
    found: true,
    display_name: a.name,
    effect_short: a.shortDesc ?? "",
    effect_full: a.desc || a.shortDesc || "",
  };
}

export function normalizeItem(i: {
  name: string;
  shortDesc?: string;
  desc?: string;
}): ItemDetail {
  return {
    found: true,
    display_name: i.name,
    effect_short: i.shortDesc ?? "",
    effect_full: i.desc || i.shortDesc || "",
  };
}

/**
 * Build a single type's matchup profile from the @pkmn `damageTaken` maps of the
 * 18 battle types. `damageTaken[attacker]`: 0 neutral, 1 weak (2×), 2 resist
 * (½×), 3 immune (0×) — from the DEFENDER's perspective.
 */
export function normalizeType(
  typeName: string,
  battleTypes: Array<{ name: string; damageTaken: Record<string, number> }>,
): TypeMatchupsDetail {
  const byName = new Map(battleTypes.map((t) => [t.name, t]));
  const self = byName.get(typeName);

  const weak_to: string[] = [];
  const resists: string[] = [];
  const immune_to: string[] = [];
  if (self) {
    for (const atk of battleTypes) {
      const code = self.damageTaken[atk.name];
      if (code === 1) weak_to.push(slugify(atk.name));
      else if (code === 2) resists.push(slugify(atk.name));
      else if (code === 3) immune_to.push(slugify(atk.name));
    }
  }

  const super_effective_against: string[] = [];
  const not_very_effective_against: string[] = [];
  const no_effect_against: string[] = [];
  for (const def of battleTypes) {
    const code = def.damageTaken[typeName];
    if (code === 1) super_effective_against.push(slugify(def.name));
    else if (code === 2) not_very_effective_against.push(slugify(def.name));
    else if (code === 3) no_effect_against.push(slugify(def.name));
  }

  return {
    found: true,
    types: [slugify(typeName)],
    offensive: {
      super_effective_against,
      not_very_effective_against,
      no_effect_against,
    },
    defensive: { weak_to, resists, immune_to },
  };
}

// ---------------------------------------------------------------------------
// Evolution chains
// ---------------------------------------------------------------------------

function mapTrigger(evoType: string | undefined): string {
  switch (evoType) {
    case "trade":
      return "trade";
    case "useItem":
      return "use-item";
    case undefined:
    case "levelMove":
    case "levelFriendship":
    case "levelHold":
    case "levelExtra":
      return "level-up";
    default:
      return evoType ?? "other";
  }
}

type EvoSpecies = PkmnSpecies & {
  prevo?: string;
  evos?: string[];
  evoType?: string;
  evoLevel?: number;
  evoItem?: string;
  evoMove?: string;
  evoCondition?: string;
};

function evoConditions(evolved: EvoSpecies): { trigger: string } & Record<string, unknown> {
  const cond: { trigger: string } & Record<string, unknown> = {
    trigger: mapTrigger(evolved.evoType),
  };
  if (evolved.evoLevel) cond.min_level = evolved.evoLevel;
  if (evolved.evoItem) cond.item = slugify(evolved.evoItem);
  if (evolved.evoMove) cond.known_move = slugify(evolved.evoMove);
  if (evolved.evoCondition) cond.condition = evolved.evoCondition;
  return cond;
}

function rootOf(dex: PkmnDex, s: EvoSpecies): EvoSpecies {
  let cur = s;
  const guard = new Set<string>();
  while (cur.prevo && !guard.has(cur.prevo)) {
    guard.add(cur.prevo);
    const prev = dex.species.get(cur.prevo) as EvoSpecies | null;
    if (!prev || !prev.exists) break;
    cur = prev;
  }
  return cur;
}

/** Build the full evolution chain (edges) that `start` belongs to. */
function buildChain(dex: PkmnDex, start: EvoSpecies): EvolutionChainDetail {
  const root = rootOf(dex, start);
  const chain: EvolutionChainDetail["chain"] = [];
  const queue: EvoSpecies[] = [root];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    for (const evoId of node.evos ?? []) {
      const evolved = dex.species.get(evoId) as EvoSpecies | null;
      if (!evolved || !evolved.exists) continue;
      chain.push({
        from: slugify(node.baseSpecies || node.name),
        to: slugify(evolved.baseSpecies || evolved.name),
        conditions: [evoConditions(evolved)],
      });
      queue.push(evolved);
    }
  }

  return { found: true, chain };
}

// ---------------------------------------------------------------------------
// buildReferenceRows
// ---------------------------------------------------------------------------

/** Build all reference_cache rows for one format from its FormatSource. */
export function buildReferenceRows(
  source: FormatSource,
  now: number,
): ReferenceRow[] {
  const { format, dex } = source;
  const rows: ReferenceRow[] = [];
  const push = (kind: RefKind, key: string, payload: object): void => {
    rows.push({
      format,
      resource_key: key,
      resource_kind: kind,
      payload: JSON.stringify(payload),
      endpoint_url: SOURCE_LABEL,
      fetched_at: now,
    });
  };

  // Moves
  for (const m of source.moves) {
    const slug = slugFor(m.id, m.name);
    push("move", `move/${slug}`, normalizeMove(m));
  }
  // Abilities
  for (const a of source.abilities) {
    const slug = slugFor(a.id, a.name);
    push("ability", `ability/${slug}`, normalizeAbility(a));
  }
  // Items
  for (const i of source.items) {
    const slug = slugFor(i.id, i.name);
    push("item", `item/${slug}`, normalizeItem(i));
  }
  // Types
  const battleTypes = source.types.map((t) => ({
    name: t.name,
    damageTaken: (t as { damageTaken?: Record<string, number> }).damageTaken ?? {},
  }));
  for (const t of source.types) {
    push("type", `type/${slugify(t.name)}`, normalizeType(t.name, battleTypes));
  }
  // Evolution chains — one entry per distinct roster species_name.
  const chainCache = new Map<string, EvolutionChainDetail>(); // root id → chain
  const seenSpecies = new Set<string>();
  for (const s of source.roster) {
    const species_name = slugify(s.baseSpecies || s.name);
    if (seenSpecies.has(species_name)) continue;
    seenSpecies.add(species_name);
    const evoS = s as EvoSpecies;
    const root = rootOf(dex, evoS);
    let chain = chainCache.get(root.id);
    if (!chain) {
      chain = buildChain(dex, evoS);
      chainCache.set(root.id, chain);
    }
    push("evolution", `evolution-chain/${species_name}`, chain);
  }

  return rows;
}
