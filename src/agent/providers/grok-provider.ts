/**
 * GrokProvider — the NATIVE xAI transport behind the {@link LLMProvider} seam.
 *
 * Unlike {@link OpenAICompatibleProvider} (which drives GPT-5.5 and previously
 * Grok through the lowest-common-denominator Chat Completions shim), this adapter
 * speaks xAI's first-class **Responses API** (`client.responses.create`) directly.
 * The OpenAI Node SDK already in the repo is the transport — pointed at
 * `XAI_BASE_URL` it exposes `responses.create` and the full typed Responses event
 * stream — so no new dependency is needed.
 *
 * Differences from the Chat Completions shim:
 *  - System text rides on the top-level `instructions` field (not a system
 *    message); segments are joined with "\n\n". There is NO `cache_control` — xAI
 *    caches a stable prefix automatically (the `cacheBreakpoint` flag is ignored,
 *    same as the shim).
 *  - Tools use the Responses **flattened** function shape
 *    `{ type:"function", name, description, parameters, strict }` — NOT Chat
 *    Completions' nested `{ type:"function", function:{...} }`. `strict:false` lets
 *    the OakAnswer schema's optional/default fields through (xAI applies its own
 *    lenient-strict validation; the loop's Zod re-emit budget is the safety net).
 *  - Reasoning is requested explicitly as `reasoning:{ effort:"high" }` — grok-4.3
 *    defaults to "low", which is too shallow for battle-math. `parallel_tool_calls`
 *    is disabled so `submit_answer` can't ride alongside a data tool, and
 *    `max_output_tokens` is raised so a full candidate list can't truncate the
 *    submit_answer JSON.
 *  - The turn runs STATELESS (`store:false`): we resend the growing `input` array
 *    each iteration rather than chaining `previous_response_id`. To preserve the
 *    reasoning chain across tool turns we request
 *    `include:["reasoning.encrypted_content"]` and echo the model's output items
 *    (reasoning + message + function_call) back verbatim — see the echo mechanism
 *    in `final()` / `streamTurn`. If xAI ever rejects reasoning items as input,
 *    set `echoReasoning:false` to drop them (stateless re-reasoning per turn — still
 *    correct, since the agent is grounded by tool facts, not chain-of-thought).
 *  - The streamed Responses events are mapped to the SAME normalized
 *    {@link ProviderStreamEvent} vocabulary the loop already consumes; the
 *    submit_answer argument fragments feed the runtime AnswerMarkdownExtractor
 *    exactly like the other adapters. (xAI tends to deliver a tool call's arguments
 *    in one shot — the `function_call_arguments.done` fallback covers that.)
 */

import OpenAI from "openai";

import { MAX_TOKENS } from "@/agent/providers/constants";
import { ProviderTransportError } from "@/agent/providers/errors";
import type {
  FinalTurn,
  LLMProvider,
  NormalizedToolCall,
  NormalizedUsage,
  ProviderMessage,
  ProviderStream,
  ProviderStreamEvent,
  ProviderTranscript,
  ReasoningEffort,
  ToolResult,
  TurnRequest,
} from "@/agent/providers/types";
import type { ProviderKind } from "@/agent/models";
import type { ChatMessage, ImageAttachment } from "@/agent/types";

type RInputItem = OpenAI.Responses.ResponseInputItem;
type RInputContent = OpenAI.Responses.ResponseInputContent;
type RStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type RResponse = OpenAI.Responses.Response;
type RUsage = OpenAI.Responses.ResponseUsage;
type RTool = OpenAI.Responses.Tool;
type RFunctionCall = OpenAI.Responses.ResponseFunctionToolCall;
type RFunctionCallOutput = OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
type REasyMessage = OpenAI.Responses.EasyInputMessage;

export interface GrokProviderConfig {
  /** The concrete API model id (e.g. "grok-4.3"). */
  apiModelId: string;
  /** API key for the upstream (already validated as present by the factory). */
  apiKey: string;
  /** Base URL override (xAI: https://api.x.ai/v1). */
  baseURL?: string;
  /** Reasoning effort; mapped to `reasoning.effort`. Defaults to "high" (grok
   *  defaults to "low"). */
  effort?: ReasoningEffort;
  /** Sampling temperature. Omit to inherit the provider default (0.7 on Grok 4.3
   *  — too random for battle-math, so the factory pins a low value). */
  temperature?: number;
  /** Output-token budget (`max_output_tokens`); defaults to {@link MAX_TOKENS}. */
  maxOutputTokens?: number;
  /** Allow parallel tool calls. Defaults to false so submit_answer can't be
   *  returned alongside a data tool. */
  parallelToolCalls?: boolean;
  /** Echo the model's reasoning items back across tool turns (encrypted-content
   *  chain preservation). Default true; set false if xAI rejects reasoning input. */
  echoReasoning?: boolean;
}

/** Minimal surface of the OpenAI client the Grok provider uses (injectable for tests). */
export interface GrokResponsesClientLike {
  responses: {
    create(
      body: OpenAI.Responses.ResponseCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RStreamEvent>> | AsyncIterable<RStreamEvent>;
  };
}

export class GrokProvider implements LLMProvider {
  readonly kind: ProviderKind = "xai";
  readonly apiModelId: string;
  private readonly effort: ReasoningEffort;
  private readonly temperature?: number;
  private readonly maxOutputTokens: number;
  private readonly parallelToolCalls: boolean;
  private readonly echoReasoning: boolean;
  private readonly client: GrokResponsesClientLike;

  constructor(config: GrokProviderConfig, client?: GrokResponsesClientLike) {
    this.apiModelId = config.apiModelId;
    this.effort = config.effort ?? "high";
    this.temperature = config.temperature;
    this.maxOutputTokens = config.maxOutputTokens ?? MAX_TOKENS;
    this.parallelToolCalls = config.parallelToolCalls ?? false;
    this.echoReasoning = config.echoReasoning ?? true;
    this.client =
      client ??
      (new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      }) as GrokResponsesClientLike);
  }

  createTranscript(
    history: ChatMessage[],
    message: string,
    images?: ImageAttachment[],
  ): ProviderTranscript {
    // System text rides on `instructions`, not the transcript.
    const items: RInputItem[] = [
      ...history.map(
        (turn): REasyMessage => ({ role: turn.role, content: turn.content }),
      ),
      {
        role: "user",
        content: buildUserContent(message, images),
      } satisfies REasyMessage,
    ];
    return items;
  }

  streamTurn(req: TurnRequest): ProviderStream {
    const instructions = req.system.map((seg) => seg.text).join("\n\n");

    const tools: RTool[] = req.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      strict: false,
    }));

    // The opaque transcript holds plain items PLUS, for each model turn, a single
    // nested array of echoed output items (reasoning + message + function_call).
    // A depth-1 flatten inlines those — the ONLY array-valued elements — preserving
    // order so every function_call precedes its function_call_output. See the
    // class header (echo mechanism). Optionally drop reasoning items.
    const input = (req.transcript as unknown[])
      .flat()
      .filter(
        (it) =>
          this.echoReasoning ||
          !(
            it != null &&
            typeof it === "object" &&
            (it as { type?: string }).type === "reasoning"
          ),
      ) as RInputItem[];

    const body: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: this.apiModelId,
      instructions,
      input,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: this.parallelToolCalls,
      max_output_tokens: this.maxOutputTokens,
      reasoning: { effort: this.effort },
      // Stateless: we resend `input` and echo output items ourselves rather than
      // chaining previous_response_id. `include` keeps the reasoning chain intact.
      store: false,
      include: ["reasoning.encrypted_content"],
      stream: true,
      ...(this.temperature !== undefined
        ? { temperature: this.temperature }
        : {}),
    };

    const created = this.client.responses.create(body, { signal: req.signal });
    return adaptGrokStream(created);
  }

  buildUserMessage(text: string): ProviderMessage {
    return { role: "user", content: text } satisfies REasyMessage;
  }

  buildToolResultMessages(results: ToolResult[]): ProviderMessage[] {
    // One function_call_output per call_id. Responses has no per-output error flag
    // (unlike Anthropic's is_error) — the validation-error text already rides in
    // `output`, exactly like the Chat shim's {role:"tool"} messages.
    return results.map(
      (r): RFunctionCallOutput => ({
        type: "function_call_output",
        call_id: r.toolCallId,
        output: r.content,
      }),
    );
  }
}

/**
 * Build the CURRENT user message content. Text-only stays a plain string (so the
 * request body is byte-identical to the pre-image path — `instructions` + a
 * string-content message — keeping xAI's automatic prefix cache warm). With
 * images present, emit Responses content parts: the `input_text` part (omitted
 * for an image-only turn) followed by one `input_image` part per attachment,
 * each a base64 `data:` URL. The image rides INSIDE this message's `content`
 * array, so the transcript's depth-1 `.flat()` in `streamTurn` never disturbs it.
 */
function buildUserContent(
  message: string,
  images?: ImageAttachment[],
): string | RInputContent[] {
  if (!images || images.length === 0) return message;
  const parts: RInputContent[] = [];
  if (message.length > 0) parts.push({ type: "input_text", text: message });
  for (const img of images) {
    parts.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${img.mimeType};base64,${img.data}`,
    });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Stream adaptation
// ---------------------------------------------------------------------------

/**
 * Classify a thrown upstream error. An xAI `APIError` (4xx/5xx — bad key,
 * unsupported param, rate limit, model-not-found) becomes a
 * {@link ProviderTransportError} carrying its status so the route can show a
 * model-scoped message; anything else propagates unchanged.
 */
function toTransportError(err: unknown): unknown {
  if (err instanceof OpenAI.APIError) {
    return new ProviderTransportError(
      typeof err.status === "number" ? err.status : undefined,
      err.message,
    );
  }
  return err;
}

/** Best-effort JSON parse; `undefined` on malformed args (loop re-emit handles). */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizeUsage(usage: RUsage | undefined): NormalizedUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    thinkingTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Adapt the xAI Responses streaming events into a provider-neutral
 * {@link ProviderStream}. Captures the final `response` (output items + usage)
 * from `response.completed` during iteration; `final()` reads it (the loop always
 * drains the stream before calling `final()`).
 */
function adaptGrokStream(
  created: Promise<AsyncIterable<RStreamEvent>> | AsyncIterable<RStreamEvent>,
): ProviderStream {
  let completed: RResponse | null = null;
  const started = new Set<number>();
  const sawArgsDelta = new Set<number>();
  const stopped = new Set<number>();

  async function* iterate(): AsyncGenerator<ProviderStreamEvent> {
    let stream: AsyncIterable<RStreamEvent>;
    try {
      stream = await created;
    } catch (err) {
      throw toTransportError(err);
    }
    let it: AsyncIterator<RStreamEvent> | undefined;
    for (;;) {
      let res: IteratorResult<RStreamEvent>;
      try {
        it ??= stream[Symbol.asyncIterator]();
        res = await it.next();
      } catch (err) {
        throw toTransportError(err);
      }
      if (res.done) break;
      const ev = res.value;

      switch (ev.type) {
        case "response.output_item.added": {
          if (ev.item.type === "function_call") {
            started.add(ev.output_index);
            yield {
              type: "tool_call_start",
              index: ev.output_index,
              id: ev.item.call_id,
              name: ev.item.name,
            };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          sawArgsDelta.add(ev.output_index);
          yield {
            type: "tool_call_args_delta",
            index: ev.output_index,
            argChunk: ev.delta,
          };
          break;
        }
        case "response.function_call_arguments.done": {
          // xAI tends to deliver arguments in one shot: if no incremental delta
          // arrived, emit the whole `arguments` once so the AnswerMarkdownExtractor
          // still streams the answer.
          if (!sawArgsDelta.has(ev.output_index) && ev.arguments.length > 0) {
            yield {
              type: "tool_call_args_delta",
              index: ev.output_index,
              argChunk: ev.arguments,
            };
          }
          stopped.add(ev.output_index);
          yield { type: "tool_call_stop", index: ev.output_index };
          break;
        }
        case "response.output_text.delta": {
          yield { type: "text_delta", text: ev.delta };
          break;
        }
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta": {
          yield { type: "thinking_delta", text: ev.delta };
          break;
        }
        case "response.completed": {
          completed = ev.response;
          break;
        }
        default:
          break;
      }
    }

    // Defensive: emit a stop for any tool call that started but never got a
    // `...arguments.done` (clears the loop's submit-index bookkeeping).
    for (const index of started) {
      if (!stopped.has(index)) yield { type: "tool_call_stop", index };
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    async final(): Promise<FinalTurn> {
      const output = completed?.output ?? [];
      const toolCalls: NormalizedToolCall[] = output
        .filter((i): i is RFunctionCall => i.type === "function_call")
        .map((i) => ({
          id: i.call_id, // call_id — what function_call_output references
          name: i.name,
          inputJson: i.arguments,
          input: safeJsonParse(i.arguments),
        }));

      return {
        // The WHOLE output[] (reasoning + message + function_call), echoed verbatim
        // and flattened into `input` on the next streamTurn.
        assistantContentToEcho: output,
        toolCalls,
        usage: normalizeUsage(completed?.usage),
      };
    },
  };
}
