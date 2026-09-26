import type { Config } from "./config.js";
import type { Store } from "./store.js";

export interface Candidate {
  messageId: string;
  chatJid: string;
  senderNumber: string;
  isGroup: boolean;
  fromMe: boolean;
  /** Message timestamp in ms. */
  at: number;
  text: string;
  mentionsUs: boolean;
}

export type Decision = { reply: true } | { reply: false; reason: string };

const ALLOW: Decision = { reply: true };
const deny = (reason: string): Decision => ({ reply: false, reason });

/**
 * Everything that decides whether a message earns an auto-reply, in cheapest-
 * first order so we never pay for a Claude call we were going to discard.
 *
 * Deliberately excluded from the model's reach: this runs before the model and
 * cannot be talked out of a decision by message content.
 */
export function shouldReply(
  c: Candidate,
  cfg: Config,
  store: Store,
  now: number,
  opts: { skipDedupe?: boolean } = {},
): Decision {
  if (!cfg.enabled) return deny("bot disabled by config");
  if (store.paused) return deny("bot paused at runtime");

  if (c.fromMe) return deny("own message");
  if (!opts.skipDedupe && store.alreadyHandled(c.messageId)) return deny("duplicate message id");
  if (!c.text.trim()) return deny("no text content");

  // Broadcasts, statuses and newsletters are never conversations.
  if (c.chatJid === "status@broadcast" || c.chatJid.endsWith("@broadcast")) return deny("broadcast");
  if (c.chatJid.endsWith("@newsletter")) return deny("newsletter");

  const ageSeconds = (now - c.at) / 1000;
  if (ageSeconds > cfg.maxMessageAgeSeconds) return deny(`stale (${Math.round(ageSeconds)}s old)`);

  if (c.isGroup) {
    if (!cfg.replyToGroups) return deny("group replies disabled");
    if (cfg.groupRequiresMention && !c.mentionsUs) return deny("group message without a mention");
  }

  if (cfg.blocklist.includes(c.senderNumber)) return deny("sender blocklisted");
  if (cfg.allowlist.length > 0 && !cfg.allowlist.includes(c.senderNumber)) {
    return deny("sender not on the allowlist");
  }

  const chat = store.chat(c.chatJid);

  if (now < chat.takeoverUntil) {
    const mins = Math.ceil((chat.takeoverUntil - now) / 60000);
    return deny(`owner took over this chat (${mins}m left)`);
  }
  if (now - chat.lastReplyAt < cfg.chatCooldownSeconds * 1000) return deny("chat cooldown");
  if (chat.repliesToday >= cfg.maxRepliesPerChatPerDay) return deny("per-chat daily cap reached");
  if (store.repliesInLastHour(now) >= cfg.maxRepliesPerHourGlobal) return deny("global hourly cap reached");

  return ALLOW;
}
