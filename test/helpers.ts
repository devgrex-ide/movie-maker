import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelAdapters, VideoModelAdapter } from "../src/adapters.js";
import { createMovieService, type MovieService } from "../src/service.js";
import type { RenderedTake, RenderTakeInput } from "../src/types.js";

export interface Harness {
  dir: string;
  dataDir: string;
  keysDir: string;
  service: MovieService;
  renders: { count: number };
  now: Date;
  setNow: (date: Date) => void;
}

export function harness(adapters?: Partial<ModelAdapters>): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "movie-maker-"));
  let now = new Date("2026-06-15T12:00:00.000Z");
  const renders = { count: 0 };
  const video = adapters?.video;
  const counting: VideoModelAdapter | undefined = video
    ? {
        id: video.id,
        measureReliableShotLengthMs: () => video.measureReliableShotLengthMs(),
        renderTake(input: RenderTakeInput): RenderedTake {
          renders.count += 1;
          return video.renderTake(input);
        },
      }
    : undefined;
  const dataDir = path.join(dir, "data");
  const keysDir = path.join(dir, "keystore");
  const service = createMovieService({
    dataDir,
    keysDir,
    now: () => now,
    adapters: { ...adapters, ...(counting ? { video: counting } : {}) },
  });
  return {
    dir,
    dataDir,
    keysDir,
    service,
    renders,
    get now() {
      return now;
    },
    setNow(date: Date) {
      now = date;
    },
  };
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function consentAdult(service: MovieService, projectId: string, legalName = "Inez Calder"): string {
  service.setTitle(projectId, "The Clock Room");
  const actorId = service.registerActor(legalName, "1984-03-03");
  service.verifyActor(actorId, "Dev Reviewer", "pass");
  return service.grantConsent(projectId, "Dev Reviewer", {
    actorId,
    slotIndex: 0,
    documentRef: "Counsel packet in the production safe, 2026-06-01",
    territories: ["United States"],
    termStart: "2026-06-01",
    termEnd: "2027-06-01",
    maxRuntimeMs: 90 * 60 * 1000,
  });
}

export const ADULT_STORY =
  "After the diner empties, Ruth stays through the winter and keeps the lights on for the regulars who still have nowhere else to sit.";
