export type ProjectStyle = "stylized";
export type ActorStatus = "unverified" | "verified" | "suspended";
export type ConsentStatus = "draft" | "active" | "expired" | "revoked" | "superseded";
export type PackageStatus = "ready" | "blocked_minor" | "blocked_depiction";
export type TakeDecision = "pending" | "accepted" | "rejected" | "unusable";
export type CutDecision = "pending" | "pass" | "fail";
export type GatePhase = "bind" | "schedule" | "take" | "export";

export type BlockReason =
  | "under_30_minutes"
  | "consent_missing"
  | "consent_not_active"
  | "consent_expired"
  | "consent_revoked"
  | "verification_missing"
  | "verification_failed"
  | "underage"
  | "reference_missing"
  | "reference_destroyed"
  | "runtime_below_minimum"
  | "depiction_denied"
  | "territory_denied"
  | "outside_term"
  | "document_missing"
  | "actor_approval_missing"
  | "training_forbidden"
  | "identity_incomplete"
  | "cut_check_required"
  | "cut_failed"
  | "minor"
  | "no_picture"
  | "package_blocked";

export interface DepictionFlags {
  violence: boolean;
  stunts: boolean;
  nudity: boolean;
}

export interface CastSlotInput {
  id: string;
  index: number;
  depictions: DepictionFlags;
  voiceAllowed: boolean;
}

export interface DialogueLine {
  id: string;
  sceneIndex: number;
  character: string;
  text: string;
}

export interface SceneBeat {
  index: number;
  act: number;
  heading: string;
  location: string;
  timeOfDay: string;
  action: string;
  want: string;
}

export interface ContinuityBible {
  style: "stylized";
  styleNote: string;
  wardrobe: string;
  light: string;
  screenDirection: string;
  props: string;
  rooms: string[];
  premise: string;
  ending: string;
}

export interface StoryJobInput {
  projectTitle: string;
  shortStory: string;
  slots: CastSlotInput[];
  reliableShotMs: number;
}

export interface StoryDraft {
  fullStory: string;
  script: string;
  screenplay: string;
  dialogue: DialogueLine[];
  scenes: SceneBeat[];
  bible: ContinuityBible;
  characters: { name: string; slotIndex: number }[];
  substitutions: { from: string; to: string }[];
}

export interface ShotSpec {
  sceneIndex: number;
  camera: string;
  action: string;
  targetMs: number;
  dialogueId: string | null;
  continuity: string;
  characterSlotIndexes: number[];
  depictions: DepictionFlags;
}

export interface ReferenceGrant {
  actorId: string;
  consentId: string;
  packId: string;
  token: string;
  plates: { view: string; bytes: Buffer }[];
  released: boolean;
  release(): void;
}

export interface RenderTakeInput {
  projectTitle: string;
  shotId: string;
  attempt: number;
  camera: string;
  action: string;
  durationMs: number;
  prompt: string;
  seed: string;
  characterNames: string[];
  grants: ReferenceGrant[];
}

export interface RenderedTake {
  svg: string;
  durationMs: number;
  identityToken: string;
  distance: number;
  method: string;
  model: string;
}

export interface SpeechRequest {
  text: string;
  /** Synthetic speech is built from no real person. Consented voice is a production adapter concern. */
  voice: "synthetic";
}

export interface SpeechResult {
  wav: Buffer;
  durationMs: number;
  model: string;
  voice: "synthetic";
}

export interface ScoreRequest {
  projectTitle: string;
  pictureMs: number;
  premise: string;
}

export interface ScoreResult {
  model: string;
  motif: string;
}

export interface GateDecision {
  ok: boolean;
  reason?: BlockReason;
  consentId?: string;
  actorId?: string;
  referencePackId?: string;
  message?: string;
}
