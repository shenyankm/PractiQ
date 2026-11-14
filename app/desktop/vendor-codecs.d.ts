declare module "seek-bzip" { const codec: { decode(input: Uint8Array, output: { writeByte(value: number): void }): void }; export default codec; }
declare module "lzma-purejs" { const codec: { decompress(properties: Uint8Array, input: { readByte(): number }, output: { writeByte(value: number): void }, size: number): boolean }; export default codec; }
