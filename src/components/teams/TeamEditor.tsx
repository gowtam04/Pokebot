/**
 * TeamEditor — the right pane of `/teams`: edit one team's name + up to six
 * members and save (TEAM-US-3/4/5, AC-3.1, AC-5.x). Partial teams are first-class
 * (BR-T4) — Save works with empty slots / incomplete sets.
 *
 * Holds a local draft (name + members) seeded from the `team` prop and re-seeded
 * whenever a different team is opened (`team.id` changes). Add / remove / reorder
 * act on the draft array; each slot is a {@link TeamMemberPanel}. Save hands the
 * draft back to the page (`onSave`) which writes through the never-throwing
 * `useTeams.update`; the returned team carries fresh server `validation`, so the
 * advisory warnings (per-slot inside each panel, team-level via {@link
 * TeamWarnings}) reflect the last saved state. Export opens the {@link
 * ExportDialog} via the page.
 *
 * Live computed stats need species base stats, which the page fetches from the
 * entity index and supplies in `baseStatsBySpecies`; a species with no entry just
 * shows no live column (still fully editable).
 */

"use client";

import { useEffect, useState } from "react";

import type { TeamMember } from "@/data/teams/team-schema";
import type { TeamDetail } from "@/lib/teams-client";
import TeamMemberPanel, {
  type MemberBaseStats,
} from "./TeamMemberPanel";
import TeamWarnings from "./TeamWarnings";

/** A fresh, empty member (partial team allowed — BR-T4). IVs default to 31. */
export function blankMember(): TeamMember {
  return {
    species: null,
    ability: null,
    item: null,
    moves: [],
    nature: null,
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    tera_type: null,
    level: 50,
    nickname: null,
  };
}

export interface TeamEditorProps {
  team: TeamDetail;
  /** Species slug → base stats, for the live-stat columns. */
  baseStatsBySpecies?: Record<string, MemberBaseStats | undefined>;
  /** True while a save is in flight (disables Save). */
  saving?: boolean;
  onSave: (input: { name: string; members: TeamMember[] }) => void;
  onExport: () => void;
  onClose?: () => void;
}

export default function TeamEditor({
  team,
  baseStatsBySpecies,
  saving = false,
  onSave,
  onExport,
  onClose,
}: TeamEditorProps) {
  const [name, setName] = useState(team.name);
  const [members, setMembers] = useState<TeamMember[]>(team.members);

  // Re-seed the draft whenever a different team is opened. Keyed on id so typing
  // in the same team doesn't clobber the draft on an unrelated re-render.
  useEffect(() => {
    setName(team.name);
    setMembers(team.members);
  }, [team.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMember = (index: number, next: TeamMember) =>
    setMembers((prev) => prev.map((m, i) => (i === index ? next : m)));

  const removeMember = (index: number) =>
    setMembers((prev) => prev.filter((_, i) => i !== index));

  const addMember = () =>
    setMembers((prev) =>
      prev.length >= 6 ? prev : [...prev, blankMember()],
    );

  const moveMember = (index: number, dir: -1 | 1) =>
    setMembers((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const teamLevelWarnings = team.validation.filter((w) => w.slot === undefined);

  return (
    <div className="team-editor" data-testid="team-editor">
      <div className="team-editor__header">
        <input
          className="team-editor__name"
          data-testid="team-name"
          aria-label="Team name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="team-editor__format" data-testid="team-editor-format">
          {team.format}
        </span>
        <button
          type="button"
          data-testid="team-save"
          onClick={() => onSave({ name, members })}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" data-testid="team-export" onClick={onExport}>
          Export
        </button>
        {onClose && (
          <button type="button" data-testid="team-editor-close" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      <TeamWarnings
        warnings={teamLevelWarnings}
        title="Team legality"
        testid="team-level-warnings"
      />

      {/* min(280px, 100%) lets a panel shrink below 280px on a narrow phone
          instead of forcing horizontal overflow; == 280px on desktop. */}
      <div className="team-editor__grid">
        {members.map((member, i) => (
          <TeamMemberPanel
            key={i}
            slot={i}
            member={member}
            warnings={team.validation.filter((w) => w.slot === i)}
            baseStats={
              member.species
                ? baseStatsBySpecies?.[member.species]
                : undefined
            }
            onChange={(next) => updateMember(i, next)}
            onRemove={() => removeMember(i)}
            onMoveUp={() => moveMember(i, -1)}
            onMoveDown={() => moveMember(i, 1)}
            canMoveUp={i > 0}
            canMoveDown={i < members.length - 1}
          />
        ))}
      </div>

      {members.length < 6 && (
        <button
          type="button"
          className="team-editor__add"
          data-testid="team-add-member"
          onClick={addMember}
        >
          Add Pokémon ({members.length}/6)
        </button>
      )}
    </div>
  );
}
