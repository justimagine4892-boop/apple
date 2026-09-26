import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "./store.js";
import { createLogger } from "./logger.js";

const log = createLogger("silent");

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "wa-store-"));
}

test("state survives a restart", async () => {
  const dir = await tmpdir();
  const a = await Store.open(dir, log);
  a.appendTurn("x@s.whatsapp.net", { role: "them", text: "hello", at: 1 }, 12);
  a.markHandled("msg-1");
  a.setPaused(true);
  await a.flush();

  const b = await Store.open(dir, log);
  assert.equal(b.chat("x@s.whatsapp.net").history[0]?.text, "hello");
  assert.equal(b.alreadyHandled("msg-1"), true);
  assert.equal(b.paused, true);
});

test("a corrupt state file is moved aside instead of crashing the bot", async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, "state.json"), "{not json", "utf8");

  const store = await Store.open(dir, log);
  assert.equal(store.stats().chats, 0, "starts from a clean slate");

  const files = await fs.readdir(dir);
  assert.ok(files.some((f) => f.includes("corrupt")), "kept a copy of the bad file");
});

test("history is trimmed so a busy chat cannot grow without bound", async () => {
  const dir = await tmpdir();
  const store = await Store.open(dir, log);
  for (let i = 0; i < 200; i++) {
    store.appendTurn("x@s.whatsapp.net", { role: "them", text: `m${i}`, at: i }, 12);
  }
  const history = store.chat("x@s.whatsapp.net").history;
  assert.ok(history.length <= 24, `expected <=24 turns, got ${history.length}`);
  assert.equal(history.at(-1)?.text, "m199", "keeps the most recent");
});

test("the dedupe ring buffer forgets the oldest ids, not the newest", async () => {
  const dir = await tmpdir();
  const store = await Store.open(dir, log);
  for (let i = 0; i < 2100; i++) store.markHandled(`id-${i}`);
  assert.equal(store.alreadyHandled("id-0"), false, "oldest evicted");
  assert.equal(store.alreadyHandled("id-2099"), true, "newest retained");
});

test("the daily reply counter resets when the day rolls over", async () => {
  const dir = await tmpdir();
  const store = await Store.open(dir, log);
  const jid = "x@s.whatsapp.net";
  store.recordReply(jid, Date.now());
  assert.equal(store.chat(jid).repliesToday, 1);

  // Simulate yesterday's counter still being on the record.
  store.chat(jid).repliesDay = "2000-01-01";
  assert.equal(store.chat(jid).repliesToday, 0, "counter reset on a new day");
});
