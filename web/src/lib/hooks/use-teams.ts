/**
 * use-teams — list + mutation state hook for the Teams UI
 * (docs/features/team-builder § teams-client, Phase 8).
 *
 * Owns the account's team summary list and an optional format filter, and wraps
 * every team mutation (create / update / delete / duplicate / import) so the UI
 * never touches the network or the never-throwing teams-client directly. Read
 * helpers (`getTeam`, `exportPaste`) pass through unchanged. When `enabled` is
 * false (a guest) the list stays empty and no request is made (BR-T2). All calls
 * go through the never-throwing teams-client, so the hook itself has no error
 * path — failures surface as the helpers' safe values (`null` / `false` / `[]`).
 */

"use client";

import { useCallback, useEffect, useState } from "react";

import {
  createTeam as apiCreate,
  deleteTeam as apiDelete,
  duplicateTeam as apiDuplicate,
  exportPaste as apiExport,
  getTeam as apiGet,
  importPaste as apiImport,
  listTeams,
  updateTeam as apiUpdate,
  type ImportNote,
  type TeamDetail,
  type TeamSummary,
} from "@/lib/api/teams-client";
import type { TeamMember } from "@/data/teams/team-schema";

export interface UseTeamsResult {
  teams: TeamSummary[];
  formatFilter: string | null;
  setFormatFilter: (f: string | null) => void;
  /** Re-list now (call after an out-of-band write). */
  refresh: () => void;
  get: (id: string) => Promise<TeamDetail | null>;
  create: (input: {
    name?: string;
    format: string;
    members?: TeamMember[];
  }) => Promise<TeamDetail | null>;
  update: (
    id: string,
    input: { name?: string; members?: TeamMember[] },
  ) => Promise<TeamDetail | null>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<TeamDetail | null>;
  importPaste: (
    format: string,
    paste: string,
  ) => Promise<{ team: TeamDetail; notes: ImportNote[] } | null>;
  exportPaste: (id: string) => Promise<string | null>;
  /** False for guests → list stays empty, no fetch. */
  enabled: boolean;
}

export function useTeams(enabled: boolean): UseTeamsResult {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [formatFilter, setFormatFilter] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Fetch the list when enabled / the format filter / an explicit refresh
  // changes. Guests stay empty and make no request.
  useEffect(() => {
    if (!enabled) {
      setTeams([]);
      return;
    }
    let active = true;
    void listTeams({ format: formatFilter || undefined }).then((list) => {
      if (active) setTeams(list);
    });
    return () => {
      active = false;
    };
  }, [enabled, formatFilter, refreshTick]);

  const get = useCallback((id: string) => apiGet(id), []);

  const create = useCallback(
    async (input: {
      name?: string;
      format: string;
      members?: TeamMember[];
    }) => {
      const team = await apiCreate(input);
      if (team) refresh();
      return team;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, input: { name?: string; members?: TeamMember[] }) => {
      const team = await apiUpdate(id, input);
      if (team) refresh();
      return team;
    },
    [refresh],
  );

  const remove = useCallback(async (id: string) => {
    setTeams((prev) => prev.filter((t) => t.id !== id));
    await apiDelete(id);
  }, []);

  const duplicate = useCallback(
    async (id: string) => {
      const team = await apiDuplicate(id);
      if (team) refresh();
      return team;
    },
    [refresh],
  );

  const importPaste = useCallback(
    async (format: string, paste: string) => {
      const result = await apiImport(format, paste);
      if (result) refresh();
      return result;
    },
    [refresh],
  );

  const exportPaste = useCallback((id: string) => apiExport(id), []);

  return {
    teams,
    formatFilter,
    setFormatFilter,
    refresh,
    get,
    create,
    update,
    remove,
    duplicate,
    importPaste,
    exportPaste,
    enabled,
  };
}
