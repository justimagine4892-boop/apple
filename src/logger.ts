import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    // Fly's log shipper reads stdout as JSON lines; no pretty transport in prod.
    redact: {
      paths: ["req.headers.authorization", "apiKey", "*.apiKey"],
      censor: "[redacted]",
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
