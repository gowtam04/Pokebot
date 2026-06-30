/**
 * EntityPicker — the team builder's reusable autocomplete field.
 *
 * A combobox that REQUIRES a valid selection: it keeps a plain text `<input>`
 * for typing/filtering, but the typed text is held in LOCAL state and only the
 * chosen suggestion's canonical **slug** is committed via `onChange`. Free text
 * is never committed — on blur, text that doesn't match a listed option (or an
 * exact slug/name in the current results) is reverted to the last committed
 * value; clearing the field commits "". This is what stops invalid Pokémon /
 * moves / abilities / items from being saved.
 *
 * Two suggestion sources:
 *   - `kind` set     → debounced `searchEntities(kind, q, format)` over the
 *                      format index (species / move / ability / item).
 *   - `options` set  → a static, locally-filtered list (natures / tera types /
 *                      a species' legal movepool).
 *
 * The dropdown shows the friendly display name + optional hint/sprite. Keyboard:
 * ↑/↓ move the active row, Enter selects it, Escape closes. Rows use
 * `onMouseDown(preventDefault)` so a click selects before the input blurs.
 */

"use client";

import { useEffect, useId, useRef, useState } from "react";

import { searchEntities, type EntityKind } from "@/lib/api/search-client";
import type { Format } from "@/data/formats";
import { showdownAniSprite, showdownSpriteId } from "@/lib/sprites";
import type { PickerOption } from "./dex-constants";

export interface EntityPickerProps {
  /** Entity kind to search; omit when supplying a static `options` list. */
  kind?: EntityKind;
  format: Format;
  /** Current value (a slug; "" when empty). */
  value: string;
  /** Commit a new value (raw typed text or a selected suggestion's slug). */
  onChange: (value: string) => void;
  placeholder?: string;
  /** Test id + dom id forwarded to the inner input. */
  testid?: string;
  inputId?: string;
  ariaLabel?: string;
  /** Static option list (disables network search). */
  options?: PickerOption[];
  /** Render a sprite thumbnail per row (species pickers). */
  withSprite?: boolean;
  disabled?: boolean;
}

/** Debounce window for network search — snappy without spamming the endpoint. */
const DEBOUNCE_MS = 150;

/** A sprite thumbnail that quietly removes itself if the CDN 404s. */
function SpriteThumb({ slug }: { slug: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return <span className="entity-picker__thumb entity-picker__thumb--empty" aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CDN sprite, not a static asset
    <img
      className="entity-picker__thumb"
      src={showdownAniSprite(showdownSpriteId(slug, null))}
      alt=""
      aria-hidden
      loading="lazy"
      onError={() => setOk(false)}
    />
  );
}

export default function EntityPicker({
  kind,
  format,
  value,
  onChange,
  placeholder,
  testid,
  inputId,
  ariaLabel,
  options,
  withSprite = false,
  disabled = false,
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PickerOption[]>([]);
  const [active, setActive] = useState(-1);
  // The text shown in the input. Held LOCALLY so typing filters without
  // committing — only a real selection (or a cleared field) reaches `onChange`.
  const [text, setText] = useState(value);
  const reqId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listboxId = useId();

  // Re-seed the input when the committed value changes externally (team load,
  // mega-stone auto-fill, clear). Typing never changes `value`, so this won't
  // fight the user mid-edit.
  useEffect(() => {
    setText(value);
  }, [value]);

  // Tear down any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Re-filter the open dropdown when a STATIC option list arrives or changes
  // (e.g. a member's movepool finishes loading while the picker is focused), so
  // the suggestions reflect the latest list without needing another keystroke.
  useEffect(() => {
    if (open && options) runSearch(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSearch/text are read fresh each render; we only want to react to the option list changing.
  }, [options]);

  function runSearch(q: string) {
    const query = q.trim();
    setActive(-1);
    if (timer.current) clearTimeout(timer.current);

    // Static list — filter locally, no network.
    if (options) {
      const lower = query.toLowerCase();
      const filtered =
        lower.length === 0
          ? options
          : options.filter(
              (o) =>
                o.display_name.toLowerCase().includes(lower) ||
                o.slug.toLowerCase().includes(lower),
            );
      setResults(filtered);
      return;
    }

    // Network search — debounced, with a stale-response guard.
    if (!kind || query.length === 0) {
      setResults([]);
      return;
    }
    const id = ++reqId.current;
    timer.current = setTimeout(() => {
      void searchEntities(kind, query, format).then((matches) => {
        if (id !== reqId.current) return;
        setResults(
          matches.map((m) => ({ slug: m.slug, display_name: m.display_name })),
        );
      });
    }, DEBOUNCE_MS);
  }

  function select(option: PickerOption) {
    onChange(option.slug);
    setText(option.slug);
    setOpen(false);
    setActive(-1);
  }

  function onInputChange(next: string) {
    // Typing only filters — it does NOT commit (require-selection).
    setText(next);
    setOpen(true);
    runSearch(next);
  }

  function onFocus() {
    setOpen(true);
    runSearch(text);
  }

  /**
   * On blur, reconcile the typed text against a real selection:
   *   - empty            → commit "" (clearing is allowed).
   *   - already `value`  → nothing to do (a prior selection stands).
   *   - exact match in the current results (slug or display name) → commit it.
   *   - otherwise        → reject the free text; revert to the committed value.
   */
  function commitOrRevert() {
    setOpen(false);
    setActive(-1);
    const trimmed = text.trim();
    if (trimmed === "") {
      if (value !== "") onChange("");
      setText("");
      return;
    }
    if (trimmed === value) return;
    const lower = trimmed.toLowerCase();
    const match = results.find(
      (o) =>
        o.slug === trimmed ||
        o.slug.toLowerCase() === lower ||
        o.display_name.toLowerCase() === lower,
    );
    if (match) {
      onChange(match.slug);
      setText(match.slug);
      return;
    }
    setText(value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        runSearch(text);
      }
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && active < results.length) {
        e.preventDefault();
        select(results[active]!);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
    }
  }

  const showDropdown = open && results.length > 0;

  return (
    <div className="entity-picker">
      <input
        className="entity-picker__input"
        id={inputId}
        data-testid={testid}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        aria-controls={listboxId}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onChange={(e) => onInputChange(e.target.value)}
        onFocus={onFocus}
        onBlur={commitOrRevert}
        onKeyDown={onKeyDown}
      />
      {showDropdown && (
        <ul
          className="entity-picker__list"
          id={listboxId}
          role="listbox"
          data-testid={testid ? `${testid}-list` : undefined}
        >
          {results.map((option, i) => (
            <li
              key={`${option.slug}-${i}`}
              role="option"
              aria-selected={i === active}
              className={
                "entity-picker__option" +
                (i === active ? " entity-picker__option--active" : "")
              }
              // Select before the input's blur fires.
              onMouseDown={(e) => {
                e.preventDefault();
                select(option);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {withSprite && <SpriteThumb slug={option.slug} />}
              <span className="entity-picker__option-name">
                {option.display_name}
              </span>
              {option.hint && (
                <span className="entity-picker__option-hint">{option.hint}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
