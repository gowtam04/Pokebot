import type { AnswerBodyProps } from "@/components/types";
import Markdown from "@/components/Markdown";

/**
 * AnswerBody — renders `answer_markdown` (the direct, bottom-line-first answer).
 *
 * Rendered through the shared `Markdown` component (react-markdown + remark-gfm),
 * so bold, lists, links, and GFM tables render properly. Always present in the
 * answer card.
 */
export default function AnswerBody({ markdown }: AnswerBodyProps) {
  return (
    <div className="answer-body" data-testid="answer-body">
      <Markdown markdown={markdown} className="answer-body__content" />
    </div>
  );
}
