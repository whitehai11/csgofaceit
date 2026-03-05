import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

type LogLevel = "info" | "error";

type LogEntry = {
  ts: string;
  level: LogLevel;
  service: string;
  event: string;
  payload: Record<string, unknown>;
};

const REDACT_KEYS = ["token", "password", "secret", "authorization", "cookie", "jwt", "api_key", "apikey"];

function shouldRedact(key: string): boolean {
  const normalized = key.toLowerCase();
  return REDACT_KEYS.some((needle) => normalized.includes(needle));
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    output[key] = shouldRedact(key) ? "[REDACTED]" : redact(val);
  }
  return output;
}

class ServiceLogger {
  private readonly logDir: string;
  private readonly logFilePath: string;

  constructor(private readonly service: string, logDir?: string) {
    this.logDir = logDir ?? process.env.LOG_DIR ?? "/logs";
    this.logFilePath = path.join(this.logDir, `${this.service}.log`);
  }

  info(event: string, payload: Record<string, unknown> = {}): void {
    this.write("info", event, payload);
  }

  error(event: string, payload: Record<string, unknown> = {}): void {
    this.write("error", event, payload);
  }

  private write(level: LogLevel, event: string, payload: Record<string, unknown>): void {
    const safePayload = redact(payload) as Record<string, unknown>;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      event,
      payload: safePayload
    };

    if (level === "error") {
      console.error(`[${entry.ts}] [${this.service}] ${event}`, safePayload);
    } else {
      console.log(`[${entry.ts}] [${this.service}] ${event}`, safePayload);
    }

    void this.writeToFile(entry);
  }

  private async writeToFile(entry: LogEntry): Promise<void> {
    try {
      await mkdir(this.logDir, { recursive: true });
      await appendFile(this.logFilePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [${this.service}] log_write_failed`, { error });
    }
  }
}

export function createServiceLogger(service: string, logDir?: string): ServiceLogger {
  return new ServiceLogger(service, logDir);
}
