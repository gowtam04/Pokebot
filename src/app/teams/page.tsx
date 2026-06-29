/**
 * /teams — the manual team builder (Phase 9; TEAM-US-1..5, 10, 11).
 *
 * A signed-in account's team workbench: a {@link TeamList} rail (create / import
 * / duplicate / delete-with-confirm) beside a {@link TeamEditor} for the selected
 * team. All team data flows through the Wave-4 client layer — `useTeams` for the
 * list + mutations and the teams-client for one-off detail/export — never a raw
 * `/api/teams` call. Guests get a sign-in prompt (BR-T2): no list, no requests.
 *
 * Live editor stats need species base stats, which the page lazily fetches from
 * the entity index (`fetchEntityArtifact`, never-throwing) and caches per slug,
 * keyed to the active format. The format selector scopes the list and is the
 * format new/imported teams are created under.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { fetchMe, type MeResult } from "@/lib/auth-client";
import { fetchEntityArtifact } from "@/lib/entity-client";
import { useTeams } from "@/lib/use-teams";
import type { TeamDetail } from "@/lib/teams-client";
import type { TeamMember } from "@/data/teams/team-schema";
import { FORMATS, type Format } from "@/data/formats";
import TeamList from "@/components/teams/TeamList";
import TeamEditor from "@/components/teams/TeamEditor";
import PasteImportDialog from "@/components/teams/PasteImportDialog";
import ExportDialog from "@/components/teams/ExportDialog";
import type { MemberBaseStats } from "@/components/teams/TeamMemberPanel";

export default function TeamsPage() {
  const [auth, setAuth] = useState<MeResult>({ signedIn: false });
  useEffect(() => {
    let active = true;
    void fetchMe().then((me) => {
      if (active) setAuth(me);
    });
    return () => {
      active = false;
    };
  }, []);

  const teams = useTeams(auth.signedIn);
  const { setFormatFilter } = teams;

  // Active format: scopes the list + is the format new/imported teams use.
  const [format, setFormat] = useState<Format>("scarlet-violet");
  useEffect(() => {
    setFormatFilter(format);
  }, [format, setFormatFilter]);

  // Selected team detail (full members + validation), loaded on demand.
  const [selected, setSelected] = useState<TeamDetail | null>(null);
  const openTeam = useCallback(
    async (id: string) => {
      const detail = await teams.get(id);
      if (detail) setSelected(detail);
    },
    [teams],
  );

  // Base-stat cache for live stats: species slug → stats | null (null = miss).
  const [baseStats, setBaseStats] = useState<
    Record<string, MemberBaseStats | null>
  >({});
  useEffect(() => {
    // Reset the cache when the format changes (stats are per-format).
    setBaseStats({});
  }, [format]);
  useEffect(() => {
    if (!selected) return;
    const wanted = new Set(
      selected.members
        .map((m) => m.species)
        .filter((s): s is string => !!s && !(s in baseStats)),
    );
    if (wanted.size === 0) return;
    let active = true;
    for (const species of wanted) {
      void fetchEntityArtifact("pokemon", species, format).then((res) => {
        if (!active) return;
        const stats =
          res && res.status === "ok" && res.kind === "pokemon"
            ? (res.data.base_stats as MemberBaseStats)
            : null;
        setBaseStats((prev) => ({ ...prev, [species]: stats }));
      });
    }
    return () => {
      active = false;
    };
  }, [selected, format, baseStats]);

  const baseStatsBySpecies: Record<string, MemberBaseStats | undefined> = {};
  for (const [k, v] of Object.entries(baseStats)) {
    if (v) baseStatsBySpecies[k] = v;
  }

  const [saving, setSaving] = useState(false);
  const handleSave = useCallback(
    async (input: { name: string; members: TeamMember[] }) => {
      if (!selected) return;
      setSaving(true);
      const updated = await teams.update(selected.id, input);
      setSaving(false);
      if (updated) setSelected(updated);
    },
    [selected, teams],
  );

  const handleNew = useCallback(async () => {
    const created = await teams.create({ format, name: "New team", members: [] });
    if (created) setSelected(created);
  }, [teams, format]);

  const handleDuplicate = useCallback(
    async (id: string) => {
      const dup = await teams.duplicate(id);
      if (dup) setSelected(dup);
    },
    [teams],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await teams.remove(id);
      setSelected((prev) => (prev && prev.id === id ? null : prev));
    },
    [teams],
  );

  // Import + export dialogs.
  const [importOpen, setImportOpen] = useState(false);
  const [exportState, setExportState] = useState<{
    open: boolean;
    paste: string | null;
    loading: boolean;
    name: string;
  }>({ open: false, paste: null, loading: false, name: "" });

  const handleExport = useCallback(async () => {
    if (!selected) return;
    setExportState({
      open: true,
      paste: null,
      loading: true,
      name: selected.name,
    });
    const paste = await teams.exportPaste(selected.id);
    setExportState((prev) => ({ ...prev, paste, loading: false }));
  }, [selected, teams]);

  return (
    <main
      className="teams-page"
      data-testid="teams-page"
    >
      <header className="teams-page__header">
        <h1 className="teams-page__title">
          Teams
        </h1>
        <div className="teams-page__controls">
          <label className="teams-page__format-label">
            Format
            <select
              data-testid="teams-format"
              className="teams-page__format-select"
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as Format);
                setSelected(null);
              }}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <Link
            href="/"
            data-testid="teams-back"
            className="teams-page__back"
          >
            Back to chat
          </Link>
        </div>
      </header>

      {!auth.signedIn ? (
        <p
          data-testid="teams-guest"
          className="teams-page__guest"
        >
          Sign in from the chat page to save and manage teams.
        </p>
      ) : (
        <div className="teams-grid">
          <TeamList
            teams={teams.teams}
            selectedId={selected?.id ?? null}
            onSelect={(id) => void openTeam(id)}
            onNew={() => void handleNew()}
            onImport={() => setImportOpen(true)}
            onDuplicate={(id) => void handleDuplicate(id)}
            onDelete={(id) => void handleDelete(id)}
          />

          {selected ? (
            <TeamEditor
              team={selected}
              baseStatsBySpecies={baseStatsBySpecies}
              saving={saving}
              onSave={(input) => void handleSave(input)}
              onExport={() => void handleExport()}
              onClose={() => setSelected(null)}
            />
          ) : (
            <p
              data-testid="teams-no-selection"
              className="teams-page__empty"
            >
              Select a team to edit, or create a new one.
            </p>
          )}
        </div>
      )}

      <PasteImportDialog
        open={importOpen}
        format={format}
        onClose={() => setImportOpen(false)}
        onImport={teams.importPaste}
        onImported={(team) => {
          setSelected(team);
          setImportOpen(false);
        }}
      />

      <ExportDialog
        open={exportState.open}
        paste={exportState.paste}
        loading={exportState.loading}
        teamName={exportState.name}
        onClose={() =>
          setExportState((prev) => ({ ...prev, open: false }))
        }
      />
    </main>
  );
}
