import assert from "node:assert/strict";
import test from "node:test";
import { PICTURE_FLOOR_MS } from "../src/constants.js";
import { assertDurationInvariant, assertPictureRuntime, compileShotList } from "../src/duration.js";
import type { ContinuityBible, SceneBeat } from "../src/types.js";
import { cleanup, consentAdult, harness, ADULT_STORY } from "./helpers.js";
import type { RenderTakeInput } from "../src/types.js";

const bible: ContinuityBible = {
  style: "stylized",
  styleNote: "Stylized.",
  wardrobe: "Charcoal coat.",
  light: "Frame-left.",
  screenDirection: "Frame-right.",
  props: "The cup.",
  rooms: ["THE DINER"],
  premise: "An adult keeps the diner open.",
  ending: "The adult stays.",
};

const scenes: SceneBeat[] = Array.from({ length: 12 }, (_, index) => ({
  index,
  act: index < 4 ? 1 : index < 9 ? 2 : 3,
  heading: "BEAT",
  location: "THE DINER",
  timeOfDay: "DAY",
  action: "The adult keeps the room.",
  want: "To stay.",
}));

test("duration compiler sums to at least 30 minutes and rejects a short cut", () => {
  const plan = compileShotList({
    scenes,
    dialogueIdsByScene: new Map(),
    bible,
    characterSlotIndexes: [0],
    reliableMs: 6000,
    floorMs: PICTURE_FLOOR_MS,
  });
  assert.ok(plan.pictureMs >= PICTURE_FLOOR_MS);
  assert.equal(plan.pictureMs, 30 * 60 * 1000);
  assert.ok(plan.shots.every((shot) => shot.targetMs > 0 && shot.targetMs <= 6000));
  assert.ok(plan.shots.length >= 300);

  assert.throws(
    () => assertDurationInvariant([{ targetMs: 5_000 }, { targetMs: 5_000 }], { reliableMs: 6000, floorMs: PICTURE_FLOOR_MS }),
    /under the 30 minute floor/,
  );
  assert.throws(
    () =>
      assertDurationInvariant(
        [{ targetMs: 7_000 }, ...Array.from({ length: 300 }, () => ({ targetMs: 6000 }))],
        { reliableMs: 6000, floorMs: PICTURE_FLOOR_MS },
      ),
    /longer than the measured reliable length/,
  );
  assert.throws(() => assertPictureRuntime(29 * 60 * 1000), /Export refused/);
  assert.throws(() => assertPictureRuntime(0), /Export refused/);
  assert.doesNotThrow(() => assertPictureRuntime(PICTURE_FLOOR_MS));
  assert.throws(
    () =>
      compileShotList({
        scenes,
        dialogueIdsByScene: new Map(),
        bible,
        characterSlotIndexes: [0],
        reliableMs: 6000,
        floorMs: PICTURE_FLOOR_MS,
        ceilingMs: 20 * 60 * 1000,
      }),
    /under 30 minutes/,
  );
});

test("export refuses a cut whose real take durations sum under 30 minutes", () => {
  const box = harness({
    video: {
      id: "short-adapter",
      measureReliableShotLengthMs: () => 6000,
      renderTake(input: RenderTakeInput) {
        return {
          svg: `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><desc>${input.shotId}</desc></svg>`,
          durationMs: 1000,
          identityToken: input.grants[0]?.token ?? "x",
          distance: 0,
          method: "stand-in-token",
          model: "short-adapter",
        };
      },
    },
  });
  try {
    const projectId = box.service.createProject("Short Cut");
    consentAdult(box.service, projectId);
    box.service.submitStory(projectId, "Dev Reviewer", ADULT_STORY);
    const queued = box.service.schedule(projectId, "Dev Reviewer");
    assert.ok(queued >= 300);
    box.service.runWorker(projectId);
    assert.equal(box.renders.count, queued);
    let view = box.service.projectView(projectId);
    while (view.review.current) {
      box.service.reviewTake(view.review.current.takeId, "Dev Reviewer", "accepted");
      view = box.service.projectView(projectId);
    }
    assert.ok(view.cut);
    assert.ok((view.cut?.pictureMs ?? 0) < PICTURE_FLOOR_MS);
    assert.throws(() => box.service.passCut(projectId, "Dev Reviewer"), /30 minute/);
    const exported = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(exported.ok, false);
    assert.ok(exported.reasons.includes("under_30_minutes"));
    assert.notEqual(view.export?.status, "shipped");
    const after = box.service.projectView(projectId);
    assert.notEqual(after.export?.status, "shipped");
  } finally {
    cleanup(box.dir);
  }
});
