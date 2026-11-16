import type { BlockReason } from "./types.js";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly reasons: BlockReason[],
    message: string,
  ) {
    super(message);
  }
}
