import { PICTURE_FLOOR_MS } from "./constants.js";
import { ageOn } from "./time.js";
import type { BlockReason, DepictionFlags, GateDecision, GatePhase } from "./types.js";

export interface GateConsent {
  id: string;
  actorId: string;
  projectId: string;
  slotId: string | null;
  status: string;
  termStart: string;
  termEnd: string;
  territories: string[];
  maxRuntimeMs: number;
  allowViolence: boolean;
  allowStunts: boolean;
  allowNudity: boolean;
  allowTraining: boolean;
  requireLikenessApproval: boolean;
  likenessApprovedAt: string | null;
  documentRef: string;
}

export interface GateInput {
  phase: GatePhase;
  now: Date;
  consent: GateConsent | null;
  actor: { id: string; dob: string; status: string } | null;
  verification: { result: string } | null;
  pack: { id: string; status: string; consentId: string } | null;
  keyAlive: boolean;
  depictions: DepictionFlags;
  /** Measured picture on the cut. Export refuses a consent that cannot cover it. */
  pictureMs?: number;
}

/**
 * The only consent decision. Schedule, take start, and export all call this.
 * There is no bypass argument and no staff role.
 */
export function evaluateConsentGate(input: GateInput): GateDecision {
  const consent = input.consent;
  if (!consent) {
    return block("consent_missing", "No written consent is on this cast slot.");
  }
  if (consent.allowTraining) {
    return block("training_forbidden", "Training on a reference is refused.");
  }
  if (consent.status === "revoked") {
    return block("consent_revoked", "Consent is revoked. This actor cannot remain in the cut.");
  }
  if (consent.status === "expired") {
    return block("consent_expired", "Consent is expired.");
  }
  if (consent.status !== "active") {
    return block("consent_not_active", `Consent is ${consent.status}.`);
  }
  if (!consent.documentRef.trim()) {
    return block("document_missing", "The signed document reference is missing.");
  }
  if (consent.territories.length === 0) {
    return block("territory_denied", "Consent has no territory.");
  }

  const termStart = new Date(consent.termStart).getTime();
  const termEnd = new Date(consent.termEnd).getTime();
  const now = input.now.getTime();
  if (!Number.isFinite(termStart) || !Number.isFinite(termEnd)) {
    return block("outside_term", "Consent term is incomplete.");
  }
  if (now < termStart) return block("outside_term", "Consent term has not started.");
  if (now > termEnd) return block("consent_expired", "Consent is expired. The term has ended.");

  if (consent.maxRuntimeMs < PICTURE_FLOOR_MS) {
    return block(
      "runtime_below_minimum",
      "This consent covers less than 30 minutes and cannot be used on this film.",
    );
  }
  if (input.pictureMs !== undefined && input.pictureMs > consent.maxRuntimeMs) {
    return block(
      "runtime_below_minimum",
      "The picture is longer than this consent allows.",
    );
  }

  const actor = input.actor;
  if (!actor || actor.id !== consent.actorId) {
    return block("verification_missing", "The consented adult record is missing.");
  }
  if (ageOn(actor.dob, input.now) < 18) {
    return block("underage", "Only a verified adult can be depicted.");
  }
  if (actor.status !== "verified") {
    return block("verification_failed", "Identity verification has not passed.");
  }
  if (!input.verification || input.verification.result !== "pass") {
    return block(
      input.verification ? "verification_failed" : "verification_missing",
      "In-person verification has not passed.",
    );
  }

  const pack = input.pack;
  if (!pack || pack.consentId !== consent.id) {
    return block("reference_missing", "No reference capture is stored for this consent.");
  }
  if (pack.status !== "active" || !input.keyAlive) {
    return block("reference_destroyed", "The reference pack is gone.");
  }

  if (input.depictions.violence && !consent.allowViolence) {
    return block("depiction_denied", "Violence is not allowed on this consent.");
  }
  if (input.depictions.stunts && !consent.allowStunts) {
    return block("depiction_denied", "Stunts are not allowed on this consent.");
  }
  if (input.depictions.nudity && !consent.allowNudity) {
    return block("depiction_denied", "Nudity is denied on this consent.");
  }

  if (
    input.phase === "export" &&
    consent.requireLikenessApproval &&
    !consent.likenessApprovedAt
  ) {
    return block(
      "actor_approval_missing",
      "This consent requires the actor to approve the finished likeness before export.",
    );
  }

  return {
    ok: true,
    consentId: consent.id,
    actorId: consent.actorId,
    referencePackId: pack.id,
  };
}

function block(reason: BlockReason, message: string): GateDecision {
  return { ok: false, reason, message };
}
