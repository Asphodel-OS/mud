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

// TaruchiStatus static layout (tightly packed):
//   offset 0: affinity  (uint8,  1 byte)
//   offset 1: state     (uint8,  1 byte)
//   offset 2: level     (uint32, 4 bytes)
//   offset 6: xp        (uint32, 4 bytes)
//   offset 10: tp       (uint32, 4 bytes)
//   offset 14: traits   (uint40, 5 bytes)

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

    const traits = hexToBigInt(sliceHex(staticData, 14, 19));
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
