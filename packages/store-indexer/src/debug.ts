import { logger } from "./logger";
import type { LogData } from "./logger";

type DebugFn = {
  (...args: unknown[]): void;
  extend: (suffix: string) => DebugFn;
};

function packArgs(args: unknown[]): LogData | undefined {
  if (args.length === 0) return undefined;
  const data: LogData = {};
  for (const arg of args) {
    if (arg instanceof Error) {
      data.error = arg;
    } else if (arg !== null && typeof arg === "object") {
      Object.assign(data, arg);
    }
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

function createDebugFn(component?: string): DebugFn {
  const log = component ? logger.child({ component }) : logger;
  const fn: DebugFn = (...args: unknown[]) => {
    const [first, ...rest] = args;
    const msg = typeof first === "string" ? first : String(first);
    log.debug(msg, packArgs(rest));
  };
  fn.extend = (suffix: string): DebugFn => createDebugFn(component ? `${component}:${suffix}` : suffix);
  return fn;
}

export const debug = createDebugFn();
export const error = (...args: unknown[]): void => {
  const [first, ...rest] = args;
  const msg = typeof first === "string" ? first : String(first);
  logger.error(msg, packArgs(rest));
};
