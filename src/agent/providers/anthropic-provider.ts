/**
 * AnthropicProvider — the Claude transport behind the {@link LLMProvider} seam.
 *
 * This is a faithful relocation of the Anthropic-shaped logic that previously
 * lived inline in runtime.ts: client construction, the system-block
 * `cache_control` placement, the tool mapping to `input_schema`, the
 * `content_block_*` streaming vocabulary, the `finalMessage()` echo + tool_use
 * filter, the all-results-in-ONE-user-message rule, and the cache-aware usage
 * math. Behavior is preserved EXACTLY so the default path does not regress:
 * adaptive thinking + `tool_choice: "auto"` (the Sonnet-4.6 forced-tool_choice
 * 400 gotcha), one ephemeral breakpoint on the last system segment, and the same
 * `input_json_delta` feed into the runtime's AnswerMarkdownExtractor.
 *
 * The `AnthropicClientLike` seam is retained so the existing recorded-transcript
 * tests keep injecting a fake client (now wrapped in this provider).
 */

import Anthropic from "@anthropic-ai/sdk";

import { env } from "@/env";
import { MAX_TOKENS } from "@/agent/providers/constants";
import type {
  FinalTurn,
  LLMProvider,
  NormalizedUsage,
  ProviderMessage,
  ProviderStream,
  ProviderStreamEvent,
  ProviderTranscript,
  ToolResult,
  TurnRequest,
} from "@/agent/providers/types";
import type { ProviderKind } from "@/agent/models";
import type { ChatMessage, ImageAttachment } from "@/agent/types";

// ---------------------------------------------------------------------------
// Injectable client seam (kept identical so the recorded-transcript tests that
// build a fake `messages.stream` keep working — they wrap it in this provider).
// ---------------------------------------------------------------------------

/**
 * The minimal `MessageStream` surface the provider consumes: async-iterable over
 * the raw streaming events plus `finalMessage()` to recover the assembled
 * message.
 */
export interface MessageStreamLike
  extends AsyncIterable<Anthropic.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/** The single SDK method the provider uses (the streaming helper). */
export interface AnthropicClientLike {
  messages: {
    stream(
      params: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): MessageStreamLike;
  };
}

let cachedClient: Anthropic | undefined;

/** Lazily build + memoize the real Anthropic client (once per process). */
export function getAnthropicClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  /** API model id; defaults to `env.ANTHROPIC_MODEL` (the ops-overridable id). */
  apiModelId?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly kind: ProviderKind = "anthropic";
  readonly apiModelId: string;
  private readonly client: AnthropicClientLike;

  constructor(config: AnthropicProviderConfig = {}, client?: AnthropicClientLike) {
    this.apiModelId = config.apiModelId ?? env.ANTHROPIC_MODEL;
    this.client = client ?? getAnthropicClient();
  }

  createTranscript(
    history: ChatMessage[],
    message: string,
    images?: ImageAttachment[],
  ): ProviderTranscript {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: buildUserContent(message, images) },
    ];
    return messages;
  }

  streamTurn(req: TurnRequest): ProviderStream {
    // Map the neutral system segments → Anthropic text blocks, attaching the
    // single ephemeral breakpoint to the segment(s) flagged cacheBreakpoint
    // (the Claude style flags exactly the last one).
    const system: Anthropic.TextBlockParam[] = req.system.map((seg) =>
      seg.cacheBreakpoint
        ? { type: "text", text: seg.text, cache_control: { type: "ephemeral" } }
        : { type: "text", text: seg.text },
    );

    const tools: Anthropic.Tool[] = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    }));

    const stream = this.client.messages.stream(
      {
        model: this.apiModelId,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        // RISK DIRECTIVE: thinking + forced tool_choice = HARD 400 on Sonnet
        // 4.6. Adaptive thinking + tool_choice "auto"; submit_answer is driven
        // by the system prompt and the loop's max-iteration guard, never forced.
        thinking: { type: "adaptive" },
        tool_choice: { type: "auto" },
        messages: req.transcript as Anthropic.MessageParam[],
      },
      { signal: req.signal },
    );

    return adaptAnthropicStream(stream);
  }

  buildUserMessage(text: string): ProviderMessage {
    return { role: "user", content: text } satisfies Anthropic.MessageParam;
  }

  buildToolResultMessages(results: ToolResult[]): ProviderMessage[] {
    // ONE user message carrying all tool_result blocks (splitting them across
    // messages trains the model off parallel tool use).
    const content: Anthropic.ToolResultBlockParam[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolCallId,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    }));
    return [{ role: "user", content }];
  }
}

/**
 * Build the CURRENT user message content. Text-only (no images) stays a plain
 * string so the request body is byte-identical to the pre-image path (prompt
 * cache + recorded-stream stability). With images present, emit content blocks:
 * the text block (omitted when the message is empty — an image-only "what is
 * this?" turn) followed by one base64 image block per attachment. The LAST image
 * carries an ephemeral cache breakpoint so loop iterations 2..N read the (large)
 * images from cache instead of re-uploading them each turn.
 */
function buildUserContent(
  message: string,
  images?: ImageAttachment[],
): string | Anthropic.ContentBlockParam[] {
  if (!images || images.length === 0) return message;
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (message.length > 0) blocks.push({ type: "text", text: message });
  images.forEach((img, i) => {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data },
      ...(i === images.length - 1
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    });
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// Stream adaptation + usage normalization
// ---------------------------------------------------------------------------

function normalizeUsage(usage: Anthropic.Usage): NormalizedUsage {
  return {
    inputTokens:
      usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
    thinkingTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** Wrap an Anthropic MessageStream as a provider-neutral {@link ProviderStream}. */
function adaptAnthropicStream(stream: MessageStreamLike): ProviderStream {
  async function* iterate(): AsyncGenerator<ProviderStreamEvent> {
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          yield {
            type: "tool_call_start",
            index: event.index,
            id: event.content_block.id,
            name: event.content_block.name,
          };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "input_json_delta") {
          yield {
            type: "tool_call_args_delta",
            index: event.index,
            argChunk: event.delta.partial_json,
          };
        } else if (event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          yield { type: "thinking_delta", text: event.delta.thinking };
        }
      } else if (event.type === "content_block_stop") {
        yield { type: "tool_call_stop", index: event.index };
      }
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    async final(): Promise<FinalTurn> {
      const message = await stream.finalMessage();
      const toolCalls = message.content
        .filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        )
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: block.input,
          inputJson: JSON.stringify(block.input),
        }));
      return {
        // Echo the FULL assistant content back (preserves thinking + tool_use
        // blocks for multi-turn continuity on the same model).
        assistantContentToEcho: { role: "assistant", content: message.content },
        toolCalls,
        usage: normalizeUsage(message.usage),
      };
    },
  };
}
