import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";

export interface Turn {
  role: "them" | "us";
  text: string;
  at: number;
}

export interface ChatState {
  /** Rolling transcript, oldest first. */
  history: Turn[];
  /** Last time WE sent an auto-reply here. */
  lastReplyAt: number;
  /** Auto-reply is suppressed in this chat until this timestamp. */
  takeoverUntil: number;
  /** Replies sent today, reset when the day changes. */
  repliesToday: number;
  repliesDay: string;
  /** Display name last seen for this chat. */
  name?: string;
}

interface Persisted {
  version: 1;
  chats: Record<string, ChatState>;
  /** Timestamps of every reply sent, for the global hourly cap. */
  recentReplies: number[];
  /** Ring buffer of handled message IDs, for dedupe across restarts. */
  seen: string[];
  /** Runtime pause toggle, survives restarts. */
  paused: boolean;
}

const SEEN_LIMIT = 2000;
const CHAT_LIMIT = 500;

function emptyState(): Persisted {
  return { version: 1, chats: {}, recentReplies: [], seen: [], paused: false };
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class Store {
  private state: Persisted;
  private seenSet: Set<string>;
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private writing = false;
  private dirty = false;

  private constructor(
    file: string,
    state: Persisted,
    private readonly log: Logger,
  ) {
    this.file = file;
    this.state = state;
    this.seenSet = new Set(state.seen);
  }

  static async open(dataDir: string, log: Logger): Promise<Store> {
    await fsp.mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, "state.json");
    let state = emptyState();
    try {
      const raw = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      if (parsed && parsed.version === 1) {
        state = { ...emptyState(), ...parsed } as Persisted;
      } else {
        log.warn({ file }, "state file has an unknown shape, starting fresh");
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // A corrupt state file must not stop the bot: keep a copy and move on.
        const backup = `${file}.corrupt-${Date.now()}`;
        try {
          await fsp.rename(file, backup);
          log.error({ err, backup }, "state file unreadable, moved aside");
        } catch {
          log.error({ err }, "state file unreadable and could not be moved aside");
        }
      }
    }
    return new Store(file, state, log);
  }

  // --- dedupe -------------------------------------------------------------

  alreadyHandled(id: string): boolean {
    return this.seenSet.has(id);
  }

  markHandled(id: string): void {
    if (this.seenSet.has(id)) return;
    this.seenSet.add(id);
    this.state.seen.push(id);
    while (this.state.seen.length > SEEN_LIMIT) {
      const dropped = this.state.seen.shift();
      if (dropped !== undefined) this.seenSet.delete(dropped);
    }
    this.schedulePersist();
  }

  // --- chats --------------------------------------------------------------

  chat(jid: string): ChatState {
    let c = this.state.chats[jid];
    if (!c) {
      c = { history: [], lastReplyAt: 0, takeoverUntil: 0, repliesToday: 0, repliesDay: dayKey(Date.now()) };
      this.state.chats[jid] = c;
      this.evictChats();
    }
    const today = dayKey(Date.now());
    if (c.repliesDay !== today) {
      c.repliesDay = today;
      c.repliesToday = 0;
    }
    return c;
  }

  appendTurn(jid: string, turn: Turn, keep: number): void {
    const c = this.chat(jid);
    c.history.push(turn);
    // Keep a little more than the model sees, so trimming is not lossy mid-turn.
    const cap = Math.max(keep * 2, 8);
    if (c.history.length > cap) c.history.splice(0, c.history.length - cap);
    this.schedulePersist();
  }

  setName(jid: string, name: string | undefined): void {
    if (!name) return;
    const c = this.chat(jid);
    if (c.name !== name) {
      c.name = name;
      this.schedulePersist();
    }
  }

  recordReply(jid: string, at: number): void {
    const c = this.chat(jid);
    c.lastReplyAt = at;
    c.repliesToday += 1;
    this.state.recentReplies.push(at);
    this.pruneRecentReplies(at);
    this.schedulePersist();
  }

  startTakeover(jid: string, until: number): void {
    const c = this.chat(jid);
    if (until > c.takeoverUntil) {
      c.takeoverUntil = until;
      this.schedulePersist();
    }
  }

  repliesInLastHour(now: number): number {
    this.pruneRecentReplies(now);
    return this.state.recentReplies.length;
  }

  private pruneRecentReplies(now: number): void {
    const cutoff = now - 60 * 60 * 1000;
    const kept = this.state.recentReplies.filter((t) => t >= cutoff);
    if (kept.length !== this.state.recentReplies.length) this.state.recentReplies = kept;
  }

  /** Drop the least recently active chats so the file cannot grow forever. */
  private evictChats(): void {
    const entries = Object.entries(this.state.chats);
    if (entries.length <= CHAT_LIMIT) return;
    const lastSeen = (c: ChatState): number => c.history.at(-1)?.at ?? c.lastReplyAt;
    entries.sort((a, b) => lastSeen(a[1]) - lastSeen(b[1]));
    for (const [jid] of entries.slice(0, entries.length - CHAT_LIMIT)) {
      delete this.state.chats[jid];
    }
  }

  // --- pause switch -------------------------------------------------------

  get paused(): boolean {
    return this.state.paused;
  }

  setPaused(v: boolean): void {
    this.state.paused = v;
    this.schedulePersist();
  }

  stats() {
    return {
      chats: Object.keys(this.state.chats).length,
      repliesLastHour: this.repliesInLastHour(Date.now()),
      paused: this.state.paused,
    };
  }

  // --- persistence --------------------------------------------------------

  private schedulePersist(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 1000);
    this.writeTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.writing) {
      // A write is in flight; the trailing dirty flag gets picked up below.
      return;
    }
    if (!this.dirty) return;
    this.writing = true;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      // Atomic replace: a crash mid-write leaves the previous good file intact.
      await fsp.writeFile(tmp, JSON.stringify(this.state), "utf8");
      await fsp.rename(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      this.log.error({ err }, "failed to persist state");
    } finally {
      this.writing = false;
      if (this.dirty) this.schedulePersist();
    }
  }

  /** Synchronous last-gasp write for shutdown handlers. */
  flushSync(): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.error({ err }, "failed to persist state on shutdown");
    }
  }
}
