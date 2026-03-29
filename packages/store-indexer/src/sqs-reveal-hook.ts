export function unpackTraits(traits: bigint): string {
  const body = (traits >> 8n) & 0xffn;
  const eye = (traits >> 16n) & 0xffn;
  const mouth = (traits >> 24n) & 0xffn;
  const equipment = (traits >> 32n) & 0xffn;
  const flower = traits & 0xffn;

  return [body, eye, mouth, equipment, flower].map((v) => String(v).padStart(2, "0")).join("");
}
