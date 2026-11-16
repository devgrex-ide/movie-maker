import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModelAdapters } from "./adapters.js";
import { appendAudit } from "./audit.js";
import { evaluateConsentGate, type GateConsent } from "./consent-gate.js";
import { DISCLOSURE_LABEL, MAX_PROJECTS, MAX_STORIES_PER_PROJECT, MAX_STORY_CHARS, MAX_TAKE_ATTEMPTS, PICTURE_FLOOR_MS } from "./constants.js";
import { openDatabase, type Db } from "./db.js";
import { assertPictureRuntime, compileShotList } from "./duration.js";
import { DurationError } from "./duration.js";
import { ServiceError } from "./errors.js";
import { sha256 } from "./hash.js";
import { LocalPictureAdapter } from "./local/picture.js";
import { LocalScoreAdapter } from "./local/score.js";
import { LocalSpeechAdapter } from "./local/speech.js";
import { LocalStoryAdapter } from "./local/story.js";
import { disclosureSvg } from "./local/mark.js";
import { probeDurationMs, renderStereoMix } from "./mix.js";
import { compileShotPrompt, promptViolation } from "./prompt.js";
import { findPublicFigures, scanForDeniedDepiction, scanForMinors } from "./scan.js";
import { ageOn, formatClock, isoNow } from "./time.js";
import type { BlockReason, DepictionFlags, DialogueLine, TakeDecision } from "./types.js";
import { Vault } from "./vault.js";

const UNCONSENTED_CEILING_MS = 4 * 60 * 60 * 1000;
const NONE: DepictionFlags = { violence: false, stunts: false, nudity: false };

interface ProjectRow {
  id: string;
  title: string;
  style: string;
  runtime_floor_ms: number;
  status: string;
  title_locked: number;
  reliable_shot_ms: number | null;
  created_at: string;
}

interface SlotRow {
  id: string;
  project_id: string;
  slot_index: number;
  allow_violence: number;
  allow_stunts: number;
  allow_nudity: number;
  voice_allowed: number;
  consent_id: string | null;
}

interface ActorRow {
  id: string;
  legal_name: string;
  dob: string;
  status: string;
  created_at: string;
}

interface ConsentRow {
  id: string;
  version: number;
  actor_id: string;
  project_id: string;
  title: string;
  slot_id: string | null;
  allow_violence: number;
  allow_stunts: number;
  allow_nudity: number;
  max_runtime_ms: number;
  territories: string;
  term_start: string;
  term_end: string;
  allow_trailers: number;
  allow_stills: number;
  allow_marketing: number;
  trailer_max_ms: number;
  allow_voice: number;
  allow_training: number;
  allow_sublicense: number;
  require_likeness_approval: number;
  likeness_approved_at: string | null;
  likeness_approved_by: string | null;
  document_ref: string;
  status: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
}

interface PackRow {
  id: string;
  actor_id: string;
  consent_id: string;
  phrase: string;
  status: string;
  token: string;
  created_at: string;
  destroyed_at: string | null;
}

interface PackageRow {
  id: string;
  project_id: string;
  short_story_id: string;
  version: number;
  status: string;
  block_reason: string | null;
  block_term: string | null;
  full_story: string | null;
  script: string | null;
  screenplay: string | null;
  dialogue_json: string | null;
  bible_json: string | null;
  characters_json: string | null;
  substitutions_json: string | null;
  model: string;
  hash: string | null;
  created_at: string;
}

interface ShotRow {
  id: string;
  scene_id: string;
  package_id: string;
  sort_index: number;
  camera: string;
  action: string;
  target_ms: number;
  dialogue_id: string | null;
  continuity: string;
  slot_indexes: string;
  status: string;
}

interface TakeRow {
  id: string;
  shot_id: string;
  project_id: string;
  attempt: number;
  model: string;
  prompt: string;
  prompt_hash: string;
  output_hash: string | null;
  reference_pack_ids: string;
  consent_ids: string;
  actor_ids: string;
  seed: string;
  clip_path: string | null;
  speech_path: string | null;
  duration_ms: number;
  identity_token: string;
  identity_distance: number | null;
  identity_method: string | null;
  reviewer: string | null;
  decision: string;
  usable: number;
  created_at: string;
}

interface CutRow {
  id: string;
  project_id: string;
  package_id: string;
  take_ids: string;
  picture_ms: number;
  reviewer: string | null;
  decision: string;
  note: string | null;
  created_at: string;
}

interface JobRow {
  id: string;
  project_id: string;
  shot_id: string;
  state: string;
  attempt: number;
  created_at: string;
}

export interface ConsentDraft {
  actorId: string;
  slotIndex: number;
  documentRef: string;
  territories: string[];
  termStart: string;
  termEnd: string;
  maxRuntimeMs: number;
  allowViolence?: boolean;
  allowStunts?: boolean;
  allowNudity?: boolean;
  allowTrailers?: boolean;
  allowStills?: boolean;
  allowMarketing?: boolean;
  trailerMaxMs?: number;
  allowVoice?: boolean;
  requireLikenessApproval?: boolean;
  allowTraining?: boolean;
  allowSublicense?: boolean;
}

export class MovieService {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly vault: Vault,
    private readonly adapters: ModelAdapters,
    private readonly now: () => Date,
  ) {}

  ensureWorkspace(): string {
    const existing = this.db.prepare(`SELECT id FROM project ORDER BY rowid DESC LIMIT 1`).get() as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    return this.createProject("");
  }

  createProject(title = ""): string {
    const existing = this.db.prepare(`SELECT COUNT(*) AS n FROM project`).get() as { n: number };
    if ((existing.n ?? 0) >= MAX_PROJECTS) {
      throw new ServiceError(409, [], `This installation holds at most ${MAX_PROJECTS} projects.`);
    }
    const id = randomUUID();
    const at = isoNow(this.now());
    this.db.prepare(
      `INSERT INTO project (id, title, style, runtime_floor_ms, status, title_locked, reliable_shot_ms, created_at)
       VALUES (?, ?, 'stylized', ?, 'open', 0, NULL, ?)`,
    ).run(id, title.trim(), PICTURE_FLOOR_MS, at);
    this.insertSlot(id, 0);
    return id;
  }

  setTitle(projectId: string, title: string): void {
    const project = this.mustProject(projectId);
    const next = title.trim();
    if (!next) throw new ServiceError(400, [], "The picture needs a title.");
    if (project.title_locked && project.title !== next) {
      throw new ServiceError(409, [], "The title is fixed. It was locked when the story or the consent was recorded.");
    }
    this.db.prepare(`UPDATE project SET title = ? WHERE id = ?`).run(next, projectId);
  }

  setSlotCount(projectId: string, count: number): void {
    if (!Number.isInteger(count) || count < 1 || count > 4) {
      throw new ServiceError(400, [], "This release holds one to four on-screen adults.");
    }
    this.mustProject(projectId);
    if (this.latestPackage(projectId)) {
      throw new ServiceError(409, [], "The cast envelope is fixed once a story package exists.");
    }
    const consents = this.db.prepare(`SELECT id FROM consent WHERE project_id = ?`).get(projectId) as
      | { id: string }
      | undefined;
    if (consents) {
      throw new ServiceError(409, [], "Slot count stays put once a consent is recorded.");
    }
    this.tx(() => {
      this.db.prepare(`DELETE FROM cast_slot WHERE project_id = ?`).run(projectId);
      for (let index = 0; index < count; index += 1) this.insertSlot(projectId, index);
    });
  }

  registerActor(legalName: string, dob: string): string {
    const name = legalName.trim();
    if (!name) throw new ServiceError(400, [], "Legal name is required on the actor record.");
    if (ageOn(dob, this.now()) < 0) throw new ServiceError(400, [], "Date of birth must be YYYY-MM-DD.");
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO actor (id, legal_name, dob, status, created_at) VALUES (?, ?, ?, 'unverified', ?)`,
    ).run(id, name, dob, isoNow(this.now()));
    return id;
  }

  verifyActor(actorId: string, principal: string, result: "pass" | "fail"): void {
    const reviewer = this.mustPrincipal(principal);
    const actor = this.mustActor(actorId);
    if (result !== "pass" && result !== "fail") {
      throw new ServiceError(400, [], "Verification result is pass or fail.");
    }
    const underage = ageOn(actor.dob, this.now()) < 18;
    const recorded = underage ? "fail" : result;
    this.db.prepare(
      `INSERT INTO verification (id, actor_id, method, reviewer, result, verified_at)
       VALUES (?, ?, 'in_person', ?, ?, ?)`,
    ).run(randomUUID(), actorId, reviewer, recorded, isoNow(this.now()));
    if (!underage && result === "pass") {
      this.db.prepare(`UPDATE actor SET status = 'verified' WHERE id = ?`).run(actorId);
    }
    appendAudit(this.db, {
      principal: reviewer,
      action: "verification.recorded",
      subject: `actor:${actorId}`,
      at: this.now(),
      payload: { actorId, method: "in_person", result: recorded, underage },
    });
    if (underage) {
      throw new ServiceError(409, ["underage"], "Verification refused. This release cannot onboard anyone under 18.");
    }
  }

  grantConsent(projectId: string, principal: string, draft: ConsentDraft): string {
    const reviewer = this.mustPrincipal(principal);
    const project = this.mustProject(projectId);
    if (!project.title.trim()) throw new ServiceError(400, [], "Set the picture title before consent.");
    if (draft.allowTraining) {
      throw new ServiceError(409, ["training_forbidden"], "Training on references is refused. There is no switch that turns it on.");
    }
    if (draft.allowSublicense) {
      throw new ServiceError(409, [], "Sublicensing is refused.");
    }
    const actor = this.mustActor(draft.actorId);
    if (ageOn(actor.dob, this.now()) < 18) {
      throw new ServiceError(409, ["underage"], "A minor cannot hold a consent on this film.");
    }
    const verification = this.latestVerification(actor.id);
    if (actor.status !== "verified" || verification?.result !== "pass") {
      throw new ServiceError(409, ["verification_failed"], "Activate consent only after a passed in-person verification.");
    }
    const documentRef = draft.documentRef.trim();
    if (!documentRef) throw new ServiceError(400, ["document_missing"], "Say where the signed document lives.");
    const territories = draft.territories.map((item) => item.trim()).filter(Boolean);
    if (territories.length === 0) throw new ServiceError(400, ["territory_denied"], "Name at least one territory.");
    const termStart = parseDay(draft.termStart, "start");
    const termEnd = parseDay(draft.termEnd, "end");
    if (this.now().getTime() < new Date(termStart).getTime() || this.now().getTime() > new Date(termEnd).getTime()) {
      throw new ServiceError(409, ["outside_term"], "The term has to cover today.");
    }
    if (draft.maxRuntimeMs < project.runtime_floor_ms) {
      throw new ServiceError(
        409,
        ["runtime_below_minimum"],
        "A consent under 30 minutes cannot be used on this film.",
      );
    }
    const slot = this.slots(projectId).find((item) => item.slot_index === draft.slotIndex);
    if (!slot) throw new ServiceError(400, [], "That cast slot is not on this project.");

    const consentId = randomUUID();
    const packId = randomUUID();
    const token = randomBytes(16).toString("hex");
    const phrase = `I consent to ${project.title} on ${draft.termStart}.`;
    const version =
      ((this.db.prepare(`SELECT COUNT(*) AS n FROM consent WHERE actor_id = ? AND project_id = ?`).get(actor.id, projectId) as { n: number }).n ?? 0) + 1;

    this.vault.capture({ actorId: actor.id, consentId, packId, token, phrase });
    try {
      this.tx(() => {
        this.db.prepare(
          `UPDATE consent SET status = 'superseded' WHERE slot_id = ? AND status = 'active'`,
        ).run(slot.id);
        this.db.prepare(
          `INSERT INTO consent (
            id, version, actor_id, project_id, title, slot_id,
            allow_violence, allow_stunts, allow_nudity, max_runtime_ms, territories, term_start, term_end,
            allow_trailers, allow_stills, allow_marketing, trailer_max_ms, allow_voice,
            allow_training, allow_sublicense, require_likeness_approval, likeness_approved_at, likeness_approved_by,
            document_ref, status, revoked_at, revocation_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, ?, 'active', NULL, NULL, ?)`,
        ).run(
          consentId,
          version,
          actor.id,
          projectId,
          project.title,
          slot.id,
          bit(draft.allowViolence),
          bit(draft.allowStunts),
          bit(draft.allowNudity),
          draft.maxRuntimeMs,
          JSON.stringify(territories),
          termStart,
          termEnd,
          bit(draft.allowTrailers),
          bit(draft.allowStills),
          bit(draft.allowMarketing),
          draft.trailerMaxMs ?? 0,
          bit(draft.allowVoice),
          bit(draft.requireLikenessApproval),
          documentRef,
          isoNow(this.now()),
        );
        this.db.prepare(
          `INSERT INTO reference_pack (id, actor_id, consent_id, phrase, status, token, created_at, destroyed_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`,
        ).run(packId, actor.id, consentId, phrase, token, isoNow(this.now()));
        this.db.prepare(
          `UPDATE cast_slot SET consent_id = ?, allow_violence = ?, allow_stunts = ?, allow_nudity = ?, voice_allowed = ? WHERE id = ?`,
        ).run(
          consentId,
          bit(draft.allowViolence),
          bit(draft.allowStunts),
          bit(draft.allowNudity),
          bit(draft.allowVoice),
          slot.id,
        );
        this.db.prepare(`UPDATE project SET title_locked = 1 WHERE id = ?`).run(projectId);
        appendAudit(this.db, {
          principal: reviewer,
          action: "consent.activated",
          subject: `consent:${consentId}`,
          at: this.now(),
          payload: { consentId, actorId: actor.id, projectId, version, packId },
        });
      });
    } catch (error) {
      this.vault.removePack(actor.id, packId);
      throw error;
    }
    return consentId;
  }

  approveLikeness(consentId: string, principal: string): void {
    const reviewer = this.mustPrincipal(principal);
    const consent = this.mustConsent(consentId);
    if (!consent.require_likeness_approval) {
      throw new ServiceError(409, [], "This consent does not ask the actor to approve the likeness.");
    }
    if (consent.status !== "active") {
      throw new ServiceError(409, ["consent_not_active"], "Likeness approval waits on an active consent.");
    }
    this.db.prepare(
      `UPDATE consent SET likeness_approved_at = ?, likeness_approved_by = ? WHERE id = ?`,
    ).run(isoNow(this.now()), reviewer, consentId);
    appendAudit(this.db, {
      principal: reviewer,
      action: "consent.likeness_approved",
      subject: `consent:${consentId}`,
      at: this.now(),
      payload: { consentId, actorId: consent.actor_id },
    });
  }

  revokeConsent(consentId: string, principal: string, reason: string): void {
    const reviewer = this.mustPrincipal(principal);
    const why = reason.trim();
    if (!why) throw new ServiceError(400, [], "Revocation needs a reason.");
    const consent = this.mustConsent(consentId);
    const at = isoNow(this.now());
    const actorConsents = this.db.prepare(`SELECT * FROM consent WHERE actor_id = ?`).all(consent.actor_id) as unknown as ConsentRow[];
    this.tx(() => {
      this.db.prepare(
        `UPDATE consent SET status = 'revoked', revoked_at = ?, revocation_reason = ? WHERE actor_id = ? AND status = 'active'`,
      ).run(at, why, consent.actor_id);
      this.db.prepare(
        `UPDATE reference_pack SET status = 'destroyed', destroyed_at = ? WHERE actor_id = ? AND status = 'active'`,
      ).run(at, consent.actor_id);
      const projects = new Set(actorConsents.map((item) => item.project_id));
      for (const projectId of projects) {
        this.db.prepare(`UPDATE job SET state = 'cancelled' WHERE project_id = ? AND state = 'queued'`).run(projectId);
      }
      appendAudit(this.db, {
        principal: reviewer,
        action: "consent.revoked",
        subject: `consent:${consent.id}`,
        at: this.now(),
        payload: { consentId: consent.id, actorId: consent.actor_id, at },
      });
    });
    this.vault.destroyActor(consent.actor_id);
    const takes = this.db.prepare(`SELECT id, actor_ids FROM take`).all() as unknown as { id: string; actor_ids: string }[];
    for (const take of takes) {
      const actors = parseJson<string[]>(take.actor_ids, []);
      if (actors.includes(consent.actor_id)) {
        this.db.prepare(`UPDATE take SET usable = 0, decision = 'unusable' WHERE id = ?`).run(take.id);
      }
    }
  }

  submitStory(projectId: string, principal: string, text: string): { packageId: string; blocked: boolean; reasons: BlockReason[]; term?: string; imagesWritten: number } {
    const submitter = this.mustPrincipal(principal);
    const project = this.mustProject(projectId);
    const raw = text.trim();
    if (raw.length < 8) throw new ServiceError(400, [], "Write a short story. A few sentences are enough.");
    if (raw.length > MAX_STORY_CHARS) {
      throw new ServiceError(400, [], `A short story can be at most ${MAX_STORY_CHARS} characters.`);
    }
    const priorStories = this.db.prepare(`SELECT COUNT(*) AS n FROM short_story WHERE project_id = ?`).get(projectId) as { n: number };
    if ((priorStories.n ?? 0) >= MAX_STORIES_PER_PROJECT) {
      throw new ServiceError(409, [], `This project holds at most ${MAX_STORIES_PER_PROJECT} short stories.`);
    }
    if (!project.title.trim()) throw new ServiceError(400, [], "Name the picture before submitting the story.");
    const ready = this.latestPackage(projectId);
    if (ready?.status === "ready") {
      throw new ServiceError(409, [], "A different film starts as a new project. This package is not rewritten here.");
    }

    const storyId = randomUUID();
    const storyHash = sha256(raw);
    this.db.prepare(
      `INSERT INTO short_story (id, project_id, raw_text, submitter, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(storyId, projectId, raw, submitter, storyHash, isoNow(this.now()));

    const minor = scanForMinors(raw);
    const sexual = scanForDeniedDepiction(raw);
    if (minor || sexual) {
      const reason: BlockReason = minor ? "minor" : "depiction_denied";
      const term = minor?.term ?? sexual?.term ?? "";
      const packageId = this.insertBlockedPackage(project, storyId, minor ? "blocked_minor" : "blocked_depiction", reason, term);
      appendAudit(this.db, {
        principal: submitter,
        action: "story.blocked",
        subject: `package:${packageId}`,
        at: this.now(),
        payload: { packageId, reason, term, imagesWritten: 0 },
      });
      return { packageId, blocked: true, reasons: [reason], term, imagesWritten: this.imageCount(projectId) };
    }

    const measured = this.measure(project);
    const slots = this.slots(projectId);
    const draft = this.adapters.story.writePackage({
      projectTitle: project.title,
      shortStory: raw,
      reliableShotMs: measured,
      slots: slots.map((slot) => ({
        id: slot.id,
        index: slot.slot_index,
        voiceAllowed: Boolean(slot.voice_allowed),
        depictions: {
          violence: Boolean(slot.allow_violence),
          stunts: Boolean(slot.allow_stunts),
          nudity: Boolean(slot.allow_nudity),
        },
      })),
    });

    const written = [draft.fullStory, draft.script, draft.screenplay, ...draft.dialogue.map((line) => line.text), ...draft.scenes.map((scene) => scene.action), ...draft.characters.map((character) => character.name)].join("\n");
    const writtenMinor = scanForMinors(written);
    const writtenSexual = scanForDeniedDepiction(written);
    const figures = findPublicFigures(written);
    if (writtenMinor || writtenSexual || figures.length > 0) {
      const reason: BlockReason = writtenMinor ? "minor" : "depiction_denied";
      const term = writtenMinor?.term ?? writtenSexual?.term ?? figures[0] ?? "";
      const packageId = this.insertBlockedPackage(project, storyId, writtenMinor ? "blocked_minor" : "blocked_depiction", reason, term);
      return { packageId, blocked: true, reasons: [reason], term, imagesWritten: this.imageCount(projectId) };
    }

    const ceiling = this.runtimeCeiling(projectId);
    let compiled;
    try {
      const dialogueIds = new Map<number, string[]>();
      for (const line of draft.dialogue) {
        const list = dialogueIds.get(line.sceneIndex) ?? [];
        list.push(line.id);
        dialogueIds.set(line.sceneIndex, list);
      }
      compiled = compileShotList({
        scenes: draft.scenes,
        dialogueIdsByScene: dialogueIds,
        bible: draft.bible,
        characterSlotIndexes: draft.characters.map((character) => character.slotIndex),
        reliableMs: measured,
        floorMs: project.runtime_floor_ms,
        ceilingMs: ceiling,
      });
    } catch (error) {
      if (error instanceof DurationError) {
        throw new ServiceError(409, [error.reason], error.message);
      }
      throw error;
    }

    const packageId = randomUUID();
    const hash = sha256(JSON.stringify({ fullStory: draft.fullStory, script: draft.script, screenplay: draft.screenplay, dialogue: draft.dialogue }));
    const version = ((this.db.prepare(`SELECT COUNT(*) AS n FROM story_package WHERE project_id = ?`).get(projectId) as { n: number }).n ?? 0) + 1;
    this.tx(() => {
      this.db.prepare(
        `INSERT INTO story_package (
          id, project_id, short_story_id, version, status, block_reason, block_term,
          full_story, script, screenplay, dialogue_json, bible_json, characters_json, substitutions_json,
          model, hash, created_at
        ) VALUES (?, ?, ?, ?, 'ready', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        packageId,
        projectId,
        storyId,
        version,
        draft.fullStory,
        draft.script,
        draft.screenplay,
        JSON.stringify(draft.dialogue),
        JSON.stringify(draft.bible),
        JSON.stringify(draft.characters),
        JSON.stringify(draft.substitutions),
        this.adapters.story.id,
        hash,
        isoNow(this.now()),
      );
      const sceneIds: string[] = [];
      for (const scene of draft.scenes) {
        const sceneId = randomUUID();
        sceneIds[scene.index] = sceneId;
        this.db.prepare(
          `INSERT INTO scene (id, package_id, sort_index, act, location, time_of_day, excerpt, want) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(sceneId, packageId, scene.index, scene.act, scene.location, scene.timeOfDay, scene.action, scene.want);
      }
      draft.characters.forEach((character, index) => {
        const slot = slots.find((item) => item.slot_index === character.slotIndex);
        if (!slot) throw new ServiceError(500, [], "Cast slot missing for a character.");
        this.db.prepare(
          `INSERT INTO character_row (id, package_id, name, slot_id, sort_index) VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), packageId, character.name, slot.id, index);
      });
      compiled.shots.forEach((shot, index) => {
        const sceneId = sceneIds[shot.sceneIndex];
        if (!sceneId) throw new ServiceError(500, [], "Scene missing for a shot.");
        this.db.prepare(
          `INSERT INTO shot (id, scene_id, package_id, sort_index, camera, action, target_ms, dialogue_id, continuity, slot_indexes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
        ).run(
          randomUUID(),
          sceneId,
          packageId,
          index * 10,
          shot.camera,
          shot.action,
          shot.targetMs,
          shot.dialogueId,
          shot.continuity,
          JSON.stringify(shot.characterSlotIndexes),
        );
      });
      this.db.prepare(`UPDATE project SET title_locked = 1 WHERE id = ?`).run(projectId);
      appendAudit(this.db, {
        principal: submitter,
        action: "story.package",
        subject: `package:${packageId}`,
        at: this.now(),
        payload: { packageId, hash, shots: compiled.shots.length, pictureMs: compiled.pictureMs },
      });
    });
    return { packageId, blocked: false, reasons: [], imagesWritten: this.imageCount(projectId) };
  }

  /** Queue takes. Consent is checked here. No picture file is written in this step. */
  schedule(projectId: string, principal: string): number {
    const reviewer = this.mustPrincipal(principal);
    const pkg = this.requireReadyPackage(projectId);
    const shots = this.activeShots(pkg.id);
    if (shots.length === 0) throw new ServiceError(409, ["under_30_minutes"], "The shot list is empty.");
    for (const slot of this.slots(projectId)) {
      const bound = this.gateSlot("bind", slot.id, NONE);
      if (!bound.ok && bound.reason) {
        throw new ServiceError(409, [bound.reason], bound.message ?? "Consent blocked the cast.");
      }
    }
    for (const shot of shots) {
      const decision = this.gateShot("schedule", projectId, shot);
      if (!decision.ok && decision.reason) {
        throw new ServiceError(409, [decision.reason], decision.message ?? "Consent blocked scheduling.");
      }
      const unsafe = promptViolation(shot.action);
      if (unsafe) {
        throw new ServiceError(409, ["depiction_denied"], `Shot text is refused (${unsafe}). No image was written.`);
      }
    }
    let queued = 0;
    this.tx(() => {
      for (const shot of shots) {
        const pending = this.db.prepare(
          `SELECT id FROM job WHERE shot_id = ? AND state = 'queued'`,
        ).get(shot.id) as { id: string } | undefined;
        const take = this.latestUsableTake(shot.id);
        if (pending || (take && (take.decision === "pending" || take.decision === "accepted"))) continue;
        const attempt = ((this.db.prepare(`SELECT COUNT(*) AS n FROM take WHERE shot_id = ?`).get(shot.id) as { n: number }).n ?? 0) + 1;
        this.db.prepare(
          `INSERT INTO job (id, project_id, shot_id, state, attempt, created_at) VALUES (?, ?, ?, 'queued', ?, ?)`,
        ).run(randomUUID(), projectId, shot.id, attempt, isoNow(this.now()));
        queued += 1;
      }
      appendAudit(this.db, {
        principal: reviewer,
        action: "picture.scheduled",
        subject: `project:${projectId}`,
        at: this.now(),
        payload: { queued, packageId: pkg.id },
      });
    });
    return queued;
  }

  /** Worker. Each take checks consent again before the video adapter is called. */
  runWorker(projectId: string): void {
    for (;;) {
      const job = this.db.prepare(
        `SELECT * FROM job WHERE project_id = ? AND state = 'queued' ORDER BY rowid ASC LIMIT 1`,
      ).get(projectId) as JobRow | undefined;
      if (!job) return;
      try {
        this.processJob(job);
      } catch {
        this.db.prepare(`UPDATE job SET state = 'blocked' WHERE id = ?`).run(job.id);
      }
    }
  }

  renderQueued(projectId: string): void {
    this.runWorker(projectId);
    this.ensurePictureFloor(projectId);
    this.runWorker(projectId);
  }

  reviewTake(takeId: string, principal: string, decision: "accepted" | "rejected"): void {
    const reviewer = this.mustPrincipal(principal);
    if (decision !== "accepted" && decision !== "rejected") {
      throw new ServiceError(400, [], "Identity review accepts or rejects the take.");
    }
    const take = this.mustTake(takeId);
    if (take.decision !== "pending" || !take.usable) {
      throw new ServiceError(409, [], "This take is not waiting for identity review.");
    }
    if (decision === "accepted") {
      this.db.prepare(`UPDATE take SET decision = 'accepted', reviewer = ? WHERE id = ?`).run(reviewer, takeId);
      appendAudit(this.db, {
        principal: reviewer,
        action: "identity.accepted",
        subject: `take:${takeId}`,
        at: this.now(),
        payload: { takeId, distance: take.identity_distance, method: take.identity_method },
      });
      this.assemble(take.project_id);
      return;
    }
    this.db.prepare(`UPDATE take SET decision = 'rejected', usable = 0, reviewer = ? WHERE id = ?`).run(reviewer, takeId);
    appendAudit(this.db, {
      principal: reviewer,
      action: "identity.rejected",
      subject: `take:${takeId}`,
      at: this.now(),
      payload: { takeId },
    });
    const shot = this.mustShot(take.shot_id);
    if (take.attempt >= MAX_TAKE_ATTEMPTS) this.splitShot(shot);
    else this.enqueue(take.project_id, shot, take.attempt + 1);
  }

  passCut(projectId: string, principal: string): void {
    const reviewer = this.mustPrincipal(principal);
    const cut = this.latestCut(projectId);
    if (!cut) throw new ServiceError(409, ["cut_check_required"], "Assemble the cut before the check. Identity review fills it.");
    const takes = this.takesOn(cut);
    let picture = 0;
    for (const take of takes) {
      if (take.decision !== "accepted" || !take.usable) {
        throw new ServiceError(409, ["identity_incomplete"], "Every take in the cut needs an accepted identity review.");
      }
      picture += take.duration_ms;
      this.assertTakeExportable(projectId, take, picture);
    }
    try {
      assertPictureRuntime(picture, this.mustProject(projectId).runtime_floor_ms);
    } catch (error) {
      if (error instanceof DurationError) throw new ServiceError(409, ["under_30_minutes"], error.message);
      throw error;
    }
    this.db.prepare(`UPDATE cut SET decision = 'pass', reviewer = ?, picture_ms = ? WHERE id = ?`).run(reviewer, picture, cut.id);
    appendAudit(this.db, {
      principal: reviewer,
      action: "cut.pass",
      subject: `cut:${cut.id}`,
      at: this.now(),
      payload: { cutId: cut.id, pictureMs: picture },
    });
  }

  failCut(projectId: string, principal: string, note: string, shotIds: string[] = []): void {
    const reviewer = this.mustPrincipal(principal);
    const cut = this.latestCut(projectId);
    if (!cut) throw new ServiceError(409, ["cut_check_required"], "There is no cut to fail.");
    this.db.prepare(`UPDATE cut SET decision = 'fail', reviewer = ?, note = ? WHERE id = ?`).run(reviewer, note.trim(), cut.id);
    appendAudit(this.db, {
      principal: reviewer,
      action: "cut.fail",
      subject: `cut:${cut.id}`,
      at: this.now(),
      payload: { cutId: cut.id, shotIds },
    });
    for (const shotId of shotIds) {
      const shot = this.mustShot(shotId);
      const take = this.latestUsableTake(shot.id);
      if (!take) continue;
      this.db.prepare(`UPDATE take SET decision = 'rejected', usable = 0 WHERE id = ?`).run(take.id);
      if (take.attempt >= MAX_TAKE_ATTEMPTS) this.splitShot(shot);
      else this.enqueue(projectId, shot, take.attempt + 1);
    }
  }

  exportMaster(projectId: string, principal: string): { ok: boolean; exportId: string; reasons: BlockReason[]; pictureMs: number; disclosure?: string } {
    const reviewer = this.mustPrincipal(principal);
    const assessment = this.assess(projectId);
    const exportId = randomUUID();
    if (!assessment.ship) {
      this.db.prepare(
        `INSERT INTO export_row (id, project_id, cut_id, status, blocked_reason, reasons_json, picture_ms, consent_snapshot, disclosure, manifest_path, mix_path, created_at)
         VALUES (?, ?, ?, 'blocked', ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      ).run(
        exportId,
        projectId,
        assessment.cutId,
        assessment.reasons[0] ?? "under_30_minutes",
        JSON.stringify(assessment.reasons),
        assessment.pictureMs,
        assessment.snapshot,
        isoNow(this.now()),
      );
      appendAudit(this.db, {
        principal: reviewer,
        action: "export.blocked",
        subject: `export:${exportId}`,
        at: this.now(),
        payload: { exportId, reasons: assessment.reasons, pictureMs: assessment.pictureMs },
      });
      return { ok: false, exportId, reasons: assessment.reasons, pictureMs: assessment.pictureMs };
    }

    const cut = this.latestCut(projectId);
    if (!cut) throw new ServiceError(409, ["no_picture"], "Nothing to export.");
    const project = this.mustProject(projectId);
    const takes = this.takesOn(cut);
    const dir = path.join(this.dataDir, "exports", exportId);
    fs.mkdirSync(dir, { recursive: true });
    const disclosure = `${DISCLOSURE_LABEL}\n\nTitle: ${project.title}\nPicture: ${formatClock(assessment.pictureMs)}\nStyle: stylized\n`;
    fs.writeFileSync(path.join(dir, "disclosure.txt"), disclosure);
    fs.writeFileSync(path.join(dir, "disclosure.svg"), disclosureSvg(project.title, formatClock(assessment.pictureMs)));
    const score = this.adapters.score.compose({
      projectTitle: project.title,
      pictureMs: assessment.pictureMs,
      premise: project.title,
    });
    let cursor = 0;
    const dialogue: { path: string; startMs: number }[] = [];
    const provenanceTakes = takes.map((take) => {
      const entry = {
        takeId: take.id,
        shotId: take.shot_id,
        model: take.model,
        consentIds: parseJson<string[]>(take.consent_ids, []),
        referencePackIds: parseJson<string[]>(take.reference_pack_ids, []),
        promptHash: take.prompt_hash,
        outputHash: take.output_hash,
        seed: take.seed,
        durationMs: take.duration_ms,
        identityDecision: take.decision,
        reviewer: take.reviewer,
        speech: take.speech_path ? "synthetic" : "none",
        startMs: cursor,
      };
      if (take.speech_path) dialogue.push({ path: take.speech_path, startMs: cursor });
      cursor += take.duration_ms;
      return entry;
    });
    const manifest = {
      synthetic: true,
      label: DISCLOSURE_LABEL,
      pictureMs: assessment.pictureMs,
      style: "stylized",
      score: score.model,
      motif: score.motif,
      consentSnapshot: JSON.parse(assessment.snapshot),
      takes: provenanceTakes,
      standIn:
        "Local picture takes are rendered slates with real duration, consent binding, and an identity mark. They are not photographic faces.",
    };
    fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(dir, "timeline.json"),
      JSON.stringify({ pictureMs: assessment.pictureMs, takes: provenanceTakes.map((take) => ({ takeId: take.takeId, startMs: take.startMs, durationMs: take.durationMs })) }, null, 2),
    );
    const mixPath = path.join(dir, "mix.wav");
    renderStereoMix({ outPath: mixPath, durationMs: assessment.pictureMs, dialogue, motif: score.motif });
    const mixMs = probeDurationMs(mixPath);
    if (mixMs + 1500 < assessment.pictureMs) {
      fs.rmSync(dir, { recursive: true, force: true });
      const reasons: BlockReason[] = ["under_30_minutes"];
      this.db.prepare(
        `INSERT INTO export_row (id, project_id, cut_id, status, blocked_reason, reasons_json, picture_ms, consent_snapshot, disclosure, manifest_path, mix_path, created_at)
         VALUES (?, ?, ?, 'blocked', 'under_30_minutes', ?, ?, ?, NULL, NULL, NULL, ?)`,
      ).run(exportId, projectId, cut.id, JSON.stringify(reasons), mixMs, assessment.snapshot, isoNow(this.now()));
      return { ok: false, exportId, reasons, pictureMs: mixMs };
    }
    this.db.prepare(
      `INSERT INTO export_row (id, project_id, cut_id, status, blocked_reason, reasons_json, picture_ms, consent_snapshot, disclosure, manifest_path, mix_path, created_at)
       VALUES (?, ?, ?, 'shipped', NULL, '[]', ?, ?, ?, ?, ?, ?)`,
    ).run(
      exportId,
      projectId,
      cut.id,
      assessment.pictureMs,
      assessment.snapshot,
      disclosure,
      path.join(dir, "provenance.json"),
      mixPath,
      isoNow(this.now()),
    );
    appendAudit(this.db, {
      principal: reviewer,
      action: "export.shipped",
      subject: `export:${exportId}`,
      at: this.now(),
      payload: { exportId, pictureMs: assessment.pictureMs, mixMs, cutId: cut.id },
    });
    return { ok: true, exportId, reasons: [], pictureMs: assessment.pictureMs, disclosure };
  }

  projectView(projectId: string) {
    const project = this.mustProject(projectId);
    const slots = this.slots(projectId);
    const actors = this.db.prepare(`SELECT * FROM actor ORDER BY rowid ASC`).all() as unknown as ActorRow[];
    const consents = this.db.prepare(`SELECT * FROM consent WHERE project_id = ? ORDER BY rowid ASC`).all(projectId) as unknown as ConsentRow[];
    const story = this.db.prepare(`SELECT * FROM short_story WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`).get(projectId) as
      | { raw_text: string; submitter: string; hash: string }
      | undefined;
    const pkg = this.latestPackage(projectId);
    const assessment = this.assess(projectId);
    const shots = pkg?.status === "ready" ? this.activeShots(pkg.id) : [];
    const rendered = shots.filter((shot) => this.latestRendered(shot.id)).length;
    const accepted = shots.filter((shot) => this.latestAccepted(shot.id)).length;
    const pendingTake = this.nextPending(projectId);
    const cut = this.latestCut(projectId);
    const exported = this.db.prepare(`SELECT * FROM export_row WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`).get(projectId) as
      | { id: string; status: string; reasons_json: string; picture_ms: number | null; disclosure: string | null }
      | undefined;
    const pictureMs = this.renderedPictureMs(shots);
    return {
      project: {
        id: project.id,
        title: project.title,
        titleLocked: Boolean(project.title_locked),
        style: project.style,
        floorMs: project.runtime_floor_ms,
        reliableMs: project.reliable_shot_ms,
        status: project.status,
      },
      slots: slots.map((slot) => ({
        id: slot.id,
        index: slot.slot_index,
        consentId: slot.consent_id,
        voiceAllowed: Boolean(slot.voice_allowed),
        depictions: {
          violence: Boolean(slot.allow_violence),
          stunts: Boolean(slot.allow_stunts),
          nudity: Boolean(slot.allow_nudity),
        },
      })),
      actors: actors.map((actor) => ({
        id: actor.id,
        legalName: actor.legal_name,
        dob: actor.dob,
        status: actor.status,
        verification: this.latestVerification(actor.id)?.result ?? null,
      })),
      consents: consents.map((consent) => ({
        id: consent.id,
        version: consent.version,
        actorId: consent.actor_id,
        slotId: consent.slot_id,
        title: consent.title,
        status: consent.status,
        territories: parseJson<string[]>(consent.territories, []),
        termStart: consent.term_start,
        termEnd: consent.term_end,
        maxRuntimeMs: consent.max_runtime_ms,
        documentRef: consent.document_ref,
        allowViolence: Boolean(consent.allow_violence),
        allowStunts: Boolean(consent.allow_stunts),
        allowNudity: Boolean(consent.allow_nudity),
        allowVoice: Boolean(consent.allow_voice),
        allowTraining: false,
        allowSublicense: false,
        allowTrailers: Boolean(consent.allow_trailers),
        allowStills: Boolean(consent.allow_stills),
        allowMarketing: Boolean(consent.allow_marketing),
        trailerMaxMs: consent.trailer_max_ms,
        requireLikenessApproval: Boolean(consent.require_likeness_approval),
        likenessApprovedAt: consent.likeness_approved_at,
        revokedAt: consent.revoked_at,
        revocationReason: consent.revocation_reason,
      })),
      story: story ? { text: story.raw_text, submitter: story.submitter, hash: story.hash } : null,
      package: pkg
        ? {
            id: pkg.id,
            version: pkg.version,
            status: pkg.status,
            blockReason: pkg.block_reason,
            blockTerm: pkg.block_term,
            fullStory: pkg.full_story,
            script: pkg.script,
            screenplay: pkg.screenplay,
            dialogue: parseJson<DialogueLine[]>(pkg.dialogue_json ?? "[]", []),
            bible: parseJson(pkg.bible_json ?? "null", null),
            characters: parseJson(pkg.characters_json ?? "[]", []),
            substitutions: parseJson(pkg.substitutions_json ?? "[]", []),
            model: pkg.model,
            hash: pkg.hash,
            shotCount: shots.length,
            pictureTargetMs: shots.reduce((sum, shot) => sum + shot.target_ms, 0),
            longestShotMs: shots.reduce((max, shot) => Math.max(max, shot.target_ms), 0),
            shots: shots.map((shot) => ({
              id: shot.id,
              camera: shot.camera,
              action: shot.action,
              targetMs: shot.target_ms,
              sortIndex: shot.sort_index,
            })),
          }
        : null,
      progress: { shots: shots.length, rendered, accepted, pictureMs },
      cut: cut ? { id: cut.id, pictureMs: cut.picture_ms, decision: cut.decision, reviewer: cut.reviewer } : null,
      export: exported
        ? {
            id: exported.id,
            status: exported.status,
            reasons: parseJson<BlockReason[]>(exported.reasons_json, []),
            pictureMs: exported.picture_ms,
            disclosure: exported.disclosure,
          }
        : null,
      blockers: assessment.reasons,
      imagesWritten: this.imageCount(projectId),
      review: {
        pending: this.pendingCount(projectId),
        current: pendingTake
          ? {
              takeId: pendingTake.id,
              shotId: pendingTake.shot_id,
              distance: pendingTake.identity_distance,
              method: pendingTake.identity_method,
              packIds: parseJson<string[]>(pendingTake.reference_pack_ids, []),
              consentIds: parseJson<string[]>(pendingTake.consent_ids, []),
              camera: this.mustShot(pendingTake.shot_id).camera,
              action: this.mustShot(pendingTake.shot_id).action,
              durationMs: pendingTake.duration_ms,
            }
          : null,
      },
    };
  }

  timeline(projectId: string) {
    const project = this.mustProject(projectId);
    const pkg = this.latestPackage(projectId);
    const shots = pkg?.status === "ready" ? this.activeShots(pkg.id) : [];
    let start = 0;
    const frames = [];
    for (const shot of shots) {
      const take = this.latestRendered(shot.id);
      if (!take || !take.clip_path) continue;
      frames.push({
        takeId: take.id,
        shotId: shot.id,
        startMs: start,
        durationMs: take.duration_ms,
        camera: shot.camera,
        action: shot.action,
        decision: take.decision,
        hasSpeech: Boolean(take.speech_path),
      });
      start += take.duration_ms;
    }
    const cut = this.latestCut(projectId);
    return {
      floorMs: project.runtime_floor_ms,
      pictureMs: cut && cut.decision !== "fail" ? Math.max(cut.picture_ms, start) : start,
      locked: cut?.decision === "pass",
      blockers: this.assess(projectId).reasons,
      frames,
    };
  }

  readTakeSpeech(takeId: string): Buffer {
    const take = this.mustTake(takeId);
    if (!take.speech_path || !fs.existsSync(take.speech_path)) {
      throw new ServiceError(404, [], "This take has no dialogue.");
    }
    return fs.readFileSync(take.speech_path);
  }

  readTakeFrame(takeId: string): { body: Buffer; contentType: string } {
    const take = this.mustTake(takeId);
    if (!take.clip_path || !fs.existsSync(take.clip_path)) {
      throw new ServiceError(404, [], "This take has no picture.");
    }
    return { body: fs.readFileSync(take.clip_path), contentType: "image/svg+xml" };
  }

  readPlate(packId: string, view: string, principal: string): Buffer {
    const reviewer = this.mustPrincipal(principal);
    if (!["front", "three-quarter", "profile"].includes(view)) {
      throw new ServiceError(404, [], "Unknown plate.");
    }
    const pack = this.db.prepare(`SELECT * FROM reference_pack WHERE id = ?`).get(packId) as PackRow | undefined;
    if (!pack || pack.status !== "active") throw new ServiceError(404, ["reference_missing"], "Reference pack is not available.");
    appendAudit(this.db, {
      principal: reviewer,
      action: "reference.view",
      subject: `pack:${packId}`,
      at: this.now(),
      payload: { packId, view, actorId: pack.actor_id },
    });
    const bytes = this.vault.readPlate({ actorId: pack.actor_id, packId, view });
    if (!bytes) throw new ServiceError(404, ["reference_destroyed"], "Reference bytes are gone.");
    return bytes;
  }

  readManifest(exportId: string): Buffer {
    const row = this.db.prepare(`SELECT manifest_path, status FROM export_row WHERE id = ?`).get(exportId) as
      | { manifest_path: string | null; status: string }
      | undefined;
    if (!row?.manifest_path || row.status !== "shipped") {
      throw new ServiceError(404, [], "No shipped manifest.");
    }
    return fs.readFileSync(row.manifest_path);
  }

  imageCount(projectId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM take WHERE project_id = ? AND clip_path IS NOT NULL`,
    ).get(projectId) as { n: number };
    return row.n ?? 0;
  }

  listPrompts(projectId: string): string[] {
    const rows = this.db.prepare(`SELECT prompt FROM take WHERE project_id = ?`).all(projectId) as unknown as { prompt: string }[];
    return rows.map((row) => row.prompt);
  }

  private processJob(job: JobRow): void {
    const current = this.db.prepare(`SELECT state FROM job WHERE id = ?`).get(job.id) as { state: string } | undefined;
    if (!current || current.state !== "queued") return;
    const shot = this.mustShot(job.shot_id);
    const project = this.mustProject(job.project_id);
    const unsafe = promptViolation(`${shot.action}\n${shot.continuity}`);
    if (unsafe) {
      this.blockJob(job, "depiction_denied", unsafe);
      return;
    }
    const decision = this.gateShot("take", job.project_id, shot);
    if (!decision.ok && decision.reason) {
      this.blockJob(job, decision.reason, decision.message ?? decision.reason);
      return;
    }
    const existing = this.db.prepare(
      `SELECT id FROM take WHERE shot_id = ? AND attempt = ? AND clip_path IS NOT NULL`,
    ).get(shot.id, job.attempt) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE job SET state = 'done' WHERE id = ?`).run(job.id);
      return;
    }

    const bindings = this.bindingsForShot(job.project_id, shot);
    const grants = [];
    try {
      for (const binding of bindings) {
        grants.push(
          this.vault.openGrant({
            actorId: binding.actorId,
            consentId: binding.consentId,
            packId: binding.packId,
            token: binding.token,
          }),
        );
      }
      const names = this.characterNames(shot.package_id, parseJson<number[]>(shot.slot_indexes, []));
      const line = this.dialogueLine(shot);
      const prompt = compileShotPrompt({
        camera: shot.camera,
        action: shot.action,
        continuity: shot.continuity,
        durationMs: shot.target_ms,
        characterNames: names,
        line: line ? `${line.character}: ${line.text}` : null,
      });
      const violation = promptViolation(prompt);
      if (violation) {
        this.blockJob(job, "depiction_denied", violation);
        return;
      }
      const seed = sha256(`${shot.id}:${job.attempt}`);
      const rendered = this.adapters.video.renderTake({
        projectTitle: project.title,
        shotId: shot.id,
        attempt: job.attempt,
        camera: shot.camera,
        action: shot.action,
        durationMs: shot.target_ms,
        prompt,
        seed,
        characterNames: names,
        grants,
      });
      const reliable = project.reliable_shot_ms ?? this.adapters.video.measureReliableShotLengthMs();
      if (rendered.durationMs <= 0 || rendered.durationMs > reliable) {
        this.blockJob(job, "under_30_minutes", "The adapter returned a duration the compiler will not keep.");
        return;
      }
      const takeId = randomUUID();
      const clipDir = path.join(this.dataDir, "takes", job.project_id);
      fs.mkdirSync(clipDir, { recursive: true });
      const clipPath = path.join(clipDir, `${takeId}.svg`);
      const partial = `${clipPath}.partial`;
      fs.writeFileSync(partial, rendered.svg);
      fs.renameSync(partial, clipPath);
      let speechPath: string | null = null;
      if (line) {
        const spoken = this.adapters.speech.speak({ text: line.text, voice: "synthetic" });
        const speechDir = path.join(this.dataDir, "speech", job.project_id);
        fs.mkdirSync(speechDir, { recursive: true });
        speechPath = path.join(speechDir, `${takeId}.wav`);
        fs.writeFileSync(speechPath, spoken.wav);
      }
      this.db.prepare(
        `INSERT INTO take (
          id, shot_id, project_id, attempt, model, prompt, prompt_hash, output_hash,
          reference_pack_ids, consent_ids, actor_ids, seed, clip_path, speech_path, duration_ms,
          identity_token, identity_distance, identity_method, reviewer, decision, usable, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 1, ?)`,
      ).run(
        takeId,
        shot.id,
        job.project_id,
        job.attempt,
        rendered.model,
        prompt,
        sha256(prompt),
        sha256(rendered.svg),
        JSON.stringify(bindings.map((binding) => binding.packId)),
        JSON.stringify(bindings.map((binding) => binding.consentId)),
        JSON.stringify(bindings.map((binding) => binding.actorId)),
        seed,
        clipPath,
        speechPath,
        rendered.durationMs,
        rendered.identityToken,
        rendered.distance,
        rendered.method,
        isoNow(this.now()),
      );
      this.db.prepare(`UPDATE job SET state = 'done' WHERE id = ?`).run(job.id);
      appendAudit(this.db, {
        principal: "worker",
        action: "take.rendered",
        subject: `take:${takeId}`,
        at: this.now(),
        payload: {
          takeId,
          consentIds: bindings.map((binding) => binding.consentId),
          promptHash: sha256(prompt),
          outputHash: sha256(rendered.svg),
          model: rendered.model,
          durationMs: rendered.durationMs,
        },
      });
    } finally {
      for (const grant of grants) grant.release();
    }
  }

  private ensurePictureFloor(projectId: string): void {
    const project = this.mustProject(projectId);
    const pkg = this.latestPackage(projectId);
    if (!pkg || pkg.status !== "ready") return;
    const shots = this.activeShots(pkg.id);
    if (shots.length === 0 || shots.some((shot) => !this.latestRendered(shot.id))) return;
    let picture = 0;
    for (const shot of shots) picture += this.latestRendered(shot.id)?.duration_ms ?? 0;
    let gap = project.runtime_floor_ms - picture;
    if (gap <= 0) return;
    const reliable = project.reliable_shot_ms ?? LOCAL_FALLBACK;
    const sceneId = shots[0]?.scene_id;
    if (!sceneId) return;
    let sort = shots.reduce((max, shot) => Math.max(max, shot.sort_index), 0);
    const indexes = shots[0]?.slot_indexes ?? "[]";
    while (gap > 0) {
      const target = Math.min(reliable, gap);
      sort += 10;
      const shotId = randomUUID();
      this.db.prepare(
        `INSERT INTO shot (id, scene_id, package_id, sort_index, camera, action, target_ms, dialogue_id, continuity, slot_indexes, status)
         VALUES (?, ?, ?, ?, 'close', ?, ?, NULL, ?, ?, 'ready')`,
      ).run(
        shotId,
        sceneId,
        pkg.id,
        sort,
        "Coverage added so the picture reaches 30 minutes. Listening shot. The consented adult holds.",
        target,
        shots[0]?.continuity ?? "style stylized",
        indexes,
      );
      const shot = this.mustShot(shotId);
      const decision = this.gateShot("schedule", projectId, shot);
      if (!decision.ok) {
        this.db.prepare(`DELETE FROM shot WHERE id = ?`).run(shotId);
        return;
      }
      this.enqueue(projectId, shot, 1);
      gap -= target;
    }
  }

  private assemble(projectId: string): void {
    const pkg = this.requireReadyPackage(projectId);
    const shots = this.activeShots(pkg.id);
    const takeIds: string[] = [];
    let picture = 0;
    for (const shot of shots) {
      const take = this.latestAccepted(shot.id);
      if (!take) return;
      takeIds.push(take.id);
      picture += take.duration_ms;
    }
    if (takeIds.length === 0) return;
    this.db.prepare(
      `INSERT INTO cut (id, project_id, package_id, take_ids, picture_ms, reviewer, decision, note, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, ?)`,
    ).run(randomUUID(), projectId, pkg.id, JSON.stringify(takeIds), picture, isoNow(this.now()));
  }

  private splitShot(shot: ShotRow): void {
    const projectId = this.projectIdForShot(shot);
    const reliable = this.mustProject(projectId).reliable_shot_ms ?? LOCAL_FALLBACK;
    const first = Math.floor(shot.target_ms / 2);
    const second = shot.target_ms - first;
    if (first < 500 || second < 500 || first > reliable || second > reliable) return;
    this.db.prepare(`UPDATE shot SET status = 'split' WHERE id = ?`).run(shot.id);
    for (const [offset, target] of [[1, first], [2, second]] as const) {
      const id = randomUUID();
      this.db.prepare(
        `INSERT INTO shot (id, scene_id, package_id, sort_index, camera, action, target_ms, dialogue_id, continuity, slot_indexes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
      ).run(
        id,
        shot.scene_id,
        shot.package_id,
        shot.sort_index + offset,
        shot.camera,
        `${shot.action} Coverage ${offset} after a rejected take. Duration stays in the film.`,
        target,
        offset === 1 ? shot.dialogue_id : null,
        shot.continuity,
        shot.slot_indexes,
      );
      const child = this.mustShot(id);
      const decision = this.gateShot("schedule", projectId, child);
      if (!decision.ok) {
        this.db.prepare(`DELETE FROM shot WHERE id = ?`).run(id);
        continue;
      }
      this.enqueue(projectId, child, 1);
    }
  }

  private enqueue(projectId: string, shot: ShotRow, attempt: number): void {
    const pending = this.db.prepare(`SELECT id FROM job WHERE shot_id = ? AND state = 'queued'`).get(shot.id) as { id: string } | undefined;
    if (pending) return;
    this.db.prepare(
      `INSERT INTO job (id, project_id, shot_id, state, attempt, created_at) VALUES (?, ?, ?, 'queued', ?, ?)`,
    ).run(randomUUID(), projectId, shot.id, attempt, isoNow(this.now()));
  }

  private assess(projectId: string): { ship: boolean; reasons: BlockReason[]; pictureMs: number; cutId: string | null; snapshot: string } {
    const project = this.mustProject(projectId);
    const reasons: BlockReason[] = [];
    const pkg = this.latestPackage(projectId);
    if (pkg?.status === "blocked_minor") reasons.push("minor");
    if (pkg?.status === "blocked_depiction") reasons.push("depiction_denied");
    const slots = this.slots(projectId);
    if (slots.length === 0 || slots.some((slot) => !slot.consent_id)) reasons.push("consent_missing");
    for (const slot of slots) {
      const decision = this.gateSlot("export", slot.id, NONE);
      if (!decision.ok && decision.reason) reasons.push(decision.reason);
    }
    const cut = this.latestCut(projectId);
    let pictureMs = 0;
    if (!cut) {
      reasons.push("no_picture", "cut_check_required");
      const ready = this.latestPackage(projectId);
      const shots = ready?.status === "ready" ? this.activeShots(ready.id) : [];
      pictureMs = this.renderedPictureMs(shots);
      if (pictureMs < project.runtime_floor_ms) reasons.push("under_30_minutes");
      if (shots.length > 0 && shots.some((shot) => !this.latestAccepted(shot.id))) reasons.push("identity_incomplete");
    } else {
      pictureMs = cut.picture_ms;
      const takes = this.takesOn(cut);
      pictureMs = takes.reduce((sum, take) => sum + take.duration_ms, 0);
      if (pictureMs < project.runtime_floor_ms) reasons.push("under_30_minutes");
      if (cut.decision === "fail") reasons.push("cut_failed");
      else if (cut.decision !== "pass") reasons.push("cut_check_required");
      for (const take of takes) {
        if (!take.usable || take.decision === "unusable") reasons.push("consent_revoked");
        else if (take.decision !== "accepted") reasons.push("identity_incomplete");
        else {
          for (const consentId of parseJson<string[]>(take.consent_ids, [])) {
            const decision = this.gateConsentId("export", consentId, NONE, pictureMs);
            if (!decision.ok && decision.reason) reasons.push(decision.reason);
          }
        }
      }
    }
    const snapshot = JSON.stringify(
      (this.db.prepare(`SELECT id, actor_id, status, version, max_runtime_ms, term_end FROM consent WHERE project_id = ?`).all(projectId) as unknown as {
        id: string;
        actor_id: string;
        status: string;
        version: number;
        max_runtime_ms: number;
        term_end: string;
      }[]).map((row) => ({
        consentId: row.id,
        actorId: row.actor_id,
        status: row.status,
        version: row.version,
        maxRuntimeMs: row.max_runtime_ms,
        termEnd: row.term_end,
      })),
    );
    const unique = [...new Set(reasons)];
    return { ship: unique.length === 0, reasons: unique, pictureMs, cutId: cut?.id ?? null, snapshot };
  }

  private assertTakeExportable(projectId: string, take: TakeRow, pictureMs: number): void {
    for (const consentId of parseJson<string[]>(take.consent_ids, [])) {
      const decision = this.gateConsentId("export", consentId, NONE, pictureMs);
      if (!decision.ok && decision.reason) {
        throw new ServiceError(409, [decision.reason], decision.message ?? "Consent blocked the cut.");
      }
    }
    if (!take.usable) throw new ServiceError(409, ["consent_revoked"], "A take in this cut is unusable.");
  }

  private gateShot(phase: "bind" | "schedule" | "take" | "export", projectId: string, shot: ShotRow, pictureMs?: number) {
    const indexes = parseJson<number[]>(shot.slot_indexes, []);
    if (indexes.length === 0) {
      return { ok: false as const, reason: "consent_missing" as const, message: "The shot has no cast slot." };
    }
    const depictions = NONE;
    for (const index of indexes) {
      const slot = this.slots(projectId).find((item) => item.slot_index === index);
      if (!slot) return { ok: false as const, reason: "consent_missing" as const, message: "Cast slot missing." };
      const decision = this.gateSlot(phase, slot.id, depictions, pictureMs);
      if (!decision.ok) return decision;
    }
    return { ok: true as const };
  }

  private gateSlot(phase: "bind" | "schedule" | "take" | "export", slotId: string, depictions: DepictionFlags, pictureMs?: number) {
    const slot = this.db.prepare(`SELECT * FROM cast_slot WHERE id = ?`).get(slotId) as SlotRow | undefined;
    if (!slot?.consent_id) {
      return { ok: false as const, reason: "consent_missing" as const, message: "The cast slot has no consent." };
    }
    return this.gateConsentId(phase, slot.consent_id, depictions, pictureMs);
  }

  private gateConsentId(phase: "bind" | "schedule" | "take" | "export", consentId: string, depictions: DepictionFlags, pictureMs?: number) {
    const consent = this.db.prepare(`SELECT * FROM consent WHERE id = ?`).get(consentId) as ConsentRow | undefined;
    if (!consent) {
      return evaluateConsentGate({
        phase,
        now: this.now(),
        consent: null,
        actor: null,
        verification: null,
        pack: null,
        keyAlive: false,
        depictions,
        pictureMs,
      });
    }
    const actor = this.mustActor(consent.actor_id);
    const verification = this.latestVerification(actor.id);
    const pack = this.db.prepare(`SELECT * FROM reference_pack WHERE consent_id = ? ORDER BY rowid DESC LIMIT 1`).get(consent.id) as PackRow | undefined;
    return evaluateConsentGate({
      phase,
      now: this.now(),
      consent: toGateConsent(consent),
      actor: { id: actor.id, dob: actor.dob, status: actor.status },
      verification: verification ? { result: verification.result } : null,
      pack: pack ? { id: pack.id, status: pack.status, consentId: pack.consent_id } : null,
      keyAlive: this.vault.keyExists(actor.id),
      depictions,
      pictureMs,
    });
  }

  private bindingsForShot(projectId: string, shot: ShotRow): { actorId: string; consentId: string; packId: string; token: string }[] {
    const indexes = parseJson<number[]>(shot.slot_indexes, []);
    const bindings = [];
    for (const index of indexes) {
      const slot = this.slots(projectId).find((item) => item.slot_index === index);
      if (!slot?.consent_id) throw new ServiceError(409, ["consent_missing"], "Slot lost its consent.");
      const consent = this.mustConsent(slot.consent_id);
      const pack = this.db.prepare(`SELECT * FROM reference_pack WHERE consent_id = ? AND status = 'active' ORDER BY rowid DESC LIMIT 1`).get(consent.id) as PackRow | undefined;
      if (!pack) throw new ServiceError(409, ["reference_missing"], "Reference pack missing at take start.");
      bindings.push({ actorId: consent.actor_id, consentId: consent.id, packId: pack.id, token: pack.token });
    }
    return bindings;
  }

  private blockJob(job: JobRow, reason: BlockReason, detail: string): void {
    this.db.prepare(`UPDATE job SET state = 'blocked' WHERE id = ?`).run(job.id);
    appendAudit(this.db, {
      principal: "worker",
      action: "take.blocked",
      subject: `shot:${job.shot_id}`,
      at: this.now(),
      payload: { reason, detail, jobId: job.id },
    });
  }

  private measure(project: ProjectRow): number {
    if (project.reliable_shot_ms) return project.reliable_shot_ms;
    const measured = this.adapters.video.measureReliableShotLengthMs();
    this.db.prepare(`UPDATE project SET reliable_shot_ms = ? WHERE id = ?`).run(measured, project.id);
    this.db.prepare(
      `INSERT INTO calibration (id, project_id, model, measured_ms, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      project.id,
      this.adapters.video.id,
      measured,
      "Measured reliable shot length for this adapter. Calibration is not a film take and is not exported.",
      isoNow(this.now()),
    );
    return measured;
  }

  private runtimeCeiling(projectId: string): number {
    const rows = this.db.prepare(`SELECT max_runtime_ms, status FROM consent WHERE project_id = ? AND status = 'active'`).all(projectId) as unknown as { max_runtime_ms: number }[];
    if (rows.length === 0) return UNCONSENTED_CEILING_MS;
    return Math.min(...rows.map((row) => row.max_runtime_ms));
  }

  private insertBlockedPackage(project: ProjectRow, storyId: string, status: string, reason: BlockReason, term: string): string {
    const packageId = randomUUID();
    const version = ((this.db.prepare(`SELECT COUNT(*) AS n FROM story_package WHERE project_id = ?`).get(project.id) as { n: number }).n ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO story_package (
        id, project_id, short_story_id, version, status, block_reason, block_term,
        full_story, script, screenplay, dialogue_json, bible_json, characters_json, substitutions_json,
        model, hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?)`,
    ).run(packageId, project.id, storyId, version, status, reason, term, this.adapters.story.id, isoNow(this.now()));
    return packageId;
  }

  private characterNames(packageId: string, indexes: number[]): string[] {
    const rows = this.db.prepare(
      `SELECT character_row.name AS name, cast_slot.slot_index AS slot_index
       FROM character_row JOIN cast_slot ON cast_slot.id = character_row.slot_id
       WHERE character_row.package_id = ? ORDER BY character_row.sort_index ASC`,
    ).all(packageId) as unknown as { name: string; slot_index: number }[];
    return rows.filter((row) => indexes.includes(row.slot_index)).map((row) => row.name);
  }

  private dialogueLine(shot: ShotRow): DialogueLine | null {
    if (!shot.dialogue_id) return null;
    const pkg = this.db.prepare(`SELECT dialogue_json FROM story_package WHERE id = ?`).get(shot.package_id) as { dialogue_json: string | null } | undefined;
    const lines = parseJson<DialogueLine[]>(pkg?.dialogue_json ?? "[]", []);
    return lines.find((line) => line.id === shot.dialogue_id) ?? null;
  }

  private renderedPictureMs(shots: ShotRow[]): number {
    let picture = 0;
    for (const shot of shots) {
      const take = this.latestRendered(shot.id);
      if (take) picture += take.duration_ms;
    }
    return picture;
  }

  private pendingCount(projectId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM take WHERE project_id = ? AND decision = 'pending' AND usable = 1`,
    ).get(projectId) as { n: number };
    return row.n ?? 0;
  }

  private nextPending(projectId: string): TakeRow | undefined {
    return this.db.prepare(
      `SELECT * FROM take WHERE project_id = ? AND decision = 'pending' AND usable = 1 ORDER BY rowid ASC LIMIT 1`,
    ).get(projectId) as TakeRow | undefined;
  }

  private latestRendered(shotId: string): TakeRow | undefined {
    return this.db.prepare(
      `SELECT * FROM take WHERE shot_id = ? AND clip_path IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
    ).get(shotId) as TakeRow | undefined;
  }

  private latestAccepted(shotId: string): TakeRow | undefined {
    return this.db.prepare(
      `SELECT * FROM take WHERE shot_id = ? AND decision = 'accepted' AND usable = 1 ORDER BY rowid DESC LIMIT 1`,
    ).get(shotId) as TakeRow | undefined;
  }

  private latestUsableTake(shotId: string): TakeRow | undefined {
    return this.db.prepare(
      `SELECT * FROM take WHERE shot_id = ? AND usable = 1 ORDER BY rowid DESC LIMIT 1`,
    ).get(shotId) as TakeRow | undefined;
  }

  private takesOn(cut: CutRow): TakeRow[] {
    const ids = parseJson<string[]>(cut.take_ids, []);
    return ids.map((id) => this.mustTake(id));
  }

  private activeShots(packageId: string): ShotRow[] {
    return this.db.prepare(
      `SELECT * FROM shot WHERE package_id = ? AND status != 'split' ORDER BY sort_index ASC, rowid ASC`,
    ).all(packageId) as unknown as ShotRow[];
  }

  private latestPackage(projectId: string): PackageRow | undefined {
    return this.db.prepare(`SELECT * FROM story_package WHERE project_id = ? ORDER BY version DESC LIMIT 1`).get(projectId) as PackageRow | undefined;
  }

  private requireReadyPackage(projectId: string): PackageRow {
    const pkg = this.latestPackage(projectId);
    if (!pkg) throw new ServiceError(409, ["package_blocked"], "Submit a short story first.");
    if (pkg.status !== "ready") {
      throw new ServiceError(409, [pkg.block_reason === "minor" ? "minor" : "package_blocked"], "This package cannot be shot.");
    }
    return pkg;
  }

  private latestCut(projectId: string): CutRow | undefined {
    return this.db.prepare(`SELECT * FROM cut WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`).get(projectId) as CutRow | undefined;
  }

  private latestVerification(actorId: string): { result: string } | undefined {
    return this.db.prepare(`SELECT result FROM verification WHERE actor_id = ? ORDER BY rowid DESC LIMIT 1`).get(actorId) as { result: string } | undefined;
  }

  private slots(projectId: string): SlotRow[] {
    return this.db.prepare(`SELECT * FROM cast_slot WHERE project_id = ? ORDER BY slot_index ASC`).all(projectId) as unknown as SlotRow[];
  }

  private insertSlot(projectId: string, index: number): void {
    this.db.prepare(
      `INSERT INTO cast_slot (id, project_id, slot_index, allow_violence, allow_stunts, allow_nudity, voice_allowed, consent_id)
       VALUES (?, ?, ?, 0, 0, 0, 0, NULL)`,
    ).run(randomUUID(), projectId, index);
  }

  private mustProject(id: string): ProjectRow {
    const row = this.db.prepare(`SELECT * FROM project WHERE id = ?`).get(id) as ProjectRow | undefined;
    if (!row) throw new ServiceError(404, [], "Project not found.");
    return row;
  }

  private mustActor(id: string): ActorRow {
    const row = this.db.prepare(`SELECT * FROM actor WHERE id = ?`).get(id) as ActorRow | undefined;
    if (!row) throw new ServiceError(404, [], "Actor not found.");
    return row;
  }

  private mustConsent(id: string): ConsentRow {
    const row = this.db.prepare(`SELECT * FROM consent WHERE id = ?`).get(id) as ConsentRow | undefined;
    if (!row) throw new ServiceError(404, [], "Consent not found.");
    return row;
  }

  private mustShot(id: string): ShotRow & { projectId: (fallback: string) => string } {
    const row = this.db.prepare(`SELECT * FROM shot WHERE id = ?`).get(id) as ShotRow | undefined;
    if (!row) throw new ServiceError(404, [], "Shot not found.");
    const projectId = this.projectIdForShot(row);
    return Object.assign(row, { projectId: () => projectId });
  }

  private projectIdForShot(shot: ShotRow): string {
    const row = this.db.prepare(`SELECT project_id FROM story_package WHERE id = ?`).get(shot.package_id) as { project_id: string } | undefined;
    if (!row) throw new ServiceError(404, [], "Package not found for shot.");
    return row.project_id;
  }

  private mustTake(id: string): TakeRow {
    const row = this.db.prepare(`SELECT * FROM take WHERE id = ?`).get(id) as TakeRow | undefined;
    if (!row) throw new ServiceError(404, [], "Take not found.");
    return row;
  }

  private mustPrincipal(principal: string): string {
    const name = principal.trim();
    if (!name) throw new ServiceError(400, [], "A named person has to stand on this action.");
    return name;
  }

  private tx(run: () => void): void {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const LOCAL_FALLBACK = 6000;

function bit(value: boolean | undefined): number {
  return value ? 1 : 0;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseDay(value: string, bound: "start" | "end"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new ServiceError(400, ["outside_term"], "Dates are YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, bound === "end" ? 23 : 0, bound === "end" ? 59 : 0, bound === "end" ? 59 : 0));
  if (Number.isNaN(date.getTime())) throw new ServiceError(400, ["outside_term"], "That date is not real.");
  return date.toISOString();
}

function toGateConsent(row: ConsentRow): GateConsent {
  return {
    id: row.id,
    actorId: row.actor_id,
    projectId: row.project_id,
    slotId: row.slot_id,
    status: row.status,
    termStart: row.term_start,
    termEnd: row.term_end,
    territories: parseJson<string[]>(row.territories, []),
    maxRuntimeMs: row.max_runtime_ms,
    allowViolence: Boolean(row.allow_violence),
    allowStunts: Boolean(row.allow_stunts),
    allowNudity: Boolean(row.allow_nudity),
    allowTraining: Boolean(row.allow_training),
    requireLikenessApproval: Boolean(row.require_likeness_approval),
    likenessApprovedAt: row.likeness_approved_at,
    documentRef: row.document_ref,
  };
}

export function createMovieService(options: {
  dataDir: string;
  /** Actor keys. Must not be the directory that holds app.sqlite. */
  keysDir: string;
  now?: () => Date;
  adapters?: Partial<ModelAdapters>;
}): MovieService {
  fs.mkdirSync(options.dataDir, { recursive: true });
  const db = openDatabase(path.join(options.dataDir, "app.sqlite"));
  const adapters: ModelAdapters = {
    story: options.adapters?.story ?? new LocalStoryAdapter(),
    video: options.adapters?.video ?? new LocalPictureAdapter(),
    speech: options.adapters?.speech ?? new LocalSpeechAdapter(),
    score: options.adapters?.score ?? new LocalScoreAdapter(),
  };
  const vault = new Vault(path.join(options.dataDir, "vault"), options.keysDir);
  return new MovieService(db, options.dataDir, vault, adapters, options.now ?? (() => new Date()));
}
