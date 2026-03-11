type Logger = {
  (...args: unknown[]): void;
  extend: (suffix: string) => Logger;
};

const createLogger = (prefix: string): Logger => {
  const log = (...args: unknown[]): void => console.log(`[${prefix}]`, ...args);
  log.extend = (suffix: string): Logger => createLogger(`${prefix}:${suffix}`);
  return log;
};

export const debug = createLogger("mud:store-indexer");
export const error = (...args: unknown[]): void => console.error("[mud:store-indexer]", ...args);
