import makeWASocket, {
  DisconnectReason,
  areJidsSameUser,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  Browsers,
  type WAMessage,
  type WASocket,
} from "baileys";
import path from "node:path";
import QRCode from "qrcode";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export interface IncomingMessage {
  raw: WAMessage;
  messageId: string;
  chatJid: string;
  senderNumber: string;
  contactName?: string;
  isGroup: boolean;
  fromMe: boolean;
  at: number;
  text: string;
  mentionsUs: boolean;
}

export type ConnectionState = "starting" | "connecting" | "open" | "closed" | "logged-out";

export interface WhatsAppHandlers {
  onMessage(msg: IncomingMessage): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WhatsApp {
  private sock: WASocket | null = null;
  private state: ConnectionState = "starting";
  private qrText: string | null = null;
  private pairingCode: string | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private pairingRequested = false;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly handlers: WhatsAppHandlers,
  ) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  get me(): string | undefined {
    return this.sock?.user?.id;
  }

  /** Current login challenge, if the account is not paired yet. */
  async loginChallenge(): Promise<{ qrAscii: string | null; qrSvg: string | null; pairingCode: string | null }> {
    if (!this.qrText) return { qrAscii: null, qrSvg: null, pairingCode: this.pairingCode };
    const [qrAscii, qrSvg] = await Promise.all([
      QRCode.toString(this.qrText, { type: "terminal", small: true }),
      QRCode.toString(this.qrText, { type: "svg", margin: 1, width: 320 }),
    ]);
    return { qrAscii, qrSvg, pairingCode: this.pairingCode };
  }

  async start(): Promise<void> {
    const authDir = path.join(this.cfg.dataDir, "auth");
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    this.log.info({ version: version.join(".") }, "starting WhatsApp socket");

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // The signal key store is hit constantly; caching it keeps decryption
        // from thrashing the volume on every message.
        keys: makeCacheableSignalKeyStore(state.keys, this.log),
      },
      logger: this.log.child({ mod: "baileys" }),
      browser: Browsers.macOS("Desktop"),
      // We answer conversations; syncing years of history just burns disk.
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    this.state = "connecting";

    sock.ev.on("creds.update", () => {
      void saveCreds();
    });

    sock.ev.on("connection.update", (update) => {
      void this.onConnectionUpdate(update, sock);
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // "append" is history backfill; only "notify" is live traffic.
      if (type !== "notify") return;
      for (const raw of messages) {
        void this.dispatch(raw).catch((err) => this.log.error({ err }, "message handler threw"));
      }
    });
  }

  private async onConnectionUpdate(
    update: Partial<{ connection: string; lastDisconnect: { error?: Error }; qr: string }>,
    sock: WASocket,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrText = qr;
      // A pairing code is far easier than a QR on a headless host, but WhatsApp
      // only issues one for an unregistered session, and only once.
      if (this.cfg.pairingNumber && !sock.authState.creds.registered && !this.pairingRequested) {
        this.pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(this.cfg.pairingNumber);
          this.pairingCode = code;
          this.log.warn({ pairingCode: code }, "PAIR THIS DEVICE: WhatsApp > Linked devices > Link with phone number");
        } catch (err) {
          this.log.error({ err }, "could not request a pairing code, fall back to the QR");
        }
      } else if (!this.cfg.pairingNumber) {
        const ascii = await QRCode.toString(qr, { type: "terminal", small: true });
        this.log.warn(`PAIR THIS DEVICE: scan the QR below (or GET /pair)\n${ascii}`);
      }
    }

    if (connection === "open") {
      this.state = "open";
      this.qrText = null;
      this.pairingCode = null;
      this.reconnectAttempt = 0;
      this.log.info({ me: sock.user?.id }, "connected to WhatsApp");
      return;
    }

    if (connection !== "close") return;

    const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

    if (status === DisconnectReason.loggedOut) {
      this.state = "logged-out";
      this.log.error("logged out by WhatsApp — delete the auth directory and pair again");
      return;
    }

    this.state = "closed";
    if (this.stopped) return;

    // Exponential backoff, capped. WhatsApp throttles reconnect storms, and a
    // tight loop here is a good way to get the number flagged.
    this.reconnectAttempt += 1;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    this.log.warn({ status, attempt: this.reconnectAttempt, delay }, "connection closed, reconnecting");
    await sleep(delay);
    if (this.stopped) return;
    try {
      await this.start();
    } catch (err) {
      this.log.error({ err }, "reconnect failed");
      this.state = "closed";
    }
  }

  private async dispatch(raw: WAMessage): Promise<void> {
    const parsed = this.parse(raw);
    if (!parsed) return;
    await this.handlers.onMessage(parsed);
  }

  private parse(raw: WAMessage): IncomingMessage | null {
    const chatJid = raw.key.remoteJid;
    const messageId = raw.key.id;
    if (!chatJid || !messageId) return null;

    const isGroup = Boolean(isJidGroup(chatJid));
    // In a group the sender is the participant; in a DM it is the chat itself.
    const senderJid = isGroup ? (raw.key.participantPn ?? raw.key.participant ?? "") : (raw.key.senderPn ?? chatJid);
    const senderNumber = jidNormalizedUser(senderJid).split("@")[0]?.replace(/\D/g, "") ?? "";

    const meJid = this.sock?.user?.id;
    const mentioned = extractContextInfo(raw)?.mentionedJid ?? [];
    const mentionsUs = mentioned.some((j) => areJidsSameUser(j, meJid));

    return {
      raw,
      messageId,
      chatJid,
      senderNumber,
      contactName: raw.pushName ?? undefined,
      isGroup,
      fromMe: Boolean(raw.key.fromMe),
      at: Number(raw.messageTimestamp ?? 0) * 1000 || Date.now(),
      text: extractText(raw),
      mentionsUs,
    };
  }


  /**
   * Allocate the id a reply will be sent under.
   *
   * WhatsApp echoes our own sends back through messages.upsert, and that echo
   * can arrive before sendMessage() resolves. Taking the id up front lets the
   * caller register it before sending, so the echo is never mistaken for the
   * owner typing (which would silence the chat for the whole takeover window).
   */
  newMessageId(): string {
    return generateMessageIDV2(this.sock?.user?.id);
  }

  /** Show a typing indicator, pause, then send — so replies don't land instantly. */
  async replyTo(msg: IncomingMessage, text: string, messageId: string): Promise<void> {
    const sock = this.sock;
    if (!sock) throw new Error("socket is not connected");

    if (this.cfg.markRead) {
      await sock.readMessages([msg.raw.key]).catch(() => undefined);
    }

    const span = this.cfg.maxTypingMs - this.cfg.minTypingMs;
    // Scale with reply length so a long answer doesn't appear instantly.
    const typingMs = Math.min(
      this.cfg.maxTypingMs,
      this.cfg.minTypingMs + Math.round(text.length * 25) + Math.floor(Math.random() * (span + 1)),
    );

    await sock.presenceSubscribe(msg.chatJid).catch(() => undefined);
    await sock.sendPresenceUpdate("composing", msg.chatJid).catch(() => undefined);
    await sleep(typingMs);
    await sock.sendPresenceUpdate("paused", msg.chatJid).catch(() => undefined);

    await sock.sendMessage(msg.chatJid, { text }, { quoted: msg.raw, messageId });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.sock?.end(undefined);
    } catch {
      // Closing a half-dead socket is not worth failing shutdown over.
    }
  }
}

function extractContextInfo(raw: WAMessage) {
  const m = raw.message;
  return (
    m?.extendedTextMessage?.contextInfo ??
    m?.imageMessage?.contextInfo ??
    m?.videoMessage?.contextInfo ??
    null
  );
}

/** Pull user-visible text out of the many shapes a WhatsApp message can take. */
function extractText(raw: WAMessage): string {
  let m = raw.message;
  // Disappearing and view-once messages wrap the real payload.
  for (let i = 0; i < 3 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.viewOnceMessageV2Extension?.message ??
      m.documentWithCaptionMessage?.message ??
      null;
    if (!inner) break;
    m = inner;
  }
  if (!m) return "";

  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    ""
  ).trim();
}
