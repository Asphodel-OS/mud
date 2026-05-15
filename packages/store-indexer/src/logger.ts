type LogLevel = "debug" | "info" | "warn" | "error";
type LogData = Record<string, unknown>;

type Logger = {
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
  child(bindings: LogData): Logger;
};

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;
const pretty = process.env.LOG_FORMAT === "pretty";

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function formatPretty(entry: Record<string, unknown>): string {
  const { ts, level, service, component, msg, ...rest } = entry;
  const time = (ts as string).slice(11);
  const tag = component ? `${service}:${component}` : service;
  const lvl = (level as string).toUpperCase().padEnd(5);
  const extra = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest, replacer) : "";
  return `${time} ${lvl} [${tag}] ${msg}${extra}`;
}

function createLogger(service: string, base: LogData = {}): Logger {
  function emit(level: LogLevel, msg: string, data?: LogData): void {
    if (LEVELS[level] < minLevel) return;

    const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, service, ...base, msg, ...data };
    const line = pretty ? formatPretty(entry) : JSON.stringify(entry, replacer);

    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    child: (bindings) => createLogger(service, { ...base, ...bindings }),
  };
}

export type { Logger, LogData, LogLevel };
export const logger = createLogger("store-indexer");
