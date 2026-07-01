"use client";

/**
 * `/admin/champions-items` — the operator-curated Champions item allowlist.
 *
 * A THIN integrator (the "keep app/admin pages thin" rule): it owns the
 * `fetch('/api/admin/champions-items')` load, the client-side filter text, and
 * the OPTIMISTIC toggle (flip the checkbox immediately, POST, revert on error),
 * then delegates all render to the tested {@link ChampionsItemsView} under
 * `src/components/admin/`. It imports no db/repos — only the admin HTTP surface
 * (same-origin, session cookie auto-sent).
 *
 * This is the FIRST mutating admin page: unlike the read-only analytics screens,
 * a checkbox toggle POSTs. The write is gated server-side by
 * `requireAdminRequest` on the route; this page just orchestrates it.
 *
 * `runtime`/`dynamic` are not declared here — the parent `admin/layout.tsx` is
 * already `force-dynamic` + `nodejs` and server-gates the whole route group.
 */

import { useCallback, useEffect, useState } from "react";

import ChampionsItemsView from "@/components/admin/ChampionsItemsView";
import type {
  AdminChampionsItem,
  ChampionsItemsResponse,
} from "@/lib/admin/admin-types";

export default function ChampionsItemsPage() {
  const [items, setItems] = useState<AdminChampionsItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/champions-items", {
        method: "GET",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ChampionsItemsResponse;
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setItems([]);
      setError("Failed to load Champions items.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onBulk = useCallback(
    (available: boolean) => {
      // Optimistic: flip every item at once.
      setItems((prev) => prev.map((it) => ({ ...it, available })));
      setBulkPending(true);
      setError(null);
      void (async () => {
        try {
          const res = await fetch("/api/admin/champions-items", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ all: true, available }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
          setError("Failed to apply that change — reloading.");
          await reload();
        } finally {
          setBulkPending(false);
        }
      })();
    },
    [reload],
  );

  const setAvailability = useCallback((slug: string, available: boolean) => {
    setItems((prev) =>
      prev.map((it) => (it.slug === slug ? { ...it, available } : it)),
    );
  }, []);

  const onToggle = useCallback(
    (slug: string, nextAvailable: boolean) => {
      // Optimistic flip.
      setAvailability(slug, nextAvailable);
      setPending((prev) => new Set(prev).add(slug));
      setError(null);
      void (async () => {
        try {
          const res = await fetch("/api/admin/champions-items", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug, available: nextAvailable }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
          // Revert on failure.
          setAvailability(slug, !nextAvailable);
          setError("Failed to save that change — reverted.");
        } finally {
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(slug);
            return next;
          });
        }
      })();
    },
    [setAvailability],
  );

  return (
    <ChampionsItemsView
      items={items}
      query={query}
      onQueryChange={setQuery}
      onToggle={onToggle}
      onSelectAll={() => onBulk(true)}
      onDeselectAll={() => onBulk(false)}
      loading={loading}
      error={error}
      pending={pending}
      bulkPending={bulkPending}
    />
  );
}
