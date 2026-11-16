import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { scanForMinors } from "../src/scan.js";
import type { StoryJobInput } from "../src/types.js";
import { cleanup, harness } from "./helpers.js";

test("a story that needs a minor does not generate images", () => {
  let storyCalls = 0;
  let renderCalls = 0;
  const box = harness({
    story: {
      id: "should-not-run",
      writePackage(_input: StoryJobInput) {
        storyCalls += 1;
        throw new Error("story adapter ran");
      },
    },
    video: {
      id: "should-not-render",
      measureReliableShotLengthMs: () => 6000,
      renderTake() {
        renderCalls += 1;
        throw new Error("image rendered");
      },
    },
  });
  try {
    const projectId = box.service.createProject("");
    box.service.setTitle(projectId, "Stopped");
    const stories = [
      "A little boy named Timmy, age 7, loses his dog and asks the town for help.",
      "The 8-year-old waits on the porch until dark.",
      "A teenager steals the car and drives it to the ridge.",
      "Her son is 7 and he will not leave the station.",
    ];
    for (const text of stories) {
      assert.ok(scanForMinors(text), text);
      const result = box.service.submitStory(projectId, "Dev Reviewer", text);
      assert.equal(result.blocked, true);
      assert.deepEqual(result.reasons, ["minor"]);
      assert.equal(result.imagesWritten, 0);
    }
    assert.equal(storyCalls, 0);
    assert.equal(renderCalls, 0);
    assert.equal(box.renders.count, 0);
    assert.equal(box.service.imageCount(projectId), 0);
    assert.equal(fs.existsSync(path.join(box.dataDir, "takes")), false);
    assert.throws(() => box.service.schedule(projectId, "Dev Reviewer"), /minor|cannot be shot/);
    const view = box.service.projectView(projectId);
    assert.equal(view.package?.status, "blocked_minor");
    assert.equal(view.package?.fullStory, null);
    assert.equal(view.package?.shotCount, 0);
    assert.equal(view.imagesWritten, 0);
    const exported = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(exported.ok, false);
    assert.ok(exported.reasons.includes("minor"));
  } finally {
    cleanup(box.dir);
  }
});

test("an adult story is not stopped as a minor", () => {
  assert.equal(scanForMinors("Ruth, a 34-year-old, stays to finish the clock."), null);
  assert.equal(scanForMinors("Two adults reopen a diner after the highway moves."), null);
});
