import crypto from "node:crypto";
import http from "node:http";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { Store } from "./store.js";
import type { WhatsApp } from "./whatsapp.js";

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function send(res: http.ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/**
 * Small control plane. Everything except /health needs ADMIN_TOKEN, because
 * /pair hands whoever loads it the ability to link a device to the account.
 */
export function createControlServer(cfg: Config, store: Store, wa: WhatsApp, log: Logger): http.Server {
  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (!cfg.adminToken) return false;
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const token = bearer || url.searchParams.get("token") || "";
    return token.length > 0 && timingSafeEqual(token, cfg.adminToken);
  };

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const route = `${req.method} ${url.pathname}`;

      // Unauthenticated: the platform health check. Reports process liveness
      // only — a bot waiting to be paired is alive, and killing it would throw
      // away the QR it is showing.
      if (route === "GET /health") {
        return send(res, 200, "ok");
      }

      if (!authorized(req, url)) {
        const why = cfg.adminToken ? "unauthorized" : "ADMIN_TOKEN is not set; control endpoints are disabled";
        return send(res, cfg.adminToken ? 401 : 503, why);
      }

      switch (route) {
        case "GET /status": {
          return send(
            res,
            200,
            JSON.stringify(
              {
                connection: wa.connectionState,
                me: wa.me ?? null,
                enabled: cfg.enabled,
                model: cfg.model,
                ...store.stats(),
              },
              null,
              2,
            ),
            "application/json; charset=utf-8",
          );
        }

        case "GET /pair": {
          const { qrAscii, qrSvg, pairingCode } = await wa.loginChallenge();
          if (!qrSvg && !pairingCode) {
            return send(res, 200, `No pairing needed — connection is "${wa.connectionState}".`);
          }
          if (url.searchParams.get("format") === "text") {
            return send(res, 200, pairingCode ? `Pairing code: ${pairingCode}\n` : (qrAscii ?? ""));
          }
          const body = pairingCode
            ? `<p>On your phone: <b>WhatsApp &rsaquo; Linked devices &rsaquo; Link with phone number</b></p>
               <p class="code">${pairingCode}</p>`
            : `<p>On your phone: <b>WhatsApp &rsaquo; Linked devices &rsaquo; Link a device</b></p>${qrSvg}`;
          return send(
            res,
            200,
            `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
             <title>Pair WhatsApp</title>
             <style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:26rem}
             .code{font:700 2rem/1.2 ui-monospace,monospace;letter-spacing:.2em}
             svg{width:100%;height:auto}</style>
             <h1>Pair this bot</h1>${body}
             <p><small>This page refreshes every 20s while the code is live.</small></p>
             <script>setTimeout(()=>location.reload(),20000)</script>`,
            "text/html; charset=utf-8",
          );
        }

        case "POST /pause": {
          store.setPaused(true);
          log.warn("auto-reply paused via control endpoint");
          return send(res, 200, "paused");
        }

        case "POST /resume": {
          store.setPaused(false);
          log.warn("auto-reply resumed via control endpoint");
          return send(res, 200, "resumed");
        }

        default:
          return send(res, 404, "not found");
      }
    })().catch((err) => {
      log.error({ err }, "control server handler failed");
      if (!res.headersSent) send(res, 500, "internal error");
    });
  });
}
