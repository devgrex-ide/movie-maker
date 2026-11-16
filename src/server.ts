import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceError } from "./errors.js";
import { createMovieService, type ConsentDraft } from "./service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT ?? 4173);
const service = createMovieService({ dataDir: path.join(process.cwd(), "data") });
service.ensureWorkspace();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const principal = String(req.headers["x-principal"] ?? "");
    if (req.method === "GET" && url.pathname === "/api/workspace") {
      return json(res, 200, { projectId: service.ensureWorkspace() });
    }
    if (req.method === "POST" && url.pathname === "/api/projects") {
      const body = await readJson(req);
      const projectId = service.createProject(String(body.title ?? ""));
      return json(res, 201, { projectId });
    }

    const project = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (project && req.method === "GET") return json(res, 200, service.projectView(decodeURIComponent(project[1] ?? "")));
    if (project && req.method === "PATCH") {
      const id = decodeURIComponent(project[1] ?? "");
      const body = await readJson(req);
      if (typeof body.title === "string") service.setTitle(id, body.title);
      if (body.slotCount !== undefined) service.setSlotCount(id, Number(body.slotCount));
      return json(res, 200, service.projectView(id));
    }

    const story = url.pathname.match(/^\/api\/projects\/([^/]+)\/story$/);
    if (story && req.method === "POST") {
      const id = decodeURIComponent(story[1] ?? "");
      const body = await readJson(req);
      const result = service.submitStory(id, principal, String(body.text ?? ""));
      return json(res, result.blocked ? 200 : 201, result);
    }

    const generate = url.pathname.match(/^\/api\/projects\/([^/]+)\/generate$/);
    if (generate && req.method === "POST") {
      const id = decodeURIComponent(generate[1] ?? "");
      const queued = service.schedule(id, principal);
      setImmediate(() => {
        try {
          service.renderQueued(id);
        } catch (error) {
          console.error(error);
        }
      });
      return json(res, 202, { ok: true, queued });
    }

    const timeline = url.pathname.match(/^\/api\/projects\/([^/]+)\/timeline$/);
    if (timeline && req.method === "GET") return json(res, 200, service.timeline(decodeURIComponent(timeline[1] ?? "")));

    const cut = url.pathname.match(/^\/api\/projects\/([^/]+)\/cut$/);
    if (cut && req.method === "POST") {
      const id = decodeURIComponent(cut[1] ?? "");
      const body = await readJson(req);
      if (body.decision === "pass") service.passCut(id, principal);
      else service.failCut(id, principal, String(body.note ?? ""), Array.isArray(body.shotIds) ? body.shotIds.map(String) : []);
      return json(res, 200, service.projectView(id));
    }

    const exported = url.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
    if (exported && req.method === "POST") {
      const result = service.exportMaster(decodeURIComponent(exported[1] ?? ""), principal);
      return json(res, result.ok ? 201 : 409, result);
    }

    if (req.method === "POST" && url.pathname === "/api/actors") {
      const body = await readJson(req);
      const actorId = service.registerActor(String(body.legalName ?? ""), String(body.dob ?? ""));
      return json(res, 201, { actorId });
    }

    const verify = url.pathname.match(/^\/api\/actors\/([^/]+)\/verify$/);
    if (verify && req.method === "POST") {
      const body = await readJson(req);
      const result = body.result === "fail" ? "fail" : "pass";
      service.verifyActor(decodeURIComponent(verify[1] ?? ""), principal, result);
      return json(res, 200, { ok: true });
    }

    const consent = url.pathname.match(/^\/api\/projects\/([^/]+)\/consents$/);
    if (consent && req.method === "POST") {
      const id = decodeURIComponent(consent[1] ?? "");
      const body = await readJson(req);
      const draft: ConsentDraft = {
        actorId: String(body.actorId ?? ""),
        slotIndex: Number(body.slotIndex ?? 0),
        documentRef: String(body.documentRef ?? ""),
        territories: String(body.territories ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        termStart: String(body.termStart ?? ""),
        termEnd: String(body.termEnd ?? ""),
        maxRuntimeMs: Number(body.maxRuntimeMinutes ?? 90) * 60 * 1000,
        allowViolence: Boolean(body.allowViolence),
        allowStunts: Boolean(body.allowStunts),
        allowNudity: Boolean(body.allowNudity),
        allowTrailers: Boolean(body.allowTrailers),
        allowStills: Boolean(body.allowStills),
        allowMarketing: Boolean(body.allowMarketing),
        trailerMaxMs: Number(body.trailerMaxSeconds ?? 0) * 1000,
        allowVoice: Boolean(body.allowVoice),
        requireLikenessApproval: Boolean(body.requireLikenessApproval),
        allowTraining: Boolean(body.allowTraining),
        allowSublicense: Boolean(body.allowSublicense),
      };
      const consentId = service.grantConsent(id, principal, draft);
      return json(res, 201, { consentId });
    }

    const approve = url.pathname.match(/^\/api\/consents\/([^/]+)\/approve-likeness$/);
    if (approve && req.method === "POST") {
      service.approveLikeness(decodeURIComponent(approve[1] ?? ""), principal);
      return json(res, 200, { ok: true });
    }

    const revoke = url.pathname.match(/^\/api\/consents\/([^/]+)\/revoke$/);
    if (revoke && req.method === "POST") {
      const body = await readJson(req);
      service.revokeConsent(decodeURIComponent(revoke[1] ?? ""), principal, String(body.reason ?? ""));
      return json(res, 200, { ok: true });
    }

    const review = url.pathname.match(/^\/api\/takes\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const body = await readJson(req);
      const decision = body.decision === "rejected" ? "rejected" : "accepted";
      service.reviewTake(decodeURIComponent(review[1] ?? ""), principal, decision);
      return json(res, 200, { ok: true });
    }

    const frame = url.pathname.match(/^\/api\/takes\/([^/]+)\/frame$/);
    if (frame && req.method === "GET") {
      const file = service.readTakeFrame(decodeURIComponent(frame[1] ?? ""));
      res.writeHead(200, { "content-type": file.contentType, "cache-control": "no-store" });
      res.end(file.body);
      return;
    }

    const speech = url.pathname.match(/^\/api\/takes\/([^/]+)\/speech$/);
    if (speech && req.method === "GET") {
      const body = service.readTakeSpeech(decodeURIComponent(speech[1] ?? ""));
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
      res.end(body);
      return;
    }

    const plate = url.pathname.match(/^\/api\/packs\/([^/]+)\/plates\/([^/]+)$/);
    if (plate && req.method === "GET") {
      const body = service.readPlate(decodeURIComponent(plate[1] ?? ""), decodeURIComponent(plate[2] ?? ""), principal);
      const type = body.subarray(0, 80).toString("utf8").includes("<svg") ? "image/svg+xml" : "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
      return;
    }

    const manifest = url.pathname.match(/^\/api\/exports\/([^/]+)\/manifest$/);
    if (manifest && req.method === "GET") {
      const body = service.readManifest(decodeURIComponent(manifest[1] ?? ""));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }

    if (req.method === "GET") return serveStatic(url.pathname, res);
    json(res, 404, { ok: false, message: "Not found." });
  } catch (error) {
    if (error instanceof ServiceError) {
      json(res, error.status, { ok: false, reasons: error.reasons, message: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      json(res, 400, { ok: false, message: "The request body was not JSON." });
      return;
    }
    console.error(error);
    json(res, 500, { ok: false, message: "The server failed on that action." });
  }
});

server.listen(port, () => {
  console.log(`movie-maker listening on http://127.0.0.1:${port}`);
});

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(publicDir, requested));
  if (!file.startsWith(publicDir)) {
    json(res, 403, { ok: false, message: "Forbidden." });
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    json(res, 404, { ok: false, message: "Not found." });
    return;
  }
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}
