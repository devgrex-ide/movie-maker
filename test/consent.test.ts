import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MAX_PROJECTS, MAX_STORY_CHARS } from "../src/constants.js";
import { cleanup, consentAdult, harness, ADULT_STORY } from "./helpers.js";

function filesNamed(dir: string, name: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesNamed(full, name));
    else if (entry.name === name) found.push(full);
  }
  return found;
}

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
    const keys = filesNamed(box.keysDir, "key");
    assert.equal(keys.length, 1);
    assert.equal(filesNamed(box.dataDir, "key").length, 0);
    assert.equal(keys[0]?.startsWith(box.dataDir), false);
    box.service.submitStory(projectId, "Dev Reviewer", ADULT_STORY);
    assert.ok(box.service.schedule(projectId, "Dev Reviewer") > 0);
    box.service.revokeConsent(consentId, "Dev Reviewer", "The actor withdrew.");
    assert.equal(filesNamed(box.keysDir, "key").length, 0);
    box.service.runWorker(projectId);
    assert.equal(box.renders.count, 0);
    assert.equal(box.service.imageCount(projectId), 0);
    assert.throws(() => box.service.schedule(projectId, "Dev Reviewer"), /revoked/i);
    const exported = box.service.exportMaster(projectId, "Dev Reviewer");
    assert.equal(exported.ok, false);
    assert.ok(exported.reasons.includes("consent_revoked"));
    const db = new DatabaseSync(path.join(box.dataDir, "app.sqlite"));
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

test("registering an actor does not record a verification pass", () => {
  const box = harness();
  try {
    const projectId = box.service.createProject("");
    box.service.setTitle(projectId, "Separate Steps");
    const actorId = box.service.registerActor("Inez Calder", "1984-03-03");
    const actor = box.service.projectView(projectId).actors.find((item) => item.id === actorId);
    assert.equal(actor?.status, "unverified");
    assert.equal(actor?.verification, null);
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
        }),
      /verification/i,
    );
    const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.equal(client.includes('result: "pass"'), false);
    assert.equal(client.includes("x-principal"), false);
    assert.equal(server.includes("x-principal"), false);
    assert.equal(server.includes('? "fail" : "pass"'), false);
  } finally {
    cleanup(box.dir);
  }
});

test("project count and short-story length are capped", () => {
  const box = harness();
  try {
    for (let index = 0; index < MAX_PROJECTS; index += 1) box.service.createProject("");
    assert.throws(() => box.service.createProject(""), /projects/);
    const projectId = box.service.ensureWorkspace();
    box.service.setTitle(projectId, "Long Story");
    assert.throws(
      () => box.service.submitStory(projectId, "Dev Reviewer", "word ".repeat(MAX_STORY_CHARS)),
      /characters/,
    );
  } finally {
    cleanup(box.dir);
  }
});
