import type { ScoreModelAdapter } from "../adapters.js";
import type { ScoreRequest, ScoreResult } from "../types.js";

/** Original two-note drone. It is not a commercial recording. */
export class LocalScoreAdapter implements ScoreModelAdapter {
  readonly id = "local-score-v1";

  compose(input: ScoreRequest): ScoreResult {
    const root = 174 + (input.projectTitle.length % 5) * 8;
    return {
      model: this.id,
      motif: `original-drone:${root}+${Math.round(root * 1.25)}:${input.pictureMs}`,
    };
  }
}
