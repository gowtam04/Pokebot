/**
 * Tool-layer barrel (Phase 4 assembly seam).
 *
 * Establishes the contract every parallel tool author targets and the surface
 * the agent runtime consumes:
 *
 *   - `tools: ToolDef[]`  — the 11 tool definitions in T1..T11 order (tools.md),
 *     fed to the Anthropic SDK (name + description + generated `inputSchema`).
 *   - `dispatch(name, args, ctx)` — name -> `run(args, ctx)` lookup used by the
 *     loop in src/agent/runtime.ts.
 *   - `submitAnswerSchema` — re-export of the OakAnswer Zod schema (the
 *     single source of truth in schemas.ts) for the runtime's payload validation
 *     (design.md tool-layer export surface).
 *
 * EACH TOOL FILE MUST EXPORT exactly one `ToolDef` under the named const below
 * (do not change these names — this barrel imports them by name):
 *
 *   resolve-entity.ts        -> export const resolveEntityTool: ToolDef
 *   query-pokedex.ts         -> export const queryPokedexTool: ToolDef
 *   get-pokemon.ts           -> export const getPokemonTool: ToolDef
 *   get-move.ts              -> export const getMoveTool: ToolDef
 *   get-ability.ts           -> export const getAbilityTool: ToolDef
 *   get-type-matchups.ts     -> export const getTypeMatchupsTool: ToolDef
 *   get-evolution-chain.ts   -> export const getEvolutionChainTool: ToolDef
 *   get-item.ts              -> export const getItemTool: ToolDef
 *   compute-stat.tool.ts     -> export const computeStatTool: ToolDef
 *   estimate-damage.tool.ts  -> export const estimateDamageTool: ToolDef
 *   submit-answer.ts         -> export const submitAnswerTool: ToolDef
 *
 * Each `ToolDef` must set:
 *   - `name`        -> the EXACT tools.md T1..T11 slug (the model depends on it),
 *   - `description` -> the tools.md "Description (for the model)",
 *   - `inputSchema` -> toJsonSchema(<that tool's input Zod schema from schemas.ts>),
 *   - `run(args, ctx)` -> parse `args` with the tool's input Zod schema, do the
 *     read/compute, and return the tools.md output shape. NEVER throw for an
 *     in-domain failure: return the documented structured error/miss shape
 *     ({ found:false, suggestions }, { error:"upstream_unavailable" },
 *     { error:"index_unavailable" }, { unresolved:[...] }, { error:"invalid_input", detail }).
 *     Only genuine transport/programming faults may throw.
 */

import type { ToolDef, ToolDispatch } from "@/agent/types";
import { oakAnswerSchema } from "@/agent/schemas";

import { resolveEntityTool } from "./resolve-entity";
import { queryPokedexTool } from "./query-pokedex";
import { getPokemonTool } from "./get-pokemon";
import { getMoveTool } from "./get-move";
import { getAbilityTool } from "./get-ability";
import { getTypeMatchupsTool } from "./get-type-matchups";
import { getEvolutionChainTool } from "./get-evolution-chain";
import { getItemTool } from "./get-item";
import { computeStatTool } from "./compute-stat.tool";
import { estimateDamageTool } from "./estimate-damage.tool";
import { submitAnswerTool } from "./submit-answer";
import { getTeamTool } from "./get-team.tool";
import { saveTeamTool } from "./save-team.tool";
import { getEncountersTool } from "./get-encounters";
import { getUsageStatsTool } from "./get-usage-stats.tool";
import { listTeamsTool } from "./list-teams.tool";

/**
 * The 16 tools, in T1..T16 order. T1..T11 are the fixed agent-design contract;
 * T12 (`get_team`) loads a saved team by id and T13 (`save_team`) persists one
 * (team-builder, TEAM-AD-1 / TEAM-AD-7, reconciled into docs/agent-design); T14
 * (`get_encounters`) adds PokeAPI catch-location data (standard mode only); T15
 * (`get_usage_stats`) adds live championsbattledata.com competitive usage
 * (champions mode only); T16 (`list_teams`) lists the user's saved teams so the
 * model can resolve a by-name reference. All appended after T11 so the existing
 * T1..T11 order — and thus most of the cached prefix — is unchanged. The list is
 * sent byte-identical for both modes; each mode-gated tool self-gates on
 * `ctx.mode`.
 */
export const tools: ToolDef[] = [
  resolveEntityTool,
  queryPokedexTool,
  getPokemonTool,
  getMoveTool,
  getAbilityTool,
  getTypeMatchupsTool,
  getEvolutionChainTool,
  getItemTool,
  computeStatTool,
  estimateDamageTool,
  submitAnswerTool,
  getTeamTool,
  saveTeamTool,
  getEncountersTool,
  getUsageStatsTool,
  listTeamsTool,
];

/** name -> ToolDef lookup, built once at module load. */
const toolsByName: Map<string, ToolDef> = new Map(
  tools.map((tool) => [tool.name, tool]),
);

/**
 * Dispatch a tool call by name. The runtime maps each `tool_use` block to this.
 *
 * An unknown tool name is returned as an in-domain structured error so the loop
 * can continue (the fixed tool list means this only happens on a model
 * hallucination); it does not throw.
 */
export const dispatch: ToolDispatch = (name, args, ctx) => {
  const tool = toolsByName.get(name);
  if (!tool) {
    return Promise.resolve({ error: "unknown_tool", detail: name });
  }
  return tool.run(args, ctx);
};

/**
 * The OakAnswer Zod schema, re-exported under the design.md name for the
 * runtime's submit_answer payload validation. NOT a redefinition — single source
 * of truth remains src/agent/schemas.ts.
 */
export const submitAnswerSchema = oakAnswerSchema;
