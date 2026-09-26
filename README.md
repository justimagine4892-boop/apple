# wa-autoreply

A WhatsApp auto-reply bot: incoming messages go to Claude, Claude drafts a reply,
and a layer of rails decides whether that reply is actually sent. Runs as a single
long-lived process on Fly.io (or any host with a persistent disk).

---

## ⚠️ Read this before you pair a number

This uses **[Baileys](https://github.com/WhiskeySockets/Baileys)**, an unofficial
WhatsApp Web client. It logs in as a linked device on a normal account.

**This violates WhatsApp's Terms of Service, and numbers running bots do get banned.**
There is no way to make that risk zero. Mitigations built in here — human-like typing
delays, rate limits, no bulk or unsolicited sending — reduce the odds, they don't
remove them. **Pair a spare SIM, not the number you depend on.**

If you need a sanctioned route, use the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api).
It needs a Meta Business account and restricts free-form replies to 24 hours after
the user's last message. The transport in `src/whatsapp.ts` is the only Baileys-aware
file; swapping it for the Cloud API is a contained change.

---

## How it works

```
WhatsApp message
   │
   ▼
src/whatsapp.ts   decrypt, extract text, work out who sent it
   │
   ▼
src/policy.ts     should this get a reply at all?   ──► no  ► log and stop
   │                                                          (no API call, no cost)
   ▼ yes
src/brain.ts      Claude drafts a reply             ──► NO_REPLY ► stop
   │
   ▼
src/policy.ts     re-check the rails (you may have started typing meanwhile)
   │
   ▼
send: mark read → "typing…" → pause → reply
```

The policy runs **before** the model and cannot be argued out of a decision by
message content. The model only decides *what* to say, never *whether* to say it.

## The rails

| Rail | Default | What it prevents |
|---|---|---|
| Staleness cutoff | 3 min | Answering a whole backlog after a reconnect |
| Owner takeover | 30 min | Talking over you once you've replied yourself |
| Per-chat cooldown | 8 s | Machine-gunning someone who sends five messages |
| Per-chat daily cap | 40 | One conversation running up a bill |
| Global hourly cap | 60 | A runaway loop looking like spam |
| Groups | off | Barging into group chats |
| Allowlist | empty | *(set it — only those numbers get replies)* |
| Dedupe | 2000 ids | Double-replying after a restart |
| Pause switch | — | `POST /pause` stops everything, survives restarts |

**Start with `ALLOWLIST` set to your own second phone.** Watch it for a day before
opening it up.

## Quick start (local)

```bash
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY, ADMIN_TOKEN, PAIRING_NUMBER
set -a && . ./.env && set +a
npm run dev
```

The log prints a pairing code (or a QR if `PAIRING_NUMBER` is unset). On your phone:
**WhatsApp › Settings › Linked devices › Link a device**. Credentials land in
`$DATA_DIR/auth` and are reused on every restart.

```bash
npm test         # 17 tests over the policy rails and the store
npm run typecheck
```

## Deploy to Fly.io

```bash
fly launch --no-deploy --copy-config          # edit `app` in fly.toml first
fly volumes create wa_data --size 1 --region lhr
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  ADMIN_TOKEN="$(openssl rand -hex 32)" \
  PAIRING_NUMBER=447700900123 \
  ALLOWLIST=447700900124
fly deploy
fly logs                                      # the pairing code appears here
```

Then open `https://<app>.fly.dev/pair?token=<ADMIN_TOKEN>` to pair from a browser.

**One machine only.** A WhatsApp session is one linked device holding one set of
signal keys. Two instances will corrupt each other's session and get you logged out.
`fly.toml` pins `min_machines_running = 1` with auto-stop off; keep it that way, and
never `fly scale count 2`.

Railway works the same way: attach a volume at `/data`, set the same variables, and
keep the replica count at one.

## Control endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness for the platform health check |
| `GET /status` | token | Connection state, chat count, replies this hour |
| `GET /pair` | token | QR / pairing code as a web page |
| `POST /pause` | token | Stop auto-replying (persists across restarts) |
| `POST /resume` | token | Resume |

Auth is `?token=<ADMIN_TOKEN>` or `Authorization: Bearer <ADMIN_TOKEN>`. Without
`ADMIN_TOKEN` set these return 503 — `/pair` can link a device to your account, so
it is never left open.

```bash
curl -X POST "https://<app>.fly.dev/pause?token=$ADMIN_TOKEN"
```

## Configuration

Every setting is an environment variable; `.env.example` documents all of them with
defaults. The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `ADMIN_TOKEN` | — | Required for the control endpoints |
| `PAIRING_NUMBER` | — | Digits only, e.g. `447700900123`. Enables pairing-code login |
| `ALLOWLIST` | empty | If set, **only** these numbers get replies |
| `CLAUDE_MODEL` | `claude-opus-5` | |
| `CLAUDE_EFFORT` | `low` | Replies are short; `low` is plenty |
| `SYSTEM_PROMPT` / `SYSTEM_PROMPT_FILE` | built-in | The bot's persona and limits |

### The system prompt

The default in `src/config.ts` is deliberately conservative: it never claims to be
you, refuses to commit to prices, meetings or deadlines, and emits `NO_REPLY` for
spam, small talk and anything only you can decide. Rewrite it for your use case, but
keep the `NO_REPLY` contract — it's how the model declines to answer, and `src/brain.ts`
looks for that exact string.

## Cost

Each reply is one request: the system prompt (cached) plus up to `HISTORY_TURNS`
messages, and a few hundred output tokens. The system prompt is the cache breakpoint
and all volatile context sits after it, so repeat traffic reads the prefix from cache.
Set `LOG_LEVEL=debug` to log `cache_read_input_tokens` per call — if that stays zero
across replies, something in the prefix is changing between requests. Swapping
`CLAUDE_MODEL` to `claude-haiku-4-5` cuts the per-reply cost substantially if the
replies are simple enough.

Requests enable server-side fallback, so a reply still comes back if a safety
classifier declines the first attempt; a genuine refusal makes the bot stay silent
rather than send something odd.

## Limitations

- **Text only.** Images, audio, documents and locations are read for their captions
  and otherwise ignored. There's no transcription or vision.
- **No media replies.** Text out only.
- **No contact-name lookup** beyond WhatsApp's `pushName`.
- **State is a JSON file** on the volume, capped at 500 chats and 2000 dedupe ids.
  Fine for a personal number; swap in SQLite before you point this at real volume.
- **Group replies are off by default** and require an @mention when enabled.

## Layout

```
src/config.ts     env parsing, validation, the default system prompt
src/policy.ts     every rule about whether to reply  (fully unit-tested)
src/brain.ts      the Claude call, prompt caching, NO_REPLY handling
src/whatsapp.ts   Baileys socket, pairing, reconnect, send
src/store.ts      persistent history, dedupe, counters  (atomic writes)
src/health.ts     health and control endpoints
src/index.ts      wiring, per-chat queue, shutdown
```

`baileys` is pinned to `6.7.24`, the current stable line — 7.x is still a release
candidate. WhatsApp changes its protocol regularly, so if the socket starts failing
to connect, bumping Baileys is the first thing to try.
