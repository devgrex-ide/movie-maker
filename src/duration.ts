import { PICTURE_FLOOR_MS } from "./constants.js";
import type { BlockReason, ContinuityBible, SceneBeat, ShotSpec } from "./types.js";

export class DurationError extends Error {
  readonly reason: BlockReason;
  constructor(reason: BlockReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface DurationPlan {
  shots: ShotSpec[];
  pictureMs: number;
  reliableMs: number;
  floorMs: number;
  ceilingMs: number;
}

/**
 * Shot lengths are at most the measured reliable length.
 * The sum of target durations is at least the picture floor and at most the
 * shortest consent ceiling. Length is added as new shots, never by looping a clip.
 */
export function compileShotList(input: {
  scenes: SceneBeat[];
  dialogueIdsByScene: Map<number, string[]>;
  bible: ContinuityBible;
  characterSlotIndexes: number[];
  reliableMs: number;
  floorMs?: number;
  ceilingMs?: number;
}): DurationPlan {
  const floorMs = input.floorMs ?? PICTURE_FLOOR_MS;
  const ceilingMs = input.ceilingMs ?? Number.MAX_SAFE_INTEGER;
  const reliableMs = input.reliableMs;
  if (!Number.isFinite(reliableMs) || reliableMs < 1000) {
    throw new DurationError("under_30_minutes", "Reliable shot length is not measured.");
  }
  if (ceilingMs < floorMs) {
    throw new DurationError(
      "runtime_below_minimum",
      "The shortest consent maximum is under 30 minutes, so this cast cannot carry the film.",
    );
  }
  if (input.scenes.length === 0) {
    throw new DurationError("under_30_minutes", "A film needs scenes before shots.");
  }

  const durations = planDurations(reliableMs, floorMs, ceilingMs);
  const buckets = distribute(durations, input.scenes.length);
  const shots: ShotSpec[] = [];
  input.scenes.forEach((scene, sceneIndex) => {
    const sceneDurations = buckets[sceneIndex] ?? [];
    const lines = input.dialogueIdsByScene.get(scene.index) ?? [];
    let lineCursor = 0;
    sceneDurations.forEach((targetMs, indexInScene) => {
      const coverage = COVERAGE[indexInScene % COVERAGE.length] ?? COVERAGE[0];
      const speaks = coverage.speaks && lineCursor < lines.length;
      const dialogueId = speaks ? (lines[lineCursor] ?? null) : null;
      if (speaks) lineCursor += 1;
      shots.push({
        sceneIndex,
        camera: coverage.camera,
        action: `${coverage.action} ${scene.action}`.trim(),
        targetMs,
        dialogueId,
        continuity: continuityLine(input.bible, scene),
        characterSlotIndexes: input.characterSlotIndexes,
        depictions: { violence: false, stunts: false, nudity: false },
      });
    });
  });

  assertDurationInvariant(shots, { reliableMs, floorMs, ceilingMs });
  const pictureMs = shots.reduce((sum, shot) => sum + shot.targetMs, 0);
  return { shots, pictureMs, reliableMs, floorMs, ceilingMs };
}

export function assertDurationInvariant(
  shots: { targetMs: number }[],
  bounds: { reliableMs: number; floorMs?: number; ceilingMs?: number },
): number {
  const floorMs = bounds.floorMs ?? PICTURE_FLOOR_MS;
  const ceilingMs = bounds.ceilingMs ?? Number.MAX_SAFE_INTEGER;
  if (shots.length === 0) {
    throw new DurationError("under_30_minutes", "The shot list is empty.");
  }
  let pictureMs = 0;
  for (const shot of shots) {
    if (!Number.isFinite(shot.targetMs) || shot.targetMs <= 0) {
      throw new DurationError("under_30_minutes", "A shot has no duration.");
    }
    if (shot.targetMs > bounds.reliableMs) {
      throw new DurationError(
        "under_30_minutes",
        `A shot of ${shot.targetMs}ms is longer than the measured reliable length of ${bounds.reliableMs}ms.`,
      );
    }
    pictureMs += shot.targetMs;
  }
  if (pictureMs < floorMs) {
    throw new DurationError(
      "under_30_minutes",
      `Picture is ${pictureMs}ms, under the 30 minute floor of ${floorMs}ms.`,
    );
  }
  if (pictureMs > ceilingMs) {
    throw new DurationError(
      "runtime_below_minimum",
      `Picture is ${pictureMs}ms, over the shortest consent maximum of ${ceilingMs}ms.`,
    );
  }
  return pictureMs;
}

/** Export gate for a finished cut. Targets do not count. Measured take durations do. */
export function assertPictureRuntime(pictureMs: number, floorMs = PICTURE_FLOOR_MS): void {
  if (!Number.isFinite(pictureMs) || pictureMs < floorMs) {
    throw new DurationError(
      "under_30_minutes",
      `Export refused. Picture is under 30 minutes (${Math.max(0, pictureMs) || 0}ms, floor ${floorMs}ms).`,
    );
  }
}

export function planDurations(reliableMs: number, floorMs: number, ceilingMs: number): number[] {
  const durations: number[] = [];
  let sum = 0;
  while (sum < floorMs) {
    const room = ceilingMs - sum;
    const need = floorMs - sum;
    if (room <= 0) {
      throw new DurationError("runtime_below_minimum", "Consent ceiling cannot hold 30 minutes.");
    }
    const length = Math.min(reliableMs, room, need > reliableMs ? reliableMs : need);
    if (length <= 0) {
      throw new DurationError("runtime_below_minimum", "Cannot place another shot inside the consent ceiling.");
    }
    durations.push(length);
    sum += length;
    if (durations.length > 20_000) {
      throw new DurationError("under_30_minutes", "Shot plan exceeded a safe bound.");
    }
  }
  return durations;
}

function distribute(durations: number[], sceneCount: number): number[][] {
  const buckets = Array.from({ length: sceneCount }, () => [] as number[]);
  durations.forEach((duration, index) => {
    buckets[index % sceneCount]?.push(duration);
  });
  return buckets;
}

function continuityLine(bible: ContinuityBible, scene: SceneBeat): string {
  return [
    `style ${bible.style}`,
    `wardrobe ${bible.wardrobe}`,
    `light ${bible.light}`,
    `screen ${bible.screenDirection}`,
    `props ${bible.props}`,
    `place ${scene.location}`,
    `time ${scene.timeOfDay}`,
  ].join("; ");
}

const COVERAGE: { camera: string; action: string; speaks: boolean }[] = [
  { camera: "wide", action: "Establish the room and hold.", speaks: false },
  { camera: "medium", action: "The adult enters on the locked screen direction.", speaks: false },
  { camera: "close", action: "Listening coverage. The face stays readable.", speaks: false },
  { camera: "medium", action: "The spoken line, one setup.", speaks: true },
  { camera: "insert", action: "The hero prop in the same light.", speaks: false },
  { camera: "over-shoulder", action: "Toward the work. The face remains the consented adult.", speaks: false },
  { camera: "close", action: "Reaction. Eyeline holds.", speaks: false },
  { camera: "medium", action: "The answering line.", speaks: true },
  { camera: "wide", action: "The room again, wardrobe unchanged.", speaks: false },
  { camera: "close", action: "A beat of breath before the next line.", speaks: true },
];
