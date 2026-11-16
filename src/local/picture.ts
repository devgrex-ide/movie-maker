import type { VideoModelAdapter } from "../adapters.js";
import { LOCAL_RELIABLE_SHOT_MS } from "../constants.js";
import { sha256 } from "../hash.js";
import { takeSvg } from "./mark.js";
import type { RenderedTake, RenderTakeInput } from "../types.js";

/**
 * Local picture adapter.
 * Each take is a rendered slate with a real duration, the consent token, and an identity frame.
 * It does not reconstruct a photographic face and it does not train.
 * Plate bytes are hashed into the provenance trail and are not copied into the frame.
 */
export class LocalPictureAdapter implements VideoModelAdapter {
  readonly id = "local-stand-in-picture-v1";

  measureReliableShotLengthMs(): number {
    return LOCAL_RELIABLE_SHOT_MS;
  }

  renderTake(input: RenderTakeInput): RenderedTake {
    if (input.grants.length === 0 || input.grants.some((grant) => grant.released || grant.plates.length === 0 || !grant.token)) {
      throw new Error("A take requires an open reference grant for every on-screen adult.");
    }
    if (input.durationMs > this.measureReliableShotLengthMs()) {
      throw new Error("Shot is longer than the measured reliable length.");
    }
    const primary = input.grants[0];
    if (!primary) throw new Error("A take requires an open reference grant.");
    const plateHash = sha256(
      Buffer.concat(input.grants.flatMap((grant) => grant.plates.map((plate) => plate.bytes))),
    );
    const svg = takeSvg({
      projectTitle: input.projectTitle,
      camera: input.camera,
      action: input.action,
      durationMs: input.durationMs,
      seed: input.seed,
      token: primary.token,
      consentId: input.grants.map((grant) => grant.consentId).join(","),
      characterNames: input.characterNames,
      attempt: input.attempt,
    });
    return {
      svg,
      durationMs: input.durationMs,
      identityToken: primary.token,
      distance: plateHash.length > 0 ? 0 : 1,
      method: "stand-in-token",
      model: this.id,
    };
  }
}
