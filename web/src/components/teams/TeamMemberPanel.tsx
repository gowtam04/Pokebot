/**
 * TeamMemberPanel — the editor for ONE team slot (set).
 *
 * Renders every competitive field of a {@link TeamMember} as a controlled input
 * (species / ability / item / 4 moves / nature / tera type / level / EV + IV
 * spreads, plus the cosmetic nickname) and emits an updated member on each edit.
 * Slugs are stored, `null` = empty (BR-T4); a partial member is valid.
 *
 * When the species' base stats are supplied (`baseStats`, fetched by the page
 * from the entity index), the panel shows LIVE final stats computed by the PURE
 * `compute-stat` formula — the exact in-game per-step flooring, including the
 * nature ±10% — so the user sees the spread react as they type EVs/IVs/level.
 * No base stats ⇒ the live column is simply omitted (the field is still fully
 * editable). Per-slot validity warnings (already filtered to this slot) render
 * inline via {@link TeamWarnings}.
 *
 * Reorder (up/down) and remove are parent-driven callbacks; the panel never
 * mutates the team array itself.
 */

import { computeStat } from "@/agent/formulas/compute-stat";
import type { StatSpread, TeamMember } from "@/data/teams/team-schema";
import type { TeamWarning } from "@/lib/api/teams-client";
import TeamWarnings from "./TeamWarnings";

/** Base-stat spread as exposed by the entity index (`base_stats`). */
export interface MemberBaseStats {
  hp: number;
  attack: number;
  defense: number;
  special_attack: number;
  special_defense: number;
  speed: number;
}

type SpreadKey = keyof StatSpread; // hp | atk | def | spa | spd | spe

interface StatRow {
  spread: SpreadKey;
  base: keyof MemberBaseStats;
  label: string;
  isHp: boolean;
}

const STAT_ROWS: StatRow[] = [
  { spread: "hp", base: "hp", label: "HP", isHp: true },
  { spread: "atk", base: "attack", label: "Atk", isHp: false },
  { spread: "def", base: "defense", label: "Def", isHp: false },
  { spread: "spa", base: "special_attack", label: "SpA", isHp: false },
  { spread: "spd", base: "special_defense", label: "SpD", isHp: false },
  { spread: "spe", base: "speed", label: "Spe", isHp: false },
];

/** Nature → (boosted, hindered) stat. Neutral natures are absent from the map. */
const NATURES: Record<string, { plus?: SpreadKey; minus?: SpreadKey }> = {
  lonely: { plus: "atk", minus: "def" },
  brave: { plus: "atk", minus: "spe" },
  adamant: { plus: "atk", minus: "spa" },
  naughty: { plus: "atk", minus: "spd" },
  bold: { plus: "def", minus: "atk" },
  relaxed: { plus: "def", minus: "spe" },
  impish: { plus: "def", minus: "spa" },
  lax: { plus: "def", minus: "spd" },
  timid: { plus: "spe", minus: "atk" },
  hasty: { plus: "spe", minus: "def" },
  jolly: { plus: "spe", minus: "spa" },
  naive: { plus: "spe", minus: "spd" },
  modest: { plus: "spa", minus: "atk" },
  mild: { plus: "spa", minus: "def" },
  quiet: { plus: "spa", minus: "spe" },
  rash: { plus: "spa", minus: "spd" },
  calm: { plus: "spd", minus: "atk" },
  gentle: { plus: "spd", minus: "def" },
  sassy: { plus: "spd", minus: "spe" },
  careful: { plus: "spd", minus: "spa" },
  // hardy / docile / serious / bashful / quirky are neutral (no entry).
};

function natureEffectFor(
  nature: string | null,
  stat: SpreadKey,
): "boosted" | "neutral" | "hindered" {
  if (!nature) return "neutral";
  const mod = NATURES[nature.toLowerCase()];
  if (!mod) return "neutral";
  if (mod.plus === stat) return "boosted";
  if (mod.minus === stat) return "hindered";
  return "neutral";
}

/** Compute one live final stat, or `null` if inputs are out of formula range. */
function liveStat(
  row: StatRow,
  member: TeamMember,
  base: MemberBaseStats,
): number | null {
  const result = computeStat({
    base_stat: base[row.base],
    is_hp: row.isHp,
    iv: member.ivs[row.spread],
    ev: member.evs[row.spread],
    level: member.level,
    nature_effect: row.isHp
      ? "neutral"
      : natureEffectFor(member.nature, row.spread),
  });
  return "value" in result ? result.value : null;
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export interface TeamMemberPanelProps {
  member: TeamMember;
  /** 0-based slot index (for ids + labels). */
  slot: number;
  /** Warnings already filtered to this slot. */
  warnings: TeamWarning[];
  /** Species base stats for the live-stat column; omit ⇒ no live column. */
  baseStats?: MemberBaseStats;
  onChange: (next: TeamMember) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export default function TeamMemberPanel({
  member,
  slot,
  warnings,
  baseStats,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp = false,
  canMoveDown = false,
}: TeamMemberPanelProps) {
  const id = (suffix: string) => `member-${slot}-${suffix}`;

  const set = (patch: Partial<TeamMember>) => onChange({ ...member, ...patch });

  const setSpread = (kind: "evs" | "ivs", key: SpreadKey, raw: string) => {
    onChange({
      ...member,
      [kind]: { ...member[kind], [key]: clampInt(raw, 0, 255) },
    });
  };

  // Moves are edited as four boxes; emit the non-empty slugs in order.
  const moveInputs = [0, 1, 2, 3].map((i) => member.moves[i] ?? "");
  const setMove = (index: number, value: string) => {
    const next = [...moveInputs];
    next[index] = value;
    onChange({ ...member, moves: next.map((m) => m.trim()).filter(Boolean) });
  };

  return (
    <div className="team-member-panel" data-testid={id("panel")}>
      <div className="team-member-panel__header">
        <span className="team-member-panel__slot-label">Slot {slot + 1}</span>
        <div className="team-member-panel__actions">
          <button
            type="button"
            data-testid={id("up")}
            aria-label={`Move slot ${slot + 1} up`}
            onClick={onMoveUp}
            disabled={!canMoveUp}
          >
            ↑
          </button>
          <button
            type="button"
            data-testid={id("down")}
            aria-label={`Move slot ${slot + 1} down`}
            onClick={onMoveDown}
            disabled={!canMoveDown}
          >
            ↓
          </button>
          <button
            type="button"
            data-testid={id("remove")}
            aria-label={`Remove slot ${slot + 1}`}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      </div>

      <Field label="Nickname" htmlFor={id("nickname")}>
        <input
          id={id("nickname")}
          data-testid={id("nickname")}
          value={member.nickname ?? ""}
          onChange={(e) => set({ nickname: e.target.value || null })}
        />
      </Field>

      <Field label="Species" htmlFor={id("species")}>
        <input
          id={id("species")}
          data-testid={id("species")}
          value={member.species ?? ""}
          placeholder="species slug"
          onChange={(e) => set({ species: e.target.value || null })}
        />
      </Field>

      <Field label="Ability" htmlFor={id("ability")}>
        <input
          id={id("ability")}
          data-testid={id("ability")}
          value={member.ability ?? ""}
          onChange={(e) => set({ ability: e.target.value || null })}
        />
      </Field>

      <Field label="Item" htmlFor={id("item")}>
        <input
          id={id("item")}
          data-testid={id("item")}
          value={member.item ?? ""}
          onChange={(e) => set({ item: e.target.value || null })}
        />
      </Field>

      <fieldset className="team-member-panel__moves" data-testid={id("moves")}>
        <legend className="team-member-panel__moves-legend">Moves</legend>
        <div className="team-member-panel__moves-grid">
          {[0, 1, 2, 3].map((i) => (
            <input
              key={i}
              data-testid={id(`move-${i}`)}
              aria-label={`Move ${i + 1}`}
              value={moveInputs[i]}
              onChange={(e) => setMove(i, e.target.value)}
            />
          ))}
        </div>
      </fieldset>

      <div className="team-member-panel__meta-grid">
        <Field label="Nature" htmlFor={id("nature")}>
          <input
            id={id("nature")}
            data-testid={id("nature")}
            value={member.nature ?? ""}
            onChange={(e) => set({ nature: e.target.value || null })}
          />
        </Field>
        <Field label="Tera type" htmlFor={id("tera")}>
          <input
            id={id("tera")}
            data-testid={id("tera")}
            value={member.tera_type ?? ""}
            onChange={(e) => set({ tera_type: e.target.value || null })}
          />
        </Field>
        <Field label="Level" htmlFor={id("level")}>
          <input
            id={id("level")}
            data-testid={id("level")}
            type="number"
            min={1}
            max={100}
            value={member.level}
            onChange={(e) => set({ level: clampInt(e.target.value, 1, 100) })}
          />
        </Field>
      </div>

      <table className="team-member-panel__stats" data-testid={id("stats")}>
        <thead>
          <tr className="team-member-panel__stats-head-row">
            <th className="team-member-panel__col-head">Stat</th>
            <th>EV</th>
            <th>IV</th>
            {baseStats && <th data-testid={id("stats-live-head")}>Final</th>}
          </tr>
        </thead>
        <tbody>
          {STAT_ROWS.map((row) => {
            const live = baseStats ? liveStat(row, member, baseStats) : null;
            return (
              <tr key={row.spread}>
                <td className="team-member-panel__stat-name">{row.label}</td>
                <td>
                  <input
                    data-testid={id(`ev-${row.spread}`)}
                    aria-label={`${row.label} EV`}
                    type="number"
                    min={0}
                    max={255}
                    value={member.evs[row.spread]}
                    onChange={(e) =>
                      setSpread("evs", row.spread, e.target.value)
                    }
                    className="team-member-panel__spread-input"
                  />
                </td>
                <td>
                  <input
                    data-testid={id(`iv-${row.spread}`)}
                    aria-label={`${row.label} IV`}
                    type="number"
                    min={0}
                    max={31}
                    value={member.ivs[row.spread]}
                    onChange={(e) =>
                      setSpread("ivs", row.spread, e.target.value)
                    }
                    className="team-member-panel__spread-input"
                  />
                </td>
                {baseStats && (
                  <td
                    data-testid={id(`stat-${row.spread}`)}
                    className="team-member-panel__stat-final"
                  >
                    {live ?? "—"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      <TeamWarnings
        warnings={warnings}
        testid={id("warnings")}
        title="Issues"
      />
    </div>
  );
}

/** A labeled wrapper around a single control. */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="team-member-panel__field">
      {label}
      {children}
    </label>
  );
}
