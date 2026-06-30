"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { MarkdownProps } from "@/components/types";

/**
 * Markdown — the single markdown renderer shared by AnswerBody, ReasoningBlock,
 * and the in-flight streaming bubble (ChatThread).
 *
 * GFM is enabled (remark-gfm) so pipe tables, strikethrough, autolinks, and
 * task-lists render. NO `rehype-raw` / raw-HTML pass-through: `answer_markdown`
 * and `reasoning_markdown` are model output, so we keep react-markdown's
 * default-safe posture (raw HTML is ignored, `javascript:` URLs are stripped).
 *
 * react-markdown v9+ dropped the `className` prop on the component itself, so the
 * wrapper `<div className="markdown-body">` is both required and the single CSS
 * hook (styling lives in globals.css under `.markdown-body`). No fixed
 * `data-testid` here — the component renders in three places and each parent owns
 * its own testid.
 */
export default function Markdown({ markdown, className }: MarkdownProps) {
  const wrapperClass = className ? `markdown-body ${className}` : "markdown-body";
  return (
    <div className={wrapperClass}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
