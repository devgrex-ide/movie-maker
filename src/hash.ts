import { createHash } from "node:crypto";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function tokenFrom(seed: string): string {
  return sha256(seed).slice(0, 32);
}
