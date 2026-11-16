import type {
  RenderedTake,
  RenderTakeInput,
  ScoreRequest,
  ScoreResult,
  SpeechRequest,
  SpeechResult,
  StoryDraft,
  StoryJobInput,
} from "./types.js";

/**
 * Model boundaries for the first release.
 * The app ships a local adapter behind each of these.
 * A production adapter may call a model you control, or one vendor whose contract
 * forbids training on reference imagery and limits retention.
 * Nothing in these interfaces accepts a training flag. Training stays off.
 */
export interface StoryModelAdapter {
  readonly id: string;
  writePackage(input: StoryJobInput): StoryDraft;
}

export interface VideoModelAdapter {
  readonly id: string;
  /** Constant for this cast after calibration. Calibration clips are not the film. */
  measureReliableShotLengthMs(): number;
  renderTake(input: RenderTakeInput): RenderedTake;
}

export interface SpeechModelAdapter {
  readonly id: string;
  speak(input: SpeechRequest): SpeechResult;
}

export interface ScoreModelAdapter {
  readonly id: string;
  compose(input: ScoreRequest): ScoreResult;
}

export interface ModelAdapters {
  story: StoryModelAdapter;
  video: VideoModelAdapter;
  speech: SpeechModelAdapter;
  score: ScoreModelAdapter;
}
