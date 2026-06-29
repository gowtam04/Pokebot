"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatThreadProps } from "@/components/types";
import AnswerCard from "@/components/AnswerCard";
import Markdown from "@/components/Markdown";
import { STARTER_PROMPTS, pickRandomPrompts } from "@/lib/example-prompts";

/**
 * Heuristic: has the streaming answer begun laying out a markdown table? A table
 * row/header/separator is the only prose that starts a line with a pipe, so one
 * such line means the agent is mid-table — which we surface as a distinct label
 * (the blinking-caret-only case the user flagged as ambiguous).
 */
function isBuildingTable(markdown: string): boolean {
  return /^\s*\|/m.test(markdown);
}

/**
 * ChatThread — renders the committed conversation (user + assistant turns) in
 * order, plus:
 *   - an in-flight progress indicator while `status === "streaming"`: a single
 *     emphasized "current sub-task" line (the latest `activity` label, or a
 *     "composing the answer / building a table" label once prose starts
 *     streaming, or a generic "thinking" line before the first tool_activity
 *     event lands) with a live elapsed-seconds counter, above which completed
 *     sub-tasks linger as a dim history trail, and
 *   - a transport-fault affordance when `status === "error"` and
 *     `transportError` is set (in-domain failures arrive as normal answer cards,
 *     never here — sse-client.ts / integration.md).
 *
 * Each assistant turn is rendered through `AnswerCard`, with `onFollowUp`
 * threaded down so suggestion-chip / candidate-row clicks POST a follow-up turn
 * on the same session. Visual styling deferred to the `frontend-design` skill.
 */
export default function ChatThread({
  turns,
  activity,
  status,
  streamingMarkdown,
  transportError,
  reconnecting = false,
  onRetry,
  onFollowUp,
  imagePreviews,
}: ChatThreadProps) {
  const showEmptyState = turns.length === 0 && status === "idle";

  // Empty-state starter chips: show a fresh random 4 each time the empty state
  // appears (page load, or returning to it after a "new chat" resets `turns`),
  // so a user discovers Oak's full range over repeated visits. The initial value
  // is the deterministic first-4 so the server render and first client render
  // match (this is a Client Component — `Math.random()` at render time would
  // hydration-mismatch); the post-mount effect then swaps in the random set.
  const [examples, setExamples] = useState<string[]>(() =>
    STARTER_PROMPTS.slice(0, 4),
  );
  useEffect(() => {
    if (showEmptyState) setExamples(pickRandomPrompts(4));
  }, [showEmptyState]);

  // Auto-scroll to the newest content (new turn / streamed token) — important on
  // a phone where the composer occupies a big share of the screen, so a fresh
  // answer lands below the fold. Only follow when the user is pinned to the
  // bottom; if they've scrolled up to read, we don't yank them back down.
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastTopRef = useRef(0);
  const lastTurnIdRef = useRef<string | null>(null);
  useEffect(() => {
    const scroller = bottomRef.current?.closest(
      ".chat-page__main",
    ) as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      // Direction-aware: only an UPWARD user scroll un-pins; reaching the bottom
      // re-pins. A plain distance check would flip off mid-stream because our own
      // programmatic follow lags behind fast-growing content, stalling auto-scroll.
      const atBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      if (scroller.scrollTop < lastTopRef.current - 8) pinnedRef.current = false;
      else if (atBottom) pinnedRef.current = true;
      lastTopRef.current = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const lastTurn = turns[turns.length - 1];
    // A newly-appended USER turn means the user just sent input (typed or via a
    // suggestion/example button). Always snap to the bottom so they see it enter —
    // even if they'd scrolled up to read. Streaming + assistant updates below still
    // respect pinning, so scrolling up mid-turn to read isn't yanked back.
    if (lastTurn?.role === "user" && lastTurn.id !== lastTurnIdRef.current) {
      pinnedRef.current = true;
    }
    lastTurnIdRef.current = lastTurn?.id ?? null;
    // Optional-call: scrollIntoView is absent in jsdom (tests) — no-op there.
    if (pinnedRef.current) bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns, streamingMarkdown, status]);

  // Liveness heartbeat: while the turn is in flight, count wall-clock seconds so
  // a slow turn (long model "thinking" before the first tool, or while composing)
  // visibly keeps moving instead of reading as stuck. Computed from a start
  // timestamp rather than incremented, so a throttled/backgrounded tab stays
  // accurate. Resets whenever the turn ends.
  // Also restart when a reconnect begins/ends so the counter measures the
  // current attempt, not the cumulative wall-clock across a suspended gap (which
  // would read as "stuck").
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (status !== "streaming") {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [status, reconnecting]);

  // The in-flight progress trail (completed sub-tasks) and the single active
  // sub-task line. Once the answer starts streaming the active line becomes a
  // "composing" label; before the first tool it's a generic "thinking" line.
  const trail = activity.slice(0, -1);
  const lastActivity = activity[activity.length - 1];
  const isThinking = !reconnecting && !streamingMarkdown && !lastActivity;
  const currentLabel = reconnecting
    ? "🔄 Reconnecting…"
    : streamingMarkdown
      ? isBuildingTable(streamingMarkdown)
        ? "📋 Building the results table…"
        : "✍️ Writing the answer…"
      : lastActivity
        ? lastActivity.label
        : "Thinking through your question…";

  return (
    <div className="chat-thread" data-testid="chat-thread">
      {showEmptyState && (
        <div className="chat-empty" data-testid="chat-empty">
          <span className="chat-empty__wordmark">Oak</span>
          <p className="chat-empty__invite">
            Ask anything about Pokémon — team-building filters, stat math, damage
            calcs, or a quick Pokédex lookup.
          </p>
          <div className="chat-empty__examples">
            {examples.map((query) => (
              <button
                key={query}
                type="button"
                className="chat-empty__chip"
                onClick={() => onFollowUp(query)}
                data-testid="chat-empty-example"
              >
                {query}
              </button>
            ))}
          </div>
        </div>
      )}

      {turns.map((turn) =>
        turn.role === "user" ? (
          <div
            key={turn.id}
            className="chat-turn chat-turn--user"
            data-testid="user-turn"
          >
            {imagePreviews?.[turn.id]?.length ? (
              <div
                className="chat-turn__images"
                data-testid="user-turn-images"
              >
                {imagePreviews[turn.id]!.map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    className="chat-turn__image"
                    src={url}
                    alt="Attached image"
                  />
                ))}
              </div>
            ) : null}
            {turn.content ? (
              <div className="chat-turn__content">{turn.content}</div>
            ) : null}
          </div>
        ) : (
          <div
            key={turn.id}
            className="chat-turn chat-turn--assistant"
            data-testid="assistant-turn"
          >
            <AnswerCard answer={turn.answer} onFollowUp={onFollowUp} />
          </div>
        ),
      )}

      {status === "streaming" && (
        <div className="chat-thread__progress" data-testid="progress">
          {trail.length > 0 && (
            <ol className="chat-thread__progress-list" aria-hidden="true">
              {trail.map((a, i) => (
                <li
                  key={i}
                  className="chat-thread__progress-item"
                  data-testid={`progress-item-${i}`}
                >
                  {a.label}
                </li>
              ))}
            </ol>
          )}
          <p
            className="chat-thread__progress-current"
            data-testid={
              reconnecting
                ? "progress-reconnecting"
                : isThinking
                  ? "progress-thinking"
                  : "progress-current"
            }
            aria-live="polite"
          >
            <span className="chat-thread__progress-current-label">
              {currentLabel}
            </span>
            {elapsedSeconds >= 3 && (
              <span
                className="chat-thread__progress-elapsed"
                data-testid="progress-elapsed"
                aria-hidden="true"
              >
                ({elapsedSeconds}s)
              </span>
            )}
          </p>
        </div>
      )}

      {status === "streaming" && streamingMarkdown && (
        <div
          className="chat-turn chat-turn--assistant chat-thread__streaming"
          data-testid="streaming-answer"
          aria-live="polite"
        >
          <Markdown markdown={streamingMarkdown} />
        </div>
      )}

      {status === "error" && transportError && (
        <div
          className="chat-thread__error"
          data-testid="transport-error"
          role="alert"
        >
          <span className="chat-thread__error-text">
            Something went wrong ({transportError.code}). Please try again.
          </span>
          {onRetry && (
            <button
              type="button"
              className="chat-thread__error-retry"
              data-testid="transport-error-retry"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Scroll anchor for auto-follow (kept at the very bottom of the thread). */}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
