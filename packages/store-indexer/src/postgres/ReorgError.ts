export class ReorgError extends Error {
  readonly commonAncestorBlock: bigint;

  constructor(commonAncestorBlock: bigint, detectedAtBlock: bigint) {
    super(`Reorg detected at block ${detectedAtBlock}, common ancestor: ${commonAncestorBlock}`);
    this.name = "ReorgError";
    this.commonAncestorBlock = commonAncestorBlock;
  }
}
