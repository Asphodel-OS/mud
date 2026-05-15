import { boolean, index, pgSchema, varchar } from "drizzle-orm/pg-core";
import { transformSchemaName } from "@latticexyz/store-sync/postgres";
import { asBigInt, asAddress, asHex } from "@latticexyz/store-sync/postgres";

const schemaName = transformSchemaName("mud");

export const blockCacheTable = pgSchema(schemaName).table("block_cache", {
  blockNumber: asBigInt("block_number", "numeric").notNull().primaryKey(),
  blockHash: varchar("block_hash", { length: 66 }).notNull(),
});

export const rewindLogTable = pgSchema(schemaName).table(
  "rewind_log",
  {
    blockNumber: asBigInt("block_number", "numeric").notNull(),
    address: asAddress("address").notNull(),
    tableId: asHex("table_id").notNull(),
    keyBytes: asHex("key_bytes").notNull(),
    prevStaticData: asHex("prev_static_data"),
    prevEncodedLengths: asHex("prev_encoded_lengths"),
    prevDynamicData: asHex("prev_dynamic_data"),
    prevIsDeleted: boolean("prev_is_deleted"),
    prevBlockNumber: asBigInt("prev_block_number", "numeric"),
    prevRecordExists: boolean("prev_record_exists").notNull(),
  },
  (table) => ({
    blockNumberIdx: index("rewind_log_block_number_idx").on(table.blockNumber),
  }),
);

export const reorgTables = {
  blockCacheTable,
  rewindLogTable,
};
