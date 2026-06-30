/**
 * /teams — the manual team builder (Phase 9; TEAM-US-1..5, 10, 11).
 *
 * A signed-in account's team workbench: a Pokédex-red header band (clickable Oak
 * wordmark + a prominent "Back to chat" control, both returning to the chat page)
 * over a {@link TeamList} rail (create / import / duplicate / delete-with-confirm)
 * beside a {@link TeamEditor} — a roster strip + focused member editor — for the
 * selected team. All team data flows through the Wave-4 client layer — `useTeams`
 * for the list + mutations and the teams-client for one-off detail/export — never
 * a raw `/api/teams` call. Guests get a sign-in prompt (BR-T2): no list, no
 * requests.
 *
 * Sprites / types / base stats (for the roster chips, member type badges, and the
 * editor's live final-stat bars) are looked up in one batch from the index
 * (`resolveSprites`, never-throwing) and cached per slug, keyed to the active
 * format. The format selector scopes the list and is the format new/imported
 * teams are created under.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { fetchMe, type MeResult } from "@/lib/api/auth-client";
import { resolveSprites, type SpriteRef } from "@/lib/api/sprites-client";
import { useTeams } from "@/lib/hooks/use-teams";
import type { TeamDetail } from "@/lib/api/teams-client";
import type { TeamMember } from "@/data/teams/team-schema";
import { CHAMPIONS_FORMAT, FORMATS, type Format } from "@/data/formats";
import TeamList from "@/components/teams/TeamList";
import TeamEditor from "@/components/teams/TeamEditor";
import PasteImportDialog from "@/components/teams/PasteImportDialog";
import ExportDialog from "@/components/teams/ExportDialog";

/** Human-friendly format label for the header selector. */
function formatLabel(format: string): string {
  if (format === "champions") return "Champions";
  if (format === "scarlet-violet") return "Scarlet / Violet";
  return format;
}

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
  const [format, setFormat] = useState<Format>(CHAMPIONS_FORMAT);
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

  // Auto-select the first team once per format so the workbench is rarely empty
  // (resets on format switch; never fights a user who closes the editor).
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    autoSelectedRef.current = false;
  }, [format]);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (selected) {
      autoSelectedRef.current = true;
      return;
    }
    const first = teams.teams[0];
    if (first) {
      autoSelectedRef.current = true;
      void openTeam(first.id);
    }
  }, [teams.teams, selected, openTeam]);

  // Sprite/type/base-stat cache for the roster + live stats: species slug → ref
  // (undefined = a resolved miss, so we don't refetch).
  const [spriteBySpecies, setSpriteBySpecies] = useState<
    Record<string, SpriteRef | undefined>
  >({});
  useEffect(() => {
    // Reset the cache when the format changes (data is per-format).
    setSpriteBySpecies({});
  }, [format]);
  useEffect(() => {
    if (!selected) return;
    const wanted = [
      ...new Set(
        selected.members
          .map((m) => m.species)
          .filter((s): s is string => !!s && !(s in spriteBySpecies)),
      ),
    ];
    if (wanted.length === 0) return;
    let active = true;
    void resolveSprites(format, wanted).then((refs) => {
      if (!active) return;
      setSpriteBySpecies((prev) => {
        const next = { ...prev };
        for (const s of wanted) next[s] = refs[s];
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [selected, format, spriteBySpecies]);

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
    <main className="teams-page" data-testid="teams-page">
      <header className="teams-page__band">
        <div className="teams-page__brand">
          <Link
            href="/"
            className="teams-page__wordmark"
            aria-label="Oak — back to chat"
          >
            Oak
          </Link>
          <span className="teams-page__crumb" aria-hidden>
            ›
          </span>
          <span className="teams-page__crumb-current">Team Builder</span>
        </div>
        <div className="teams-page__band-controls">
          <label className="teams-page__format">
            <span className="teams-page__format-text">Format</span>
            <span className="teams-page__select-wrap">
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
                    {formatLabel(f)}
                  </option>
                ))}
              </select>
              <span className="pill-caret" aria-hidden />
            </span>
          </label>
          <Link href="/" className="teams-page__back" data-testid="teams-back">
            <span className="teams-page__back-icon" aria-hidden>
              ←
            </span>
            Back to chat
          </Link>
        </div>
      </header>

      <div className="teams-page__body">
        {!auth.signedIn ? (
          <div className="teams-page__guest" data-testid="teams-guest">
            <span className="teams-page__guest-icon" aria-hidden />
            <h2 className="teams-page__guest-title">Sign in to build teams</h2>
            <p className="teams-page__guest-text">
              Saved teams, the team builder, and Showdown import/export unlock
              with a free account — sign in from the chat page to get started.
            </p>
            <Link href="/" className="tm-btn tm-btn--primary">
              Go to chat to sign in
            </Link>
          </div>
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
                spriteBySpecies={spriteBySpecies}
                saving={saving}
                onSave={(input) => void handleSave(input)}
                onExport={() => void handleExport()}
                onClose={() => setSelected(null)}
              />
            ) : (
              <div
                className="teams-page__placeholder"
                data-testid="teams-no-selection"
              >
                <span className="teams-page__placeholder-icon" aria-hidden />
                <p className="teams-page__placeholder-text">
                  Select a team to edit, or create a new one.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

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
        onClose={() => setExportState((prev) => ({ ...prev, open: false }))}
      />
    </main>
  );
}
