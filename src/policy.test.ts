import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shouldReply, type Candidate } from "./policy.js";
import { Store } from "./store.js";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("silent");

const baseConfig = {
  enabled: true,
  replyToGroups: false,
  groupRequiresMention: true,
  allowlist: [] as string[],
  blocklist: [] as string[],
  maxMessageAgeSeconds: 180,
  takeoverMinutes: 30,
  chatCooldownSeconds: 8,
  maxRepliesPerChatPerDay: 40,
  maxRepliesPerHourGlobal: 60,
  historyTurns: 12,
} as unknown as Config;

const NOW = 1_700_000_000_000;

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    messageId: `m${Math.random()}`,
    chatJid: "44700900000@s.whatsapp.net",
    senderNumber: "44700900000",
    isGroup: false,
    fromMe: false,
    at: NOW - 5_000,
    text: "hey, are you around?",
    mentionsUs: false,
    ...over,
  };
}

async function freshStore(): Promise<Store> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-test-"));
  return Store.open(dir, log);
}

test("replies to a normal, recent direct message", async () => {
  const store = await freshStore();
  assert.deepEqual(shouldReply(candidate(), baseConfig, store, NOW), { reply: true });
});

test("never replies to our own messages", async () => {
  const store = await freshStore();
  const d = shouldReply(candidate({ fromMe: true }), baseConfig, store, NOW);
  assert.equal(d.reply, false);
});

test("ignores a message it has already handled", async () => {
  const store = await freshStore();
  const c = candidate();
  assert.equal(shouldReply(c, baseConfig, store, NOW).reply, true);
  store.markHandled(c.messageId);
  assert.equal(shouldReply(c, baseConfig, store, NOW).reply, false);
  // ...but the post-draft re-check deliberately bypasses dedupe.
  assert.equal(shouldReply(c, baseConfig, store, NOW, { skipDedupe: true }).reply, true);
});

test("ignores stale messages so a reconnect backlog is not answered", async () => {
  const store = await freshStore();
  const stale = candidate({ at: NOW - 10 * 60_000 });
  const d = shouldReply(stale, baseConfig, store, NOW);
  assert.equal(d.reply, false);
  assert.match((d as { reason: string }).reason, /stale/);
});

test("ignores broadcasts, statuses and newsletters", async () => {
  const store = await freshStore();
  for (const jid of ["status@broadcast", "123@broadcast", "abc@newsletter"]) {
    assert.equal(shouldReply(candidate({ chatJid: jid }), baseConfig, store, NOW).reply, false, jid);
  }
});

test("group handling follows the group settings", async () => {
  const store = await freshStore();
  const inGroup = candidate({ chatJid: "123-456@g.us", isGroup: true });

  assert.equal(shouldReply(inGroup, baseConfig, store, NOW).reply, false, "off by default");

  const groupsOn = { ...baseConfig, replyToGroups: true } as Config;
  assert.equal(shouldReply(inGroup, groupsOn, store, NOW).reply, false, "still needs a mention");
  assert.equal(shouldReply({ ...inGroup, mentionsUs: true }, groupsOn, store, NOW).reply, true);

  const noMentionNeeded = { ...baseConfig, replyToGroups: true, groupRequiresMention: false } as Config;
  assert.equal(shouldReply(inGroup, noMentionNeeded, store, NOW).reply, true);
});

test("allowlist excludes everyone not on it; blocklist wins outright", async () => {
  const store = await freshStore();
  const allow = { ...baseConfig, allowlist: ["44700900001"] } as Config;
  assert.equal(shouldReply(candidate({ senderNumber: "44700900000" }), allow, store, NOW).reply, false);
  assert.equal(shouldReply(candidate({ senderNumber: "44700900001" }), allow, store, NOW).reply, true);

  const both = { ...baseConfig, allowlist: ["44700900001"], blocklist: ["44700900001"] } as Config;
  assert.equal(shouldReply(candidate({ senderNumber: "44700900001" }), both, store, NOW).reply, false);
});

test("owner takeover silences the chat, and only that chat", async () => {
  const store = await freshStore();
  const jid = "44700900000@s.whatsapp.net";
  store.startTakeover(jid, NOW + 30 * 60_000);

  assert.equal(shouldReply(candidate({ chatJid: jid }), baseConfig, store, NOW).reply, false);
  assert.equal(
    shouldReply(candidate({ chatJid: "44700900002@s.whatsapp.net" }), baseConfig, store, NOW).reply,
    true,
    "a different chat is unaffected",
  );
  // Advance the message timestamp too, or this trips the staleness rail instead.
  const afterTakeover = NOW + 31 * 60_000;
  const d = shouldReply(candidate({ chatJid: jid, at: afterTakeover - 5_000 }), baseConfig, store, afterTakeover);
  assert.equal(d.reply, true, `takeover should expire, got: ${JSON.stringify(d)}`);
});

test("per-chat cooldown and daily cap both bite", async () => {
  const store = await freshStore();
  const jid = "44700900000@s.whatsapp.net";

  store.recordReply(jid, NOW);
  assert.equal(shouldReply(candidate({ chatJid: jid }), baseConfig, store, NOW + 2_000).reply, false, "cooldown");
  assert.equal(shouldReply(candidate({ chatJid: jid }), baseConfig, store, NOW + 9_000).reply, true, "cooled off");

  const tinyCap = { ...baseConfig, maxRepliesPerChatPerDay: 2 } as Config;
  store.recordReply(jid, NOW + 10_000);
  const d = shouldReply(candidate({ chatJid: jid }), tinyCap, store, NOW + 60_000);
  assert.equal(d.reply, false);
  assert.match((d as { reason: string }).reason, /daily cap/);
});

test("global hourly cap counts across every chat and ages out", async () => {
  const store = await freshStore();
  const cfg = { ...baseConfig, maxRepliesPerHourGlobal: 2, chatCooldownSeconds: 0 } as Config;

  store.recordReply("a@s.whatsapp.net", NOW);
  store.recordReply("b@s.whatsapp.net", NOW);
  assert.equal(shouldReply(candidate({ chatJid: "c@s.whatsapp.net" }), cfg, store, NOW + 1_000).reply, false);

  const later = NOW + 61 * 60_000;
  assert.equal(
    shouldReply(candidate({ chatJid: "c@s.whatsapp.net", at: later - 1_000 }), cfg, store, later).reply,
    true,
    "old replies fall out of the window",
  );
});

test("the pause switch and the config kill switch both stop everything", async () => {
  const store = await freshStore();
  store.setPaused(true);
  assert.equal(shouldReply(candidate(), baseConfig, store, NOW).reply, false);
  store.setPaused(false);
  assert.equal(shouldReply(candidate(), baseConfig, store, NOW).reply, true);

  const off = { ...baseConfig, enabled: false } as Config;
  assert.equal(shouldReply(candidate(), off, store, NOW).reply, false);
});

test("empty or whitespace-only messages are skipped", async () => {
  const store = await freshStore();
  assert.equal(shouldReply(candidate({ text: "   " }), baseConfig, store, NOW).reply, false);
});
