import assert from "node:assert/strict";
import test from "node:test";
import { PICTURE_FLOOR_MS } from "../src/constants.js";
import { probeDurationMs } from "../src/mix.js";
import { cleanup, consentAdult, harness } from "./helpers.js";

test("a short story becomes a 30 minute master, and revocation blocks the next export", { timeout: 180_000 }, () => {
  const box = harness();
  try {
    const projectId = box.service.createProject("");
    box.service.setTitle(projectId, "The Clock Room");
    const submitted = box.service.submitStory(
      projectId,
      "Dev Reviewer",
      "Tom Hanks waits at the diner he meant to sell, then keeps it open for one more winter.",
    );
    assert.equal(submitted.blocked, false);
    assert.equal(submitted.imagesWritten, 0);
    const written = box.service.projectView(projectId);
    assert.equal(written.package?.status, "ready");
    assert.ok((written.package?.pictureTargetMs ?? 0) >= PICTURE_FLOOR_MS);
    assert.ok((written.package?.longestShotMs ?? 0) <= 6000);
    assert.equal(written.package?.fullStory?.includes("Tom Hanks"), false);
    assert.equal(written.package?.screenplay?.includes("Hanks"), false);
    assert.ok(written.package?.substitutions?.some((item: { from: string }) => item.from === "Tom Hanks"));
    assert.equal("approved" in (written.package ?? {}), false);

    const tooSoon = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(tooSoon.ok, false);
    assert.ok(tooSoon.reasons.includes("consent_missing"));
    assert.equal(box.service.imageCount(projectId), 0);

    const consentId = consentAdult(box.service, projectId, "Inez Calder");
    const queued = box.service.schedule(projectId, "Dev Reviewer");
    assert.ok(queued >= 300);
    box.service.renderQueued(projectId);
    assert.ok(box.service.imageCount(projectId) >= 300);
    const prompts = box.service.listPrompts(projectId);
    assert.ok(prompts.length >= 300);
    for (const prompt of prompts) {
      assert.equal(prompt.includes("Tom Hanks"), false);
      assert.equal(prompt.includes("Hanks"), false);
      assert.equal(prompt.includes("Inez"), false);
      assert.match(prompt, /training: denied/);
    }

    let view = box.service.projectView(projectId);
    let accepted = 0;
    while (view.review.current) {
      box.service.reviewTake(view.review.current.takeId, "Dev Reviewer", "accepted");
      accepted += 1;
      view = box.service.projectView(projectId);
    }
    assert.ok(accepted >= 300);
    assert.ok((view.cut?.pictureMs ?? 0) >= PICTURE_FLOOR_MS);
    box.service.passCut(projectId, "Dev Reviewer");
    const shipped = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(shipped.ok, true);
    assert.ok(shipped.pictureMs >= PICTURE_FLOOR_MS);
    assert.match(shipped.disclosure ?? "", /synthetic media/i);
    const manifest = JSON.parse(box.service.readManifest(shipped.exportId).toString("utf8")) as {
      pictureMs: number;
      takes: { durationMs: number; consentIds: string[] }[];
      mixPath?: string;
    };
    assert.ok(manifest.pictureMs >= PICTURE_FLOOR_MS);
    assert.ok(manifest.takes.every((take) => take.consentIds.includes(consentId)));
    const after = box.service.projectView(projectId);
    const mixPath = `${box.dataDir}/exports/${shipped.exportId}/mix.wav`;
    assert.ok(probeDurationMs(mixPath) + 1500 >= PICTURE_FLOOR_MS);
    assert.equal(after.export?.status, "shipped");

    box.service.revokeConsent(consentId, "Dev Reviewer", "Actor revoked the likeness.");
    const blocked = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(blocked.ok, false);
    assert.ok(blocked.reasons.includes("consent_revoked"));
    assert.equal(box.service.projectView(projectId).export?.status, "blocked");
  } finally {
    cleanup(box.dir);
  }
});
