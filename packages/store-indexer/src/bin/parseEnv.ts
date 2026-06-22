import { Hex, isHex } from "viem";
import { z, ZodError, ZodTypeAny } from "zod";
import { logger } from "../logger";

export const frontendEnvSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().positive().default(3001),
});

export const indexerEnvSchema = z.intersection(
  z.object({
    FOLLOW_BLOCK_TAG: z.enum(["latest", "safe", "finalized"]).default("latest"),
    START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
    MAX_BLOCK_RANGE: z.coerce.bigint().positive().default(1000n),
    // Only governs the HTTP-poll fallback path: when RPC_WS_URL is set, viem
    // follows the chain via an eth_subscribe newHeads subscription and this
    // interval is unused (the indexer does no waitForTransactionReceipt). Kept
    // at ~block time so a WS outage degrades to one eth_getBlockByNumber per
    // block instead of one per second.
    POLLING_INTERVAL: z.coerce.number().positive().default(12000),
    STORE_ADDRESS: z
      .string()
      .optional()
      .transform((input) => (input === "" ? undefined : input))
      .refine(isHexOrUndefined),
    INTERNAL__VALIDATE_BLOCK_RANGE: z
      .string()
      .optional()
      .transform((input) => input === "true" || input === "1"),
    REORG_SAFE: z
      .string()
      .optional()
      .transform((input) => input === "true" || input === "1"),
    REORG_WINDOW: z.coerce.bigint().positive().default(64n),
  }),
  z.union([
    z.object({
      RPC_HTTP_URL: z.string(),
      RPC_WS_URL: z.string().optional(),
    }),
    z.object({
      RPC_HTTP_URL: z.string().optional(),
      RPC_WS_URL: z.string(),
    }),
  ]),
);

export function parseEnv<TSchema extends ZodTypeAny>(envSchema: TSchema): z.infer<TSchema> {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof ZodError) {
      const { ...invalidEnvVars } = error.format();
      logger.error("missing or invalid environment variables", { vars: Object.keys(invalidEnvVars) });
      process.exit(1);
    }
    throw error;
  }
}

function isHexOrUndefined(input: unknown): input is Hex | undefined {
  return input === undefined || isHex(input);
}
