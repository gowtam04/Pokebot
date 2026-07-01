/**
 * TeamMemberPanel — the focused editor for ONE team slot (set).
 *
 * Renders every competitive field of a {@link TeamMember} (species / ability /
 * item / 4 moves / nature / tera type / level / EV + IV spreads, plus the
 * cosmetic nickname) and emits an updated member on each edit. Slugs are stored,
 * `null` = empty (BR-T4); a partial member is valid. The free-text slug inputs
 * are now {@link EntityPicker} autocompletes — but each still keeps its
 * `data-testid` and commits the typed/selected value verbatim via `onChange`, so
 * a typed slug behaves exactly as before.
 *
 * When the species' base stats are supplied (`baseStats`, looked up by the page
 * from the sprite/entity index) the panel shows LIVE final stats computed by the
 * PURE `compute-stat` formula — the exact in-game per-step flooring, including
 * the nature ±10% — as relative bars that react as the user types EVs/IVs/level.
 * No base stats ⇒ the live bars are simply omitted (fields stay editable). A
 * `spriteRef` adds the sprite header + type badges. Per-slot validity warnings
 * (already filtered to this slot) render inline via {@link TeamWarnings}.
 *
 * Reorder (up/down) and remove are parent-driven callbacks; the panel never
 * mutates the team array itself.
 */

"use client";

import { useEffect, useState } from "react";

import { computeStat } from "@/agent/formulas/compute-stat";
import type { TeamMember } from "@/data/teams/team-schema";
import type { TeamWarning } from "@/lib/api/teams-client";
import type { SpriteRef } from "@/lib/api/sprites-client";
import { type Format } from "@/data/formats";
import { fetchLearnset } from "@/lib/api/learnset-client";
import EntityPicker from "./EntityPicker";
import {
  evBudgetFor,
  NATURE_EFFECTS,
  NATURE_OPTIONS,
  TYPE_OPTIONS,
  type PickerOption,
  type SpreadKey,
} from "./dex-constants";
import { titleizeSlug } from "./display-names";
import TeamWarnings from "./TeamWarnings";

/** Base-stat spread as exposed by the entity/sprite index (`base_stats`). */
export interface MemberBaseStats {
  hp: number;
  attack: number;
  defense: number;
  special_attack: number;
  special_defense: number;
  speed: number;
}

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

function natureEffectFor(
  nature: string | null,
  stat: SpreadKey,
): "boosted" | "neutral" | "hindered" {
  if (!nature) return "neutral";
  const mod = NATURE_EFFECTS[nature.toLowerCase()];
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
  /** Species base stats for the live-stat bars; omit ⇒ no live bars. */
  baseStats?: MemberBaseStats;
  /** Sprite/types for the header chip; omit ⇒ no sprite header. */
  spriteRef?: SpriteRef;
  /** Data scope for the autocomplete pickers. */
  format?: Format;
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
  spriteRef,
  format = "scarlet-violet",
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp = false,
  canMoveDown = false,
}: TeamMemberPanelProps) {
  const id = (suffix: string) => `member-${slot}-${suffix}`;

  // EV / stat-point budget for this format (Champions caps far tighter, no Tera).
  const budget = evBudgetFor(format);

  // Legal movepool for the focused species — the Move pickers offer ONLY these
  // (a species' learnset), not the whole move index. Refetched per species.
  const [movepool, setMovepool] = useState<PickerOption[]>([]);
  useEffect(() => {
    const species = member.species;
    if (!species) {
      setMovepool([]);
      return;
    }
    let active = true;
    void fetchLearnset(format, species).then((moves) => {
      if (active) setMovepool(moves);
    });
    return () => {
      active = false;
    };
  }, [member.species, format]);

  const set = (patch: Partial<TeamMember>) => onChange({ ...member, ...patch });

  const setSpread = (kind: "evs" | "ivs", key: SpreadKey, raw: string) => {
    // EVs clamp to the format ceiling (32 in Champions, 255 warn-but-allow in SV);
    // IVs to the legal 0..31 superset (the input itself caps at 31).
    const max = kind === "evs" ? budget.clampMax : 255;
    onChange({
      ...member,
      [kind]: { ...member[kind], [key]: clampInt(raw, 0, max) },
    });
  };

  // Moves are edited as four boxes; emit the non-empty slugs in order.
  const moveInputs = [0, 1, 2, 3].map((i) => member.moves[i] ?? "");
  const setMove = (index: number, value: string) => {
    const next = [...moveInputs];
    next[index] = value;
    onChange({ ...member, moves: next.map((m) => m.trim()).filter(Boolean) });
  };

  // Live stats + a shared max so the bars are relative to this set's spread.
  const lives = STAT_ROWS.map((row) =>
    baseStats ? liveStat(row, member, baseStats) : null,
  );
  const maxLive = Math.max(1, ...lives.map((v) => v ?? 0));

  const evTotal = STAT_ROWS.reduce((sum, r) => sum + member.evs[r.spread], 0);
  const evOver = evTotal > budget.total;
  const spriteUrl = spriteRef?.sprite_url ?? null;
  const types = spriteRef?.types ?? [];
  // A Mega must hold its stone — auto-filled by the editor and locked here.
  const requiredItem = spriteRef?.required_item ?? null;
  const itemLocked = Boolean(requiredItem);
  // The species' legal abilities, as picker options (only these are offered).
  const abilityOptions: PickerOption[] = (spriteRef?.abilities ?? []).map(
    (slug) => ({ slug, display_name: titleizeSlug(slug) }),
  );

  return (
    <div className="team-member-panel" data-testid={id("panel")}>
      <div className="team-member-panel__header">
        <div className="team-member-panel__title">
          <span className="team-member-panel__slot-label">Slot {slot + 1}</span>
          {member.species && (
            <span className="team-member-panel__species-name">
              {titleizeSlug(member.species, "Empty slot")}
            </span>
          )}
        </div>
        <div className="team-member-panel__actions">
          <button
            type="button"
            className="tm-icon-btn"
            data-testid={id("up")}
            aria-label={`Move slot ${slot + 1} up`}
            onClick={onMoveUp}
            disabled={!canMoveUp}
          >
            ↑
          </button>
          <button
            type="button"
            className="tm-icon-btn"
            data-testid={id("down")}
            aria-label={`Move slot ${slot + 1} down`}
            onClick={onMoveDown}
            disabled={!canMoveDown}
          >
            ↓
          </button>
          <button
            type="button"
            className="tm-icon-btn tm-icon-btn--danger"
            data-testid={id("remove")}
            aria-label={`Remove slot ${slot + 1}`}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      </div>

      {member.species && (
        <div className="team-member-panel__identity">
          <span className="team-member-panel__sprite">
            {spriteUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={spriteUrl} alt="" aria-hidden loading="lazy" />
            ) : (
              <span className="team-member-panel__sprite-empty" aria-hidden />
            )}
          </span>
          <div className="team-member-panel__identity-meta">
            <span className="team-member-panel__identity-name">
              {titleizeSlug(member.species, "Empty slot")}
            </span>
            {types.length > 0 && (
              <span className="team-member-panel__types">
                {types.map((t) => (
                  <span key={t} className={`type-badge type-badge--${t}`}>
                    {t}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="team-member-panel__fields">
        <PickerField label="Species" htmlFor={id("species")}>
          <EntityPicker
            kind="pokemon"
            format={format}
            value={member.species ?? ""}
            onChange={(v) => set({ species: v || null })}
            testid={id("species")}
            inputId={id("species")}
            ariaLabel="Species"
            placeholder="Search Pokémon…"
            withSprite
          />
        </PickerField>

        <div className="team-member-panel__row2">
          <PickerField label="Ability" htmlFor={id("ability")}>
            <EntityPicker
              options={abilityOptions}
              format={format}
              value={member.ability ?? ""}
              onChange={(v) => set({ ability: v || null })}
              testid={id("ability")}
              inputId={id("ability")}
              ariaLabel="Ability"
              placeholder={
                member.species ? "Search abilities…" : "Select a species first"
              }
              disabled={!member.species}
            />
          </PickerField>
          <PickerField
            label={itemLocked ? "Item (Mega stone)" : "Item"}
            htmlFor={id("item")}
          >
            <EntityPicker
              kind="item"
              format={format}
              value={member.item ?? ""}
              onChange={(v) => set({ item: v || null })}
              testid={id("item")}
              inputId={id("item")}
              ariaLabel="Item"
              placeholder="Search items…"
              disabled={itemLocked}
            />
          </PickerField>
        </div>
      </div>

      <fieldset className="team-member-panel__moves" data-testid={id("moves")}>
        <legend className="team-member-panel__moves-legend">Moves</legend>
        <div className="team-member-panel__moves-grid">
          {[0, 1, 2, 3].map((i) => (
            <EntityPicker
              key={i}
              options={movepool}
              format={format}
              value={moveInputs[i]!}
              onChange={(v) => setMove(i, v)}
              testid={id(`move-${i}`)}
              ariaLabel={`Move ${i + 1}`}
              placeholder={
                member.species ? `Move ${i + 1}` : "Select a species first"
              }
              disabled={!member.species}
            />
          ))}
        </div>
      </fieldset>

      <div className="team-member-panel__meta-grid">
        <PickerField label="Nature" htmlFor={id("nature")}>
          <EntityPicker
            options={NATURE_OPTIONS}
            format={format}
            value={member.nature ?? ""}
            onChange={(v) => set({ nature: v || null })}
            testid={id("nature")}
            inputId={id("nature")}
            ariaLabel="Nature"
            placeholder="Nature"
          />
        </PickerField>
        {/* Champions has no Terastallization — hide the Tera picker there. */}
        {format !== "champions" && (
          <PickerField label="Tera type" htmlFor={id("tera")}>
            <EntityPicker
              options={TYPE_OPTIONS}
              format={format}
              value={member.tera_type ?? ""}
              onChange={(v) => set({ tera_type: v || null })}
              testid={id("tera")}
              inputId={id("tera")}
              ariaLabel="Tera type"
              placeholder="Tera type"
            />
          </PickerField>
        )}
        <label className="team-member-panel__field" htmlFor={id("level")}>
          Level
          <input
            id={id("level")}
            data-testid={id("level")}
            className="team-member-panel__level-input"
            type="number"
            min={1}
            max={100}
            value={member.level}
            onChange={(e) => set({ level: clampInt(e.target.value, 1, 100) })}
          />
        </label>
      </div>

      <div className="team-member-panel__stats" data-testid={id("stats")}>
        <div className="team-member-panel__stats-head">
          <span className="team-member-panel__stats-title">{budget.label}</span>
          <span
            className={
              "team-member-panel__ev-total" +
              (evOver ? " team-member-panel__ev-total--over" : "")
            }
            data-testid={id("ev-total")}
          >
            {evTotal} / {budget.total}
          </span>
        </div>

        {STAT_ROWS.map((row, i) => {
          const ev = member.evs[row.spread];
          const live = lives[i];
          const effect = row.isHp ? "neutral" : natureEffectFor(member.nature, row.spread);
          return (
            <div className="tm-stat" key={row.spread} data-effect={effect}>
              <span className="tm-stat__label">{row.label}</span>
              <input
                className="tm-stat__slider"
                type="range"
                min={0}
                max={budget.perStat}
                step={budget.step}
                value={Math.min(ev, budget.perStat)}
                aria-label={`${row.label} EV slider`}
                onChange={(e) => setSpread("evs", row.spread, e.target.value)}
              />
              <input
                className="tm-stat__ev"
                data-testid={id(`ev-${row.spread}`)}
                aria-label={`${row.label} EV`}
                type="number"
                min={0}
                max={budget.clampMax}
                value={ev}
                onChange={(e) => setSpread("evs", row.spread, e.target.value)}
              />
              {baseStats && (
                <span className="tm-stat__bar">
                  <span
                    className="tm-stat__bar-fill"
                    // eslint-disable-next-line react/forbid-dom-props -- bar width is a live computed percentage
                    style={{
                      width: `${live ? Math.round((live / maxLive) * 100) : 0}%`,
                    }}
                  />
                  <span
                    className="tm-stat__final"
                    data-testid={id(`stat-${row.spread}`)}
                  >
                    {live ?? "—"}
                  </span>
                </span>
              )}
            </div>
          );
        })}
      </div>

      <details className="team-member-panel__advanced">
        <summary className="team-member-panel__advanced-summary">
          Advanced — IVs & nickname
        </summary>
        <div className="team-member-panel__iv-grid">
          {STAT_ROWS.map((row) => (
            <label
              key={row.spread}
              className="team-member-panel__iv-field"
            >
              {row.label} IV
              <input
                data-testid={id(`iv-${row.spread}`)}
                aria-label={`${row.label} IV`}
                type="number"
                min={0}
                max={31}
                value={member.ivs[row.spread]}
                onChange={(e) => setSpread("ivs", row.spread, e.target.value)}
              />
            </label>
          ))}
        </div>
        <label className="team-member-panel__field" htmlFor={id("nickname")}>
          Nickname
          <input
            id={id("nickname")}
            data-testid={id("nickname")}
            value={member.nickname ?? ""}
            placeholder="(optional)"
            onChange={(e) => set({ nickname: e.target.value || null })}
          />
        </label>
      </details>

      <TeamWarnings
        warnings={warnings}
        testid={id("warnings")}
        title="Issues"
      />
    </div>
  );
}

/** A labeled wrapper around a picker (label is not a <label> to avoid wrapping
 *  the combobox dropdown — the picker's input carries its own aria-label). */
function PickerField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="team-member-panel__field">
      <label className="team-member-panel__field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}
