import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { cleanup, consentAdult, harness, ADULT_STORY } from "./helpers.js";

test("missing consent blocks schedule, generation, and export", () => {
  const box = harness({
    video: {
      id: "spy",
      measureReliableShotLengthMs: () => 6000,
      renderTake() {
        throw new Error("render without consent");
      },
    },
  });
  try {
    const projectId = box.service.createProject("");
    box.service.setTitle(projectId, "No Consent");
    const bare = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(bare.ok, false);
    assert.ok(bare.reasons.includes("consent_missing"));
    assert.ok(bare.reasons.includes("under_30_minutes"));
    box.service.submitStory(projectId, "Dev Reviewer", ADULT_STORY);
    assert.equal(box.service.imageCount(projectId), 0);
    assert.throws(() => box.service.schedule(projectId, "Dev Reviewer"), /consent/i);
    box.service.runWorker(projectId);
    assert.equal(box.renders.count, 0);
    assert.equal(box.service.imageCount(projectId), 0);
    const exported = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(exported.ok, false);
    assert.ok(exported.reasons.includes("consent_missing"));
    assert.equal(box.service.projectView(projectId).export?.status, "blocked");
  } finally {
    cleanup(box.dir);
  }
});

test("expired consent blocks schedule, generation, and export", () => {
  const box = harness({
    video: {
      id: "spy",
      measureReliableShotLengthMs: () => 6000,
      renderTake() {
        throw new Error("render on expired consent");
      },
    },
  });
  try {
    const projectId = box.service.createProject("");
    consentAdult(box.service, projectId);
    box.service.submitStory(projectId, "Dev Reviewer", ADULT_STORY);
    const queued = box.service.schedule(projectId, "Dev Reviewer");
    assert.ok(queued > 0);
    box.setNow(new Date("2028-01-01T00:00:00.000Z"));
    box.service.runWorker(projectId);
    assert.equal(box.renders.count, 0);
    assert.equal(box.service.imageCount(projectId), 0);
    assert.throws(() => box.service.schedule(projectId, "Dev Reviewer"), /expired/i);
    const exported = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(exported.ok, false);
    assert.ok(exported.reasons.includes("consent_expired"));
  } finally {
    cleanup(box.dir);
  }
});

test("revoked consent blocks schedule, generation, and export", () => {
  const box = harness({
    video: {
      id: "spy",
      measureReliableShotLengthMs: () => 6000,
      renderTake() {
        throw new Error("render on revoked consent");
      },
    },
  });
  try {
    const projectId = box.service.createProject("");
    const consentId = consentAdult(box.service, projectId);
    box.service.submitStory(projectId, "Dev Reviewer", ADULT_STORY);
    assert.ok(box.service.schedule(projectId, "Dev Reviewer") > 0);
    box.service.revokeConsent(consentId, "Dev Reviewer", "The actor withdrew.");
    box.service.runWorker(projectId);
    assert.equal(box.renders.count, 0);
    assert.equal(box.service.imageCount(projectId), 0);
    assert.throws(() => box.service.schedule(projectId, "Dev Reviewer"), /revoked/i);
    const exported = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(exported.ok, false);
    assert.ok(exported.reasons.includes("consent_revoked"));
    const db = new DatabaseSync(path.join(box.dir, "app.sqlite"));
    assert.throws(() => db.exec("UPDATE audit_event SET action = 'tamper'"));
    assert.throws(() => db.exec("DELETE FROM audit_event"));
    db.close();
  } finally {
    cleanup(box.dir);
  }
});

test("a minor cannot be verified and training cannot be switched on", () => {
  const box = harness();
  try {
    const projectId = box.service.createProject("");
    box.service.setTitle(projectId, "Adults Only");
    const childId = box.service.registerActor("Young Person", "2012-04-04");
    assert.throws(() => box.service.verifyActor(childId, "Dev Reviewer", "pass"), /under 18/);
    const actorId = box.service.registerActor("Inez Calder", "1984-03-03");
    box.service.verifyActor(actorId, "Dev Reviewer", "pass");
    assert.throws(
      () =>
        box.service.grantConsent(projectId, "Dev Reviewer", {
          actorId,
          slotIndex: 0,
          documentRef: "packet",
          territories: ["United States"],
          termStart: "2026-06-01",
          termEnd: "2027-06-01",
          maxRuntimeMs: 90 * 60 * 1000,
          allowTraining: true,
        }),
      /Training/,
    );
    assert.throws(
      () =>
        box.service.grantConsent(projectId, "Dev Reviewer", {
          actorId,
          slotIndex: 0,
          documentRef: "packet",
          territories: ["United States"],
          termStart: "2026-06-01",
          termEnd: "2027-06-01",
          maxRuntimeMs: 20 * 60 * 1000,
        }),
      /30 minutes/,
    );
  } finally {
    cleanup(box.dir);
  }
});
