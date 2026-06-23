import { Hex, sliceHex, hexToBigInt, hexToNumber } from "viem";
import { resourceToHex } from "@latticexyz/common";
import { StorageAdapterLog, StorageAdapter, StorageAdapterBlock } from "@latticexyz/store-sync";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { logger } from "./logger";

const SQS_CONNECTION_TIMEOUT_MS = 5_000;
const SQS_REQUEST_TIMEOUT_MS = 10_000;
const SQS_MAX_ATTEMPTS = 3;

const log = logger.child({ component: "sqs" });

const TARUCHI_STATUS_TABLE_ID = resourceToHex({
  type: "table",
  namespace: "app",
  name: "TaruchiStatus",
});

const IDLE_STATE = 1;

// TaruchiStatus static layout (tightly packed, current schema):
//   offset 0:  affinity     (uint8,  1 byte)
//   offset 1:  state        (uint8,  1 byte)
//   offset 2:  progression  (uint48, 6 bytes — level | trainingPoints<<8 | xp<<16)
//   offset 8:  traits       (uint40, 5 bytes)
//   offset 13: budIndex     (uint8,  1 byte)
//   offset 14: stats        (uint64, 8 bytes)
//   offset 22: metrics      (uint80, 10 bytes)

export function unpackTraits(traits: bigint): string {
  const body = (traits >> 8n) & 0xffn;
  const eye = (traits >> 16n) & 0xffn;
  const mouth = (traits >> 24n) & 0xffn;
  const equipment = (traits >> 32n) & 0xffn;
  const flower = traits & 0xffn;

  return [body, eye, mouth, equipment, flower].map((v) => String(v).padStart(2, "0")).join("");
}

export function extractRevealCodes(logs: readonly StorageAdapterLog[]): string[] {
  const codes: string[] = [];

  for (const log of logs) {
    if (log.eventName !== "Store_SetRecord") continue;
    if (log.args.tableId !== TARUCHI_STATUS_TABLE_ID) continue;

    const staticData = log.args.staticData as Hex;
    const state = hexToNumber(sliceHex(staticData, 1, 2));
    if (state !== IDLE_STATE) continue;

    // traits (uint40) at bytes 8..13. level/xp/trainingPoints were collapsed into a
    // single uint48 `progression` field occupying bytes 2..8 — the same 6 bytes they
    // used before — so the traits offset is unchanged. Layout: affinity(1) state(1)
    // progression(6) traits(5) budIndex(1) stats(8) metrics(10).
    const traits = hexToBigInt(sliceHex(staticData, 8, 13));
    codes.push(unpackTraits(traits));
  }

  return codes;
}

export function createRevealHookAdapter(inner: StorageAdapter, sqsQueueUrl: string): StorageAdapter {
  const sqs = new SQSClient({
    requestHandler: new NodeHttpHandler({
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
      requestTimeout: SQS_REQUEST_TIMEOUT_MS,
    }),
    maxAttempts: SQS_MAX_ATTEMPTS,
  });

  return async (block: StorageAdapterBlock): Promise<void> => {
    await inner(block);

    const codes = extractRevealCodes(block.logs);
    for (const code of codes) {
      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: sqsQueueUrl,
            MessageBody: JSON.stringify({ code }),
          }),
        );
        log.info("pushed reveal code", { code, blockNumber: block.blockNumber });
      } catch (error) {
        log.error("failed to push reveal code", { code, blockNumber: block.blockNumber, error });
      }
    }
  };
}
