/**
 * T11 — `submit_answer` (tools.md T11, structured-output / terminal action).
 *
 * The tool's input IS the full `OakAnswer` object (schemas.ts /
 * output-formats.md). `run` validates the payload against the single-source Zod
 * schema and echoes it back:
 *   - on success -> the validated OakAnswer (the runtime returns this to the
 *     caller and the frontend renders it),
 *   - on failure -> { error: "invalid_input", detail } so the runtime can return
 *     the validation error to the model and request a re-emit (integration.md);
 *     it never throws.
 *
 * The runtime owns loop termination + the retry budget; this tool only performs
 * the schema check so a malformed payload can't reach the route.
 */

import type { ToolDef } from "@/agent/types";
import {
  oakAnswerSchema,
  toJsonSchema,
  type OakAnswer,
} from "@/agent/schemas";

const description =
  "Submit your final answer. Call this exactly once, as your last action, " +
  "every turn. Its fields populate the user-facing answer card. Include the " +
  "direct answer, your reasoning, the specific data you relied on (citations), " +
  "any inferences with their confidence, the generation your answer is based " +
  "on, and the Pokémon/candidates/calc results to display. If you couldn't " +
  "resolve an entity or need clarification, set status accordingly and provide " +
  "suggestions.";

type SubmitAnswerResult =
  | OakAnswer
  | { error: "invalid_input"; detail: string };

export const submitAnswerTool: ToolDef = {
  name: "submit_answer",
  description,
  inputSchema: toJsonSchema(oakAnswerSchema),
  run(args): Promise<SubmitAnswerResult> {
    const parsed = oakAnswerSchema.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({
        error: "invalid_input",
        detail: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      });
    }
    return Promise.resolve(parsed.data);
  },
};
