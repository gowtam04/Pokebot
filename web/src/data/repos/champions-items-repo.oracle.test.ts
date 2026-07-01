/**
 * Oracle tests for the operator-curated Champions item allowlist
 * (`champions-items-repo.ts`) and its three read-time consumers.
 *
 * Harness (mirrors admin-content-repo.oracle.test.ts): the repo's admin reads
 * and `resolve-index` read the `@/data/db` SINGLETON, so we migrate an isolated
 * Postgres schema (seed "none"), `installAsSingleton(fix)` BEFORE the first
 * dynamic import of the repo/tools, neutralize `server-only`, then seed a small
 * Champions item universe directly. Everything resolves to `fix.db` (the
 * singleton and every injected handle point at the same schema).
 *
 * What it proves end-to-end:
 *   - loadChampionsItemExclusions reflects the table (empty ⇒ nothing excluded).
 *   - listChampionsItemsForAdmin returns the full item universe with `available`
 *     = NOT excluded, sorted by display name ("pre-select all").
 *   - setChampionsItemAvailability(false) excludes / (true) re-includes, and the
 *     three consumers agree:
 *       · resolve_entity (champions) no longer surfaces the excluded item,
 *       · validate_team flags it `item_illegal`,
 *       · get_item returns the not-found shape.
 *   - standard (scarlet-violet) is never affected.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// champions-items-repo.ts / db.ts `import "server-only"` (throws under node).
vi.mock("server-only", () => ({}));

import {
  createPgSchema,
  installAsSingleton,
  type PgFixture,
} from "../../../test/support/pg";
import { champions_item_exclusion, reference_cache, searchable_names } from "@/data/schema";
import type { AgentContext } from "@/agent/types";
import type { StatSpread, TeamMember } from "@/data/teams/team-schema";

const CH = "champions" as const;
const SV = "scarlet-violet" as const;

type Repo = typeof import("./champions-items-repo");
type ResolveMod = typeof import("./resolve-index");
type ValidateMod = typeof import("@/server/teams/validate-team");
type GetItemMod = typeof import("@/agent/tools/get-item");

let fix: PgFixture;
let repo: Repo;
let resolveMod: ResolveMod;
let validateMod: ValidateMod;
let getItemMod: GetItemMod;

const ZERO_EVS: StatSpread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const PERFECT_IVS: StatSpread = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

/** A member holding `item` (species/moves left blank — item legality is independent). */
function memberWithItem(item: string): TeamMember {
  return {
    species: null,
    ability: null,
    item,
    moves: [],
    nature: null,
    evs: { ...ZERO_EVS },
    ivs: { ...PERFECT_IVS },
    tera_type: null,
    level: 50,
  };
}

/** A champions get_item ctx — everything routes to fix.db via the singleton. */
function champCtx(): AgentContext {
  return { mode: "champions", db: fix.db } as unknown as AgentContext;
}

beforeAll(async () => {
  fix = await createPgSchema({ seed: "none" });
  await installAsSingleton(fix);

  await fix.db.insert(searchable_names).values([
    { format: CH, kind: "item", slug: "assault-vest", display_name: "Assault-Vest" },
    { format: CH, kind: "item", slug: "choice-band", display_name: "Choice-Band" },
    { format: CH, kind: "item", slug: "leftovers", display_name: "Leftovers" },
    // a non-item + a standard-format item, to prove the filter is item + champions only.
    { format: CH, kind: "move", slug: "protect", display_name: "Protect" },
    { format: SV, kind: "item", slug: "assault-vest", display_name: "Assault-Vest" },
  ]);
  await fix.db.insert(reference_cache).values([
    {
      format: CH,
      resource_key: "item/assault-vest",
      resource_kind: "item",
      payload: JSON.stringify({
        found: true,
        display_name: "Assault Vest",
        effect_short: "Boosts Sp. Def; bars status moves.",
        effect_full: "Raises Special Defense by 50% but prevents the use of status moves.",
      }),
      endpoint_url: "test",
      fetched_at: 0,
    },
  ]);

  repo = await import("./champions-items-repo");
  resolveMod = await import("./resolve-index");
  validateMod = await import("@/server/teams/validate-team");
  getItemMod = await import("@/agent/tools/get-item");
});

afterAll(async () => {
  await fix.cleanup();
});

// Each test starts from a clean (empty) exclusion table + a fresh champions index.
beforeEach(async () => {
  await fix.db.delete(champions_item_exclusion);
  resolveMod.resetResolveIndex();
});

describe("champions-items-repo", () => {
  it("loadChampionsItemExclusions is empty when nothing is excluded", async () => {
    const excluded = await repo.loadChampionsItemExclusions({ db: fix.db });
    expect(excluded.size).toBe(0);
  });

  it("listChampionsItemsForAdmin returns every item available, sorted by name", async () => {
    const items = await repo.listChampionsItemsForAdmin();
    expect(items.map((i) => i.slug)).toEqual([
      "assault-vest",
      "choice-band",
      "leftovers",
    ]);
    expect(items.every((i) => i.available)).toBe(true);
  });

  it("setChampionsItemAvailability(false) records an exclusion; (true) clears it", async () => {
    await repo.setChampionsItemAvailability("assault-vest", false, "admin@example.com");
    let excluded = await repo.loadChampionsItemExclusions({ db: fix.db });
    expect([...excluded]).toEqual(["assault-vest"]);
    const items = await repo.listChampionsItemsForAdmin();
    expect(items.find((i) => i.slug === "assault-vest")?.available).toBe(false);
    expect(items.find((i) => i.slug === "leftovers")?.available).toBe(true);

    await repo.setChampionsItemAvailability("assault-vest", true, null);
    excluded = await repo.loadChampionsItemExclusions({ db: fix.db });
    expect(excluded.size).toBe(0);
  });

  it("excluding is idempotent (no duplicate-key error on a repeat)", async () => {
    await repo.setChampionsItemAvailability("choice-band", false, null);
    await repo.setChampionsItemAvailability("choice-band", false, null);
    const excluded = await repo.loadChampionsItemExclusions({ db: fix.db });
    expect([...excluded]).toEqual(["choice-band"]);
  });

  it("setAllChampionsItemsAvailability(false) excludes every item; (true) clears all", async () => {
    const deselect = await repo.setAllChampionsItemsAvailability(false, "admin@example.com");
    expect(deselect.excludedCount).toBe(3);
    const afterDeselect = await repo.listChampionsItemsForAdmin();
    expect(afterDeselect.every((i) => !i.available)).toBe(true);

    await repo.setAllChampionsItemsAvailability(true, null);
    const afterSelect = await repo.listChampionsItemsForAdmin();
    expect(afterSelect.every((i) => i.available)).toBe(true);
    expect((await repo.loadChampionsItemExclusions({ db: fix.db })).size).toBe(0);
  });

  it("Deselect all then re-select a valid item leaves only it available", async () => {
    await repo.setAllChampionsItemsAvailability(false, null);
    await repo.setChampionsItemAvailability("leftovers", true, null);
    const items = await repo.listChampionsItemsForAdmin();
    expect(items.filter((i) => i.available).map((i) => i.slug)).toEqual(["leftovers"]);
  });
});

describe("resolve_entity honours the champions exclusion set", () => {
  it("does not resolve an excluded champions item, still resolves others", async () => {
    // Baseline: assault-vest resolves in champions.
    const before = await resolveMod.resolveEntity("Assault Vest", "item", 5, CH);
    expect(before.matches.some((m) => m.slug === "assault-vest")).toBe(true);

    await repo.setChampionsItemAvailability("assault-vest", false, null);

    const after = await resolveMod.resolveEntity("Assault Vest", "item", 5, CH);
    expect(after.matches.some((m) => m.slug === "assault-vest")).toBe(false);
    // A non-excluded item is unaffected.
    const other = await resolveMod.resolveEntity("Leftovers", "item", 5, CH);
    expect(other.matches.some((m) => m.slug === "leftovers")).toBe(true);
  });

  it("does NOT filter the same item in standard (scarlet-violet)", async () => {
    await repo.setChampionsItemAvailability("assault-vest", false, null);
    const sv = await resolveMod.resolveEntity("Assault Vest", "item", 5, SV);
    expect(sv.matches.some((m) => m.slug === "assault-vest")).toBe(true);
  });
});

describe("validate_team flags an excluded champions item as illegal", () => {
  it("item_illegal fires only once the item is excluded", async () => {
    const legalBefore = await validateMod.validateTeam(
      [memberWithItem("assault-vest")],
      CH,
      fix.db,
    );
    expect(legalBefore.some((w) => w.code === "item_illegal")).toBe(false);

    await repo.setChampionsItemAvailability("assault-vest", false, null);

    const afterExclusion = await validateMod.validateTeam(
      [memberWithItem("assault-vest")],
      CH,
      fix.db,
    );
    expect(afterExclusion.some((w) => w.code === "item_illegal")).toBe(true);
  });
});

describe("get_item returns not-found for an excluded champions item", () => {
  it("finds an available item and hides it once excluded", async () => {
    const found = (await getItemMod.getItemTool.run(
      { name: "assault-vest" },
      champCtx(),
    )) as { found: boolean };
    expect(found.found).toBe(true);

    await repo.setChampionsItemAvailability("assault-vest", false, null);

    const hidden = (await getItemMod.getItemTool.run(
      { name: "assault-vest" },
      champCtx(),
    )) as { found: boolean; suggestions: string[] };
    expect(hidden.found).toBe(false);
    expect(hidden.suggestions).toEqual([]);
  });
});
