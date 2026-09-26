import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { Turn } from "./store.js";

/** Sentinel the model emits when it judges that silence is the right move. */
const NO_REPLY = "NO_REPLY";

export interface ReplyContext {
  /** Display name of the person writing, if WhatsApp gave us one. */
  contactName?: string;
  /** True when the incoming message came from a group chat. */
  isGroup: boolean;
  /** Rolling transcript, oldest first, ending with the message to answer. */
  history: Turn[];
}

export type ReplyResult =
  | { kind: "reply"; text: string }
  | { kind: "silent"; reason: string };

export class Brain {
  private readonly client: Anthropic;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  }

  async draft(ctx: ReplyContext): Promise<ReplyResult> {
    const messages = buildMessages(ctx, this.cfg.historyTurns);

    const res = await this.client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      // Server-side fallback: if a safety classifier declines the request,
      // the API retries on a comparable model instead of handing back nothing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.cfg.effort },
      // The system prompt is the only large, byte-stable part of the request,
      // so it is the cache breakpoint. Everything volatile lives in `messages`,
      // after the breakpoint, so the prefix stays valid across chats.
      system: [
        {
          type: "text",
          text: this.cfg.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    if (res.stop_reason === "refusal") {
      this.log.warn({ details: res.stop_details }, "model refused to draft a reply");
      return { kind: "silent", reason: "refusal" };
    }

    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    this.log.debug(
      {
        in: res.usage.input_tokens,
        out: res.usage.output_tokens,
        cacheRead: res.usage.cache_read_input_tokens,
        cacheWrite: res.usage.cache_creation_input_tokens,
      },
      "claude usage",
    );

    if (!text) return { kind: "silent", reason: "empty response" };
    // Accept the sentinel on its own or as the whole of a short response.
    if (text === NO_REPLY || text.replace(/[^A-Z_]/g, "") === NO_REPLY) {
      return { kind: "silent", reason: "model chose not to reply" };
    }
    if (res.stop_reason === "max_tokens") {
      this.log.warn("reply hit max_tokens; sending the truncated text");
    }
    return { kind: "reply", text: stripMarkdown(text) };
  }
}

/**
 * Turn the rolling transcript into Claude messages.
 *
 * The API needs strictly alternating roles, and WhatsApp happily produces runs
 * of consecutive messages from one side, so runs are merged into a single turn.
 */
function buildMessages(ctx: ReplyContext, keep: number): Anthropic.Beta.BetaMessageParam[] {
  const turns: Turn[] = ctx.history.slice(-keep);

  const merged: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of turns) {
    const role = turn.role === "them" ? "user" : "assistant";
    const last = merged.at(-1);
    if (last && last.role === role) {
      last.content = `${last.content as string}\n${turn.text}`;
    } else {
      merged.push({ role, content: turn.text });
    }
  }

  // A conversation must open with a user turn.
  while (merged.length > 0 && merged[0]!.role !== "user") merged.shift();

  // Volatile per-request context goes on the final user turn, which sits after
  // the cached system prefix, so it never invalidates the cache.
  const header = [
    `[Chat: ${ctx.isGroup ? "group" : "direct message"}]`,
    ctx.contactName ? `[From: ${ctx.contactName}]` : null,
    `[Local time: ${new Date().toISOString()}]`,
  ]
    .filter(Boolean)
    .join(" ");

  const last = merged.at(-1);
  if (last && last.role === "user") {
    last.content = `${header}\n${last.content as string}`;
  }

  return merged;
}

/** WhatsApp has no markdown, so drop the syntax the model may still reach for. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .trim();
}
