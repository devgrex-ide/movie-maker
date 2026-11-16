# movie-maker

A local production tool. A person submits a short story. The app writes the full story, the script, the screenplay, and the dialogue, then a shot list whose durations sum to at least 30 minutes. Export is refused until that picture exists, every take has passed identity review, the cut check has passed, and each on-screen adult still has an active written consent with a reference capture from that consent.

Reading the package is not an approval. There is no rewrite desk. A different film starts as a new project.

This build is invite-only and stylized. It does not call an external generation API and it does not ask for an API key. Training on faces or references is refused and there is no control that turns it on.

## Run

```bash
npm install
npm start
```

Open http://127.0.0.1:4173

Verification, consent, identity review, the cut check, and export are recorded as the signed-in Cursor viewer. On this machine, before the app is published, that viewer is the simulated local person and the header says so. A typed name is not the reviewer.

1. Name the picture and submit a short story. A short story is at most 12,000 characters, and an installation holds at most 24 projects.
2. Read the package. Export is still refused.
3. On Consent, register an adult. Recording the in-person verification is a separate action: choose pass or fail. Consent stays inactive until a pass exists. Then record the document location and the scope. Activation stores the reference capture. The app does not check an ID image.
4. Generate picture. The worker renders a take per shot.
5. Identity: accept or reject each take beside its reference. A accepts, R rejects.
6. Cut check: play the timeline. Pass is legal only at 30 minutes with consent and identity still holding.
7. Export writes the disclosure, the provenance manifest, and a stereo mix. Revoke blocks any later export of a cut that still contains that actor.

```bash
npm test
```

## What is a stand-in

The local adapters are what actually run on this machine:

- **Story.** A deterministic writer turns the short story and the anonymous cast slots into the full story, script, screenplay, dialogue, scenes, and continuity bible. Public-figure names become fictional characters. A child in the source stops the job before any image.
- **Shots.** The duration compiler, not the writer, builds the shot list. No shot is longer than the measured reliable length (6 seconds for this stand-in). The targets sum to at least 30 minutes.
- **Picture.** Each take is an SVG slate: real duration, consent id, seed, and an identity mark derived from the reference token. It is not a photograph and not a reconstructed face.
- **Reference.** Capture plates are encrypted per actor with AES-256-GCM. The ciphertext lives under `data/vault`. Each actor key lives in `keystore/`, outside the application data directory, and is not stored in `app.sqlite`. The plates are geometric stand-ins, not a face dataset. Revocation deletes that key and the ciphertext, so the plates cannot be read.
- **Speech.** A local oscillator speaks the line from the text. It is not a voice clone.
- **Score and mix.** An original drone is mixed with the dialogue into a stereo file whose duration matches the picture. ffmpeg writes that file at export.
- **Identity hint.** Distance is a token match. It is a hint on the review screen. It does not accept a take.

## What is the production path

`StoryModelAdapter`, `VideoModelAdapter`, `SpeechModelAdapter`, and `ScoreModelAdapter` are the boundaries. A production video adapter may condition on a short-lived reference grant only after `evaluateConsentGate` passes. The same function runs when a shot is scheduled, when a take starts, and when a master is exported. There is no staff bypass.

That adapter still has to refuse training and refuse any face that is not the bound reference pack. The story adapter still receives slots and depiction limits only, never a legal name or a picture. This release does not ship that adapter, because no external model is called from here.
