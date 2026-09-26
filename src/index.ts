import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Store } from "./store.js";
import { Brain } from "./brain.js";
import { shouldReply } from "./policy.js";
import { WhatsApp, type IncomingMessage } from "./whatsapp.js";
import { createControlServer } from "./health.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const store = await Store.open(cfg.dataDir, log);
  const brain = new Brain(cfg, log);

  /**
   * IDs of messages this bot sent. WhatsApp echoes our own sends back through
   * messages.upsert, and without this the bot would read its own reply as the
   * owner typing and put the chat into takeover.
   */
  const ownSent = new Set<string>();
  const rememberOwnSend = (id: string) => {
    ownSent.add(id);
    if (ownSent.size > 500) ownSent.delete(ownSent.values().next().value as string);
  };

  /** One in-flight reply per chat, so a burst can't race itself. */
  const chatQueues = new Map<string, Promise<void>>();
  const enqueue = (jid: string, task: () => Promise<void>): void => {
    const prev = chatQueues.get(jid) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => log.error({ err, jid }, "chat task failed"));
    chatQueues.set(jid, next);
    void next.finally(() => {
      if (chatQueues.get(jid) === next) chatQueues.delete(jid);
    });
  };

  const wa = new WhatsApp(cfg, log, {
    async onMessage(msg: IncomingMessage) {
      // Our own outgoing reply coming back to us. Already recorded; drop it.
      if (msg.fromMe && ownSent.has(msg.messageId)) return;

      // The owner typed in this chat: stand down for a while and keep what
      // they said as context, so any later reply doesn't contradict them.
      if (msg.fromMe) {
        if (store.alreadyHandled(msg.messageId)) return;
        store.markHandled(msg.messageId);
        if (msg.text) store.appendTurn(msg.chatJid, { role: "us", text: msg.text, at: msg.at }, cfg.historyTurns);
        store.startTakeover(msg.chatJid, Date.now() + cfg.takeoverMinutes * 60_000);
        log.info({ jid: msg.chatJid, minutes: cfg.takeoverMinutes }, "owner active in chat, pausing auto-reply there");
        return;
      }

      enqueue(msg.chatJid, async () => {
        const now = Date.now();
        const decision = shouldReply(msg, cfg, store, now);

        store.markHandled(msg.messageId);
        store.setName(msg.chatJid, msg.contactName);
        if (msg.text) {
          store.appendTurn(msg.chatJid, { role: "them", text: msg.text, at: msg.at }, cfg.historyTurns);
        }

        if (!decision.reply) {
          log.debug({ jid: msg.chatJid, reason: decision.reason }, "not replying");
          return;
        }

        const chat = store.chat(msg.chatJid);
        let result;
        try {
          result = await brain.draft({
            contactName: msg.contactName,
            isGroup: msg.isGroup,
            history: chat.history,
          });
        } catch (err) {
          log.error({ err, jid: msg.chatJid }, "Claude call failed, staying silent");
          return;
        }

        if (result.kind === "silent") {
          log.info({ jid: msg.chatJid, reason: result.reason }, "model declined to reply");
          return;
        }

        // Re-check the rails: drafting takes seconds, and the owner may have
        // started typing or hit pause in the meantime.
        const recheck = shouldReply(msg, cfg, store, Date.now(), { skipDedupe: true });
        if (!recheck.reply) {
          log.info({ jid: msg.chatJid, reason: recheck.reason }, "dropped drafted reply after re-check");
          return;
        }

        // Claim the id before sending, so our own echo can never be read as
        // the owner typing. Persisting it too covers an echo that arrives
        // after a restart, when the in-memory set is gone.
        const replyId = wa.newMessageId();
        rememberOwnSend(replyId);
        store.markHandled(replyId);
        try {
          await wa.replyTo(msg, result.text, replyId);
          const at = Date.now();
          store.recordReply(msg.chatJid, at);
          store.appendTurn(msg.chatJid, { role: "us", text: result.text, at }, cfg.historyTurns);
          log.info({ jid: msg.chatJid, chars: result.text.length }, "auto-reply sent");
        } catch (err) {
          log.error({ err, jid: msg.chatJid }, "failed to send reply");
        }
      });
    },
  });

  const server = createControlServer(cfg, store, wa, log);
  await new Promise<void>((resolve) => server.listen(cfg.port, "0.0.0.0", resolve));
  log.info({ port: cfg.port }, "control server listening");
  if (!cfg.adminToken) {
    log.warn("ADMIN_TOKEN is not set — /pair and /status are disabled; pair from the logs instead");
  }

  await wa.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    store.flushSync();
    void wa.stop();
    server.close();
    // Give the socket a moment to close cleanly before the runtime kills us.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception");
    store.flushSync();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
