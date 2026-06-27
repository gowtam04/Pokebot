"use client";

import type { AnswerCardProps } from "@/components/types";
import AnswerBody from "@/components/AnswerBody";
import ReasoningBlock from "@/components/ReasoningBlock";
import SpriteCard from "@/components/SpriteCard";
import CandidateTable from "@/components/CandidateTable";
import SourceList from "@/components/SourceList";
import InferenceCallout from "@/components/InferenceCallout";
import CaveatStrip from "@/components/CaveatStrip";
import DamageReadout from "@/components/DamageReadout";
import SuggestionChips from "@/components/SuggestionChips";
import QuestionOptions from "@/components/QuestionOptions";
import ProposedTeamCard from "@/components/teams/ProposedTeamCard";
import { useArtifactViewer } from "@/components/artifact/useArtifactViewer";

/**
 * AnswerCard — the top-level renderer for a single `PokebotAnswer` (T11 /
 * output-formats.md). It fans each field of the payload out to its mapped leaf
 * component (ux-design.md "Surfaces / Components" table), in the reading order:
 *
 *   1. CaveatStrip       ← uncertainty_flags[] + generation_basis.fallback (prominent, top)
 *   2. AnswerBody        ← answer_markdown (always)
 *   3. QuestionOptions   ← question.options[] — the "stop and ask" CTA; click → follow-up turn
 *   4. SpriteCard[]      ← subjects[]
 *   5. CandidateTable    ← candidates ("N of M" when truncated)
 *   6. DamageReadout     ← damage_calc
 *   7. InferenceCallout  ← inferences[]
 *   8. SuggestionChips   ← suggestions[] (+ status) — click → follow-up turn
 *   9. ReasoningBlock    ← reasoning_markdown (collapsible)
 *  10. SourceList        ← citations[] (collapsible "Sources")
 *
 * `onFollowUp` is threaded into the interactive leaves (SuggestionChips,
 * CandidateTable). A suggestion click sends the chosen name verbatim; a candidate
 * row click sends a "Tell me about <name>" follow-up — both are plain follow-up
 * turns for the SAME session (ux-design.md UI → Agent Input Map). Visual styling
 * is deferred to the `frontend-design` skill.
 */
export default function AnswerCard({ answer, onFollowUp }: AnswerCardProps) {
  const {
    status,
    answer_markdown,
    reasoning_markdown,
    citations,
    inferences,
    generation_basis,
    subjects,
    candidates,
    damage_calc,
    suggestions,
    question,
    uncertainty_flags,
    proposed_team,
  } = answer;

  // Stable no-op so the interactive leaves always have a handler even when the
  // host did not pass one (keeps rows/chips clickable in isolation/tests).
  const followUp = onFollowUp ?? (() => {});

  // Per-section "open in viewer" controls (B-4, AV-US-2). `openStructured` opens
  // a rich block (damage-calc, comparison) from THIS committed payload — no
  // fetch (TD-2). Its no-op default keeps the card renderable without a provider.
  const { openStructured } = useArtifactViewer();

  return (
    <div className="answer-card" data-testid="answer-card" data-status={status}>
      <CaveatStrip
        uncertaintyFlags={uncertainty_flags ?? []}
        generationBasis={generation_basis}
      />

      <AnswerBody markdown={answer_markdown} />

      {question && question.options.length > 0 && (
        <QuestionOptions
          options={question.options}
          onSelect={(label) => followUp(label)}
        />
      )}

      {subjects && subjects.length > 0 && (
        <div
          className="answer-card__subjects"
          data-testid="answer-card-subjects"
        >
          {subjects.map((subject, i) => (
            <SpriteCard key={`${subject.name}-${i}`} subject={subject} />
          ))}
          {subjects.length >= 2 && (
            <button
              type="button"
              className="answer-card__open-viewer"
              data-testid="open-comparison"
              onClick={() => openStructured({ kind: "comparison", subjects })}
            >
              Compare in viewer
            </button>
          )}
        </div>
      )}

      {proposed_team && <ProposedTeamCard proposedTeam={proposed_team} />}

      {candidates && (
        <CandidateTable
          candidates={candidates}
          onSelect={(name) => followUp(`Tell me about ${name}`)}
          onShowAll={() =>
            followUp(
              `Show me all ${candidates.total_count} of those, not just the top ${candidates.shown.length}.`,
            )
          }
        />
      )}

      {damage_calc && (
        <div className="answer-card__damage">
          <DamageReadout damageCalc={damage_calc} />
          <button
            type="button"
            className="answer-card__open-viewer"
            data-testid="open-damage-calc"
            onClick={() =>
              openStructured({ kind: "damage-calc", damageCalc: damage_calc })
            }
          >
            Open in viewer
          </button>
        </div>
      )}

      <InferenceCallout inferences={inferences} />

      {suggestions && suggestions.length > 0 && (
        <SuggestionChips
          suggestions={suggestions}
          status={status}
          onSelect={(suggestion) => followUp(suggestion)}
        />
      )}

      <ReasoningBlock markdown={reasoning_markdown} />

      <SourceList citations={citations} />
    </div>
  );
}
