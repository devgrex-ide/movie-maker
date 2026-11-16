const REASONS = {
  under_30_minutes: "Picture is under 30 minutes. Export is refused.",
  consent_missing: "Consent is missing. A face cannot be scheduled, generated, or exported.",
  consent_not_active: "Consent is not active.",
  consent_expired: "Consent is expired. The cut that depends on it is blocked.",
  consent_revoked: "Consent is revoked. Any cut that still contains this actor is blocked.",
  verification_missing: "Identity verification is missing.",
  verification_failed: "Identity verification has not passed.",
  underage: "A minor cannot be onboarded or depicted.",
  reference_missing: "The reference capture for this consent is missing.",
  reference_destroyed: "The reference pack was destroyed.",
  runtime_below_minimum: "This consent covers less than 30 minutes and cannot carry the film.",
  depiction_denied: "A depiction in the request is denied.",
  territory_denied: "Consent has no territory.",
  outside_term: "The consent term does not cover today.",
  document_missing: "The signed document reference is missing.",
  actor_approval_missing: "The actor still has to approve the finished likeness.",
  training_forbidden: "Training on a reference is refused.",
  identity_incomplete: "Identity review is still open on at least one take.",
  cut_check_required: "The cut check has not passed.",
  cut_failed: "The cut check failed. Marked shots return to generation. The film is not shortened.",
  minor: "The story needs a minor. The job stopped before any image.",
  no_picture: "There is no assembled picture yet.",
  package_blocked: "This package cannot be shot.",
};

const CONSENT_BLOCKS = new Set([
  "consent_missing",
  "consent_not_active",
  "consent_expired",
  "consent_revoked",
  "verification_missing",
  "verification_failed",
  "underage",
  "reference_missing",
  "reference_destroyed",
  "runtime_below_minimum",
  "document_missing",
  "territory_denied",
  "outside_term",
]);

const state = {
  projectId: "",
  view: "story",
  tab: "story",
  draft: "",
  data: null,
  error: "",
  notice: "",
  plates: [],
  playing: false,
  playhead: 0,
  timeline: null,
  poll: 0,
  generating: false,
  actorId: "",
  form: {},
  stalls: 0,
  lastRendered: -1,
};

const stage = document.querySelector("#stage");
const titleInput = document.querySelector("#title");
const viewerLabel = document.querySelector("#viewer");

titleInput.addEventListener("change", async () => {
  if (!state.projectId || !titleInput.value.trim() || state.data?.project?.titleLocked) return;
  try {
    await api(`/api/projects/${state.projectId}`, { method: "PATCH", body: { title: titleInput.value } });
    await refresh();
  } catch (error) {
    state.error = error.message;
    render();
  }
});

document.body.addEventListener("input", (event) => {
  if (event.target.id === "story") state.draft = event.target.value;
  rememberField(event.target);
});
document.body.addEventListener("change", (event) => {
  rememberField(event.target);
});

document.body.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]");
  if (view && event.target.closest("nav")) {
    state.view = view.dataset.view;
    state.error = "";
    state.notice = "";
    refresh().catch((error) => {
      state.error = error.message || "Could not load that page.";
      render();
    });
    return;
  }
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    render();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (!action) return;
  handle(action.dataset.action, action);
});

document.addEventListener("keydown", (event) => {
  if (state.view !== "identity") return;
  if (event.target.matches("input, textarea")) return;
  if (event.key === "a" || event.key === "A") handle("accept");
  if (event.key === "r" || event.key === "R") handle("reject");
});

boot();

async function boot() {
  const me = await api("/api/me");
  viewerLabel.textContent = me.simulated ? `${me.name} · simulated locally` : me.name;
  const workspace = await api("/api/workspace");
  state.projectId = workspace.projectId;
  await refresh();
}

async function refresh() {
  const active = document.activeElement;
  const typing = Boolean(active && active.matches && active.matches("input, textarea, select"));
  state.data = await api(`/api/projects/${state.projectId}`);
  if (active !== titleInput) titleInput.value = state.data.project.title ?? "";
  titleInput.disabled = Boolean(state.data.project.titleLocked);
  paintMeter();
  if (state.view === "cut") state.timeline = await api(`/api/projects/${state.projectId}/timeline`);
  if (state.view === "identity" && !typing) await loadPlates();
  if (!typing) render();
  const progress = state.data.progress;
  if (state.generating) {
    if (progress.rendered === state.lastRendered) state.stalls += 1;
    else state.stalls = 0;
    state.lastRendered = progress.rendered;
    if ((progress.shots > 0 && progress.rendered >= progress.shots) || state.stalls >= 8) state.generating = false;
  }
  clearInterval(state.poll);
  if (state.generating) state.poll = setInterval(() => { refresh().catch(() => {}); }, 600);
}

function paintMeter() {
  const picture = state.data?.progress?.pictureMs ?? 0;
  const floor = state.data?.project?.floorMs ?? 1800000;
  document.querySelector("#meter-clock").textContent = clock(picture);
  document.querySelector("#meter-fill").style.width = `${Math.min(100, (picture / floor) * 100)}%`;
}

function snapshotConsent() {
  if (state.view !== "consent") return;
  for (const el of document.querySelectorAll("#stage input, #stage select, #stage textarea")) {
    if (!el.id) continue;
    state.form[el.id] = el.type === "checkbox" ? el.checked : el.value;
  }
}

async function handle(action) {
  snapshotConsent();
  state.error = "";
  state.notice = "";
  try {
    if (action === "story") {
      await saveTitle();
      const text = document.querySelector("#story").value;
      const result = await api(`/api/projects/${state.projectId}/story`, { method: "POST", body: { text } });
      state.notice = result.blocked
        ? `Stopped before any image. ${reasonText(result.reasons[0])} Images written: ${result.imagesWritten}.`
        : "The package is written. Reading it is not an approval, and there is no rewrite.";
      state.view = "package";
    }
    if (action === "slots") {
      const count = Number(document.querySelector("#slots").value);
      await api(`/api/projects/${state.projectId}`, { method: "PATCH", body: { slotCount: count } });
    }
    if (action === "new-project") {
      const created = await api("/api/projects", { method: "POST", body: { title: "" } });
      state.projectId = created.projectId;
      state.view = "story";
    }
    if (action === "register-actor") {
      const actor = await api("/api/actors", {
        method: "POST",
        body: {
          legalName: value("#legal-name"),
          dob: value("#dob"),
        },
      });
      state.actorId = actor.actorId;
      state.notice = "Adult registered. Verification is a separate record. Nothing was marked passed.";
    }
    if (action === "record-verification") {
      const actorId = value("#verify-actor") || state.actorId;
      const result = value("#verify-result");
      if (result !== "pass" && result !== "fail") throw new Error("Choose pass or fail. Verification is not recorded until you do.");
      await api(`/api/actors/${actorId}/verify`, { method: "POST", body: { result } });
      state.notice = result === "pass"
        ? "In-person verification recorded as pass. Consent is still a separate step."
        : "In-person verification recorded as fail. Consent cannot become active.";
    }
    if (action === "activate-consent") {
      await saveTitle();
      const actorId = value("#consent-actor") || state.actorId;
      await api(`/api/projects/${state.projectId}/consents`, {
        method: "POST",
        body: {
          actorId,
          slotIndex: Number(value("#slot-index") || 0),
          documentRef: value("#document-ref"),
          territories: value("#territories"),
          termStart: value("#term-start"),
          termEnd: value("#term-end"),
          maxRuntimeMinutes: Number(value("#max-runtime") || 90),
          allowViolence: checked("#allow-violence"),
          allowStunts: checked("#allow-stunts"),
          allowNudity: checked("#allow-nudity"),
          allowVoice: checked("#allow-voice"),
          allowTrailers: checked("#allow-trailers"),
          allowStills: checked("#allow-stills"),
          allowMarketing: checked("#allow-marketing"),
          trailerMaxSeconds: Number(value("#trailer-max") || 0),
          requireLikenessApproval: checked("#likeness-approval"),
          allowTraining: false,
          allowSublicense: false,
        },
      });
      state.notice = "Written consent is active and the reference capture is stored under that consent.";
    }
    if (action === "revoke") {
      const id = document.querySelector("#revoke-id").value;
      await api(`/api/consents/${id}/revoke`, { method: "POST", body: { reason: value("#revoke-reason") } });
      state.notice = "Consent revoked. The reference key is destroyed. Cuts that still contain this actor cannot export.";
    }
    if (action === "generate") {
      const result = await api(`/api/projects/${state.projectId}/generate`, { method: "POST", body: {} });
      state.generating = true;
      state.stalls = 0;
      state.lastRendered = -1;
      state.notice = `Picture is queued (${result.queued} shots). Generation runs on the worker.`;
      state.view = "identity";
    }
    if (action === "accept" || action === "reject") {
      const takeId = state.data?.review?.current?.takeId;
      if (!takeId) return;
      await api(`/api/takes/${takeId}/review`, {
        method: "POST",
        body: { decision: action === "accept" ? "accepted" : "rejected" },
      });
    }
    if (action === "pass-cut") await api(`/api/projects/${state.projectId}/cut`, { method: "POST", body: { decision: "pass" } });
    if (action === "fail-cut") {
      await api(`/api/projects/${state.projectId}/cut`, {
        method: "POST",
        body: { decision: "fail", note: value("#fail-note") },
      });
    }
    if (action === "export") {
      const result = await api(`/api/projects/${state.projectId}/export`, { method: "POST", body: {} });
      state.notice = result.ok
        ? `Master shipped. Picture ${clock(result.pictureMs)}.`
        : `Export refused. ${result.reasons.map(reasonText).join(" ")}`;
      state.view = "export";
    }
    if (action === "play") togglePlay();
    await refresh();
  } catch (error) {
    snapshotConsent();
    state.error = error.message || "That action failed.";
    render();
  }
}

function render() {
  document.querySelectorAll("nav [data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
  const data = state.data;
  if (!data) {
    stage.innerHTML = "";
    return;
  }
  const alerts = `${banner()}`;
  const views = {
    story: storyView(data),
    package: packageView(data),
    consent: consentView(data),
    identity: identityView(data),
    cut: cutView(),
    export: exportView(data),
  };
  stage.innerHTML = alerts + (views[state.view] ?? "");
  if (state.view === "cut") mountPlayer();
}

function storyView(data) {
  const locked = data.package?.status === "ready";
  return `<section class="panel">
    <h2 class="lede">A short story is the only writing you supply.</h2>
    <p class="sub">The model writes the full story, the script, the screenplay, the dialogue, and a shot list of at least 30 minutes. You do not approve that writing. A child in the source stops the job before any image exists.</p>
    <div class="row">
      <label>On-screen adults
        <input id="slots" type="number" min="1" max="4" value="${data.slots.length}" ${data.package ? "disabled" : ""} />
      </label>
      <button class="ghost" data-action="slots" ${data.package ? "disabled" : ""}>Set cast size</button>
    </div>
    <textarea id="story" ${locked ? "disabled" : ""} placeholder="The premise and the situation. A few minutes to read, not a script.">${esc(locked ? (data.story?.text ?? "") : state.draft)}</textarea>
    <div class="actions">
      <button class="primary" data-action="story" ${locked ? "disabled" : ""}>Write the package</button>
      <button class="ghost" data-action="new-project">New project</button>
    </div>
  </section>`;
}

function packageView(data) {
  const pkg = data.package;
  if (!pkg) return `<section class="panel"><h2 class="lede">No package yet.</h2><p class="sub">Submit a short story. The pages will land here for reading.</p></section>`;
  if (pkg.status !== "ready") {
    return `<section class="panel">
      <h2 class="lede">The job stopped.</h2>
      <div class="banner bad">${esc(reasonText(pkg.blockReason))} ${pkg.blockTerm ? `Matched “${esc(pkg.blockTerm)}”.` : ""} Images written: ${data.imagesWritten}.</div>
      <p class="sub">Submit a different story. This one will not be rewritten into a picture.</p>
    </section>`;
  }
  const body = {
    story: `<article class="paper">${esc(pkg.fullStory)}</article>`,
    script: `<article class="paper">${esc(pkg.script)}</article>`,
    screenplay: `<article class="paper screenplay">${esc(pkg.screenplay)}</article>`,
    dialogue: `<article class="paper">${esc(pkg.dialogue.map((line) => `${line.character}: ${line.text}`).join("\n\n"))}</article>`,
    shots: `<div class="shot-list">${pkg.shots.map((shot) => `<div class="shot"><strong>${esc(shot.camera)}</strong><span>${esc(shot.action)}</span><span>${clock(shot.targetMs)}</span></div>`).join("")}</div>`,
    continuity: `<article class="paper">${esc(JSON.stringify(pkg.bible, null, 2))}</article>`,
  }[state.tab] ?? "";
  const subs = pkg.substitutions?.length
    ? `<div class="banner">Public-figure names in the source were replaced and are not used as likenesses: ${pkg.substitutions.map((item) => `${esc(item.from)} → ${esc(item.to)}`).join("; ")}.</div>`
    : "";
  const generateBlocked = data.blockers.some((reason) => CONSENT_BLOCKS.has(reason));
  return `<section class="panel">
    <div class="banner">This package is for reading. It is not an approval, and there is no rewrite. A different film starts with a different short story.</div>
    ${subs}
    <div class="stats">
      <span>${pkg.shotCount} shots</span>
      <span>${clock(pkg.pictureTargetMs)} target</span>
      <span>longest ${clock(pkg.longestShotMs)}</span>
      <span>${esc(pkg.model)}</span>
    </div>
    <div class="tabs">
      ${["story", "script", "screenplay", "dialogue", "shots", "continuity"].map((tab) => `<button type="button" data-tab="${tab}" class="${state.tab === tab ? "active" : ""}">${tab}</button>`).join("")}
    </div>
    ${body}
    <div class="actions">
      <button class="primary" data-action="generate" ${generateBlocked ? "disabled" : ""}>Generate picture</button>
    </div>
    ${generateBlocked ? `<p class="sub">Generation waits on an active consent and a reference capture. ${data.blockers.filter((reason) => CONSENT_BLOCKS.has(reason)).map(reasonText).join(" ")}</p>` : `<p class="sub">Local takes are duration slates bound to the consent. The production path is the video adapter, behind the same gate.</p>`}
  </section>`;
}

function rememberField(el) {
  if (!el?.id || state.view !== "consent") return;
  state.form[el.id] = el.type === "checkbox" ? el.checked : el.value;
}

function field(id, fallback) {
  return Object.prototype.hasOwnProperty.call(state.form, id) ? state.form[id] : fallback;
}

function consentView(data) {
  const start = day(0);
  const end = day(365);
  const box = (id) => (field(id, false) ? "checked" : "");
  const verifyResult = field("verify-result", "");
  return `<section class="panel">
    <h2 class="lede">Consent is a record the actor can read.</h2>
    <p class="sub">In person, a reviewer confirms a government ID and the adult, then records the result. The ID image is not stored. Activation writes a reference capture under this consent. Training stays off. Nobody can bypass the gate.</p>
    <div class="form-grid">
      <label>Legal name<input id="legal-name" name="legal-name" type="text" autocomplete="name" placeholder="Legal name" value="${esc(field("legal-name", ""))}" /></label>
      <label>Date of birth<input id="dob" type="date" value="${esc(field("dob", "1990-01-15"))}" /></label>
      <label class="wide">Where the signed document lives<input id="document-ref" type="text" placeholder="Counsel packet, production safe" value="${esc(field("document-ref", ""))}" /></label>
      <label>Territories<input id="territories" type="text" value="${esc(field("territories", "United States"))}" /></label>
      <label>Cast slot<input id="slot-index" type="number" min="0" max="${Math.max(0, data.slots.length - 1)}" value="${esc(field("slot-index", "0"))}" /></label>
      <label>Term start<input id="term-start" type="date" value="${esc(field("term-start", start))}" /></label>
      <label>Term end<input id="term-end" type="date" value="${esc(field("term-end", end))}" /></label>
      <label>Maximum runtime (minutes)<input id="max-runtime" type="number" min="30" value="${esc(field("max-runtime", "90"))}" /></label>
      <label>Trailer cap (seconds)<input id="trailer-max" type="number" min="0" value="${esc(field("trailer-max", "0"))}" /></label>
      <label class="check"><input id="allow-violence" type="checkbox" ${box("allow-violence")} /> Violence</label>
      <label class="check"><input id="allow-stunts" type="checkbox" ${box("allow-stunts")} /> Stunts</label>
      <label class="check"><input id="allow-nudity" type="checkbox" ${box("allow-nudity")} /> Nudity, default denied</label>
      <label class="check"><input id="allow-voice" type="checkbox" ${box("allow-voice")} /> Actor voice may be synthesized</label>
      <label class="check"><input id="allow-trailers" type="checkbox" ${box("allow-trailers")} /> Trailers</label>
      <label class="check"><input id="allow-stills" type="checkbox" ${box("allow-stills")} /> Stills</label>
      <label class="check"><input id="allow-marketing" type="checkbox" ${box("allow-marketing")} /> Marketing</label>
      <label class="check"><input id="likeness-approval" type="checkbox" ${box("likeness-approval")} /> Actor must approve the finished likeness</label>
    </div>
    <p class="locked">Training denied. Sublicensing denied. Both stay off. The app does not check an ID image.</p>
    <div class="actions">
      <button class="primary" data-action="register-actor">Register adult</button>
    </div>
    <div class="row">
      <label>Actor<select id="verify-actor">${actorOptions(state.actorId)}</select></label>
      <label>In-person result<select id="verify-result"><option value="">Choose a result</option><option value="pass"${verifyResult === "pass" ? " selected" : ""}>Pass</option><option value="fail"${verifyResult === "fail" ? " selected" : ""}>Fail</option></select></label>
      <button data-action="record-verification">Record verification</button>
    </div>
    <div class="row">
      <label>Consent for<select id="consent-actor">${actorOptions(state.actorId)}</select></label>
      <button class="primary" data-action="activate-consent">Activate consent</button>
    </div>
    <div class="cards">${data.consents.map(consentCard).join("") || `<article class="card"><h3>No consent yet</h3><p>Export stays blocked until one is active.</p></article>`}</div>
    ${data.consents.some((consent) => consent.status === "active") ? `<div class="row">
      <label>Active consent<select id="revoke-id">${data.consents.filter((consent) => consent.status === "active").map((consent) => `<option value="${esc(consent.id)}">${esc(consent.id.slice(0, 8))} · slot</option>`).join("")}</select></label>
      <label>Reason<input id="revoke-reason" type="text" placeholder="Why this consent ends" /></label>
      <button class="danger" data-action="revoke">Revoke</button>
    </div>` : ""}
  </section>`;
}

function actorOptions(selected) {
  const actors = state.data?.actors ?? [];
  if (!actors.length) return `<option value="">Register an adult first</option>`;
  return actors
    .map((actor) => `<option value="${esc(actor.id)}"${actor.id === selected ? " selected" : ""}>${esc(actor.legalName)} · ${esc(actor.status)}${actor.verification ? ` · ${esc(actor.verification)}` : ""}</option>`)
    .join("");
}

function consentCard(consent) {
  const actor = state.data.actors.find((item) => item.id === consent.actorId);
  return `<article class="card">
    <h3>${esc(consent.status)} · v${consent.version}</h3>
    <p class="scope">${esc(actor?.legalName ?? "Adult")} · ${esc(consent.title)}<br />
    ${esc(consent.termStart.slice(0, 10))} → ${esc(consent.termEnd.slice(0, 10))}<br />
    ${esc(consent.territories.join(", "))} · max ${clock(consent.maxRuntimeMs)}<br />
    Violence ${onOff(consent.allowViolence)} · Stunts ${onOff(consent.allowStunts)} · Nudity ${onOff(consent.allowNudity)}<br />
    Voice ${onOff(consent.allowVoice)} · Training denied · Sublicense denied<br />
    Document: ${esc(consent.documentRef)}<br />
    Likeness approval ${consent.requireLikenessApproval ? (consent.likenessApprovedAt ? "recorded" : "still required") : "not required"}
    ${consent.revocationReason ? `<br />Revoked: ${esc(consent.revocationReason)}` : ""}</p>
  </article>`;
}

function identityView(data) {
  const current = data.review.current;
  const progress = data.progress;
  if (!current) {
    return `<section class="panel">
      <h2 class="lede">Identity review</h2>
      <p class="sub">${progress.accepted} accepted of ${progress.shots} shots. ${progress.rendered} rendered. The distance figure is a hint. It never accepts a take by itself.</p>
      <div class="banner">Each acceptance is one take, seen beside its reference. A stands for accept, R for reject, when this page is open.</div>
    </section>`;
  }
  return `<section class="panel">
    <h2 class="lede">Take beside the reference.</h2>
    <p class="sub">${data.review.pending} waiting. Hint: ${current.method} distance ${Number(current.distance).toFixed(2)}. You still choose.</p>
    <div class="split">
      <div>
        <p class="sub">Reference contact sheet</p>
        <div class="plates">${state.plates.map((url) => `<img alt="Reference plate" src="${url}" />`).join("")}</div>
      </div>
      <div>
        <div class="frame"><img alt="Take slate" src="/api/takes/${current.takeId}/frame" /></div>
        <p class="sub">${esc(current.camera)} · ${clock(current.durationMs)} · ${esc(current.action)}</p>
      </div>
    </div>
    <div class="actions">
      <button class="primary" data-action="accept">Accept face</button>
      <button class="danger" data-action="reject">Reject and retry</button>
    </div>
  </section>`;
}

function cutView() {
  const timeline = state.timeline;
  if (!timeline) return `<section class="panel"><p>Loading the cut.</p></section>`;
  return `<section class="panel player">
    <h2 class="lede">Watch the cut.</h2>
    <p class="sub">The player steps through real take durations. It does not freeze one frame to invent length. Picture on this timeline: ${clock(timeline.pictureMs)}. Floor: ${clock(timeline.floorMs)}. ${timeline.locked ? "Cut check passed." : "The cut is not locked."}</p>
    ${timeline.blockers.length ? `<div class="banner bad">${timeline.blockers.map(reasonText).join(" ")}</div>` : `<div class="banner ok">Nothing in the gate is blocking a master.</div>`}
    <div class="frame"><img id="player-frame" alt="Current shot" /></div>
    <div class="transport">
      <button class="primary" data-action="play">Play</button>
      <input id="scrub" type="range" min="0" max="${Math.max(timeline.pictureMs, 1)}" value="${state.playhead}" />
      <div class="timecode" id="timecode">${clock(state.playhead)} / ${clock(timeline.pictureMs)}</div>
    </div>
    <p id="shot-caption" class="sub"></p>
    <audio id="line-audio"></audio>
    <label>If you fail the cut, say what the picture missed<input id="fail-note" type="text" placeholder="Identity drift in the night room" /></label>
    <div class="actions">
      <button class="primary" data-action="pass-cut">Pass cut</button>
      <button class="ghost" data-action="fail-cut">Fail cut</button>
    </div>
  </section>`;
}

function exportView(data) {
  const reasons = data.blockers;
  return `<section class="panel">
    <h2 class="lede">The master ships at 30 minutes, or it ships nothing.</h2>
    <p class="sub">The exporter checks the exact take list: duration, active consent, identity, and the cut check. A revoked actor still inside the cut blocks it. There is no force-export.</p>
    <div class="cards">${reasons.length ? reasons.map((reason) => `<article class="card"><h3>${esc(reason)}</h3><p>${esc(reasonText(reason))}</p></article>`).join("") : `<article class="card"><h3>Clear</h3><p>The gate is open for this cut.</p></article>`}</div>
    <div class="actions"><button class="primary" data-action="export">Export master</button></div>
    ${data.export ? `<article class="card"><h3>Last attempt · ${esc(data.export.status)}</h3><p>${data.export.disclosure ? esc(data.export.disclosure) : esc((data.export.reasons || []).map(reasonText).join(" "))}</p>${data.export.status === "shipped" ? `<p><a href="/api/exports/${data.export.id}/manifest">Provenance manifest</a></p>` : ""}</article>` : ""}
  </section>`;
}

function mountPlayer() {
  const scrub = document.querySelector("#scrub");
  if (!scrub) return;
  scrub.addEventListener("input", () => {
    state.playing = false;
    state.playhead = Number(scrub.value);
    paintFrame();
  });
  paintFrame();
}

function togglePlay() {
  state.playing = !state.playing;
  if (!state.playing) return;
  let last = performance.now();
  const step = (now) => {
    if (!state.playing || !state.timeline) return;
    const delta = now - last;
    last = now;
    state.playhead = Math.min(state.timeline.pictureMs, state.playhead + delta);
    paintFrame();
    if (state.playhead >= state.timeline.pictureMs) {
      state.playing = false;
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let currentTake = "";
function paintFrame() {
  const frame = document.querySelector("#player-frame");
  const caption = document.querySelector("#shot-caption");
  const scrub = document.querySelector("#scrub");
  const code = document.querySelector("#timecode");
  const timeline = state.timeline;
  if (!frame || !timeline) return;
  const shot = timeline.frames.find((item) => state.playhead >= item.startMs && state.playhead < item.startMs + item.durationMs) ?? timeline.frames.at(-1);
  if (scrub) scrub.value = String(state.playhead);
  if (code) code.textContent = `${clock(state.playhead)} / ${clock(timeline.pictureMs)}`;
  if (!shot) {
    frame.removeAttribute("src");
    if (caption) caption.textContent = "No rendered takes on the timeline.";
    return;
  }
  if (frame.dataset.take !== shot.takeId) {
    frame.dataset.take = shot.takeId;
    frame.src = `/api/takes/${shot.takeId}/frame`;
  }
  if (caption) caption.textContent = `${shot.camera} · ${shot.action}`;
  if (shot.takeId !== currentTake) {
    currentTake = shot.takeId;
    const audio = document.querySelector("#line-audio");
    if (audio && shot.hasSpeech) {
      audio.src = `/api/takes/${shot.takeId}/speech`;
      audio.play().catch(() => {});
    }
  }
}

async function loadPlates() {
  state.plates.forEach((url) => URL.revokeObjectURL(url));
  state.plates = [];
  const current = state.data?.review?.current;
  if (!current) return;
  for (const packId of current.packIds) {
    for (const view of ["front", "three-quarter", "profile"]) {
      const response = await fetch(`/api/packs/${packId}/plates/${encodeURIComponent(view)}`);
      if (!response.ok) continue;
      const blob = await response.blob();
      state.plates.push(URL.createObjectURL(blob));
    }
  }
}

function banner() {
  if (state.error) return `<div class="banner bad">${esc(state.error)}</div>`;
  if (state.notice) return `<div class="banner ok">${esc(state.notice)}</div>`;
  return "";
}

function reasonText(reason) {
  return REASONS[reason] ?? reason ?? "Blocked.";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || (data.reasons || []).map(reasonText).join(" ") || "Request failed.";
    const error = new Error(message);
    error.reasons = data.reasons ?? [];
    throw error;
  }
  return data;
}

async function saveTitle() {
  if (state.data?.project?.titleLocked) return;
  await api(`/api/projects/${state.projectId}`, { method: "PATCH", body: { title: titleInput.value } });
}

function value(selector) {
  return document.querySelector(selector)?.value?.trim() ?? "";
}

function checked(selector) {
  return Boolean(document.querySelector(selector)?.checked);
}

function clock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function day(offset) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function onOff(value) {
  return value ? "allowed" : "denied";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
