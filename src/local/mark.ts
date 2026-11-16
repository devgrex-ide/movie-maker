/** Geometric stand-in mark. It is an identifier for a consent pack, not a face and not a model of a face. */

export function markShapes(token: string): string {
  const nibbles = token
    .replace(/[^0-9a-f]/gi, "")
    .padEnd(16, "0")
    .slice(0, 16)
    .split("")
    .map((char) => parseInt(char, 16));
  const shapes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const x = 80 + (nibbles[i] ?? 0) * 18;
    const y = 40 + (nibbles[i + 6] ?? 0) * 10;
    const r = 10 + ((nibbles[i + 2] ?? 0) % 8);
    shapes.push(
      `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#efc27a" stroke-width="3"/>`,
    );
  }
  const bar = 20 + (nibbles[15] ?? 0) * 8;
  shapes.push(`<rect x="70" y="150" width="${bar}" height="8" fill="#e25b2a"/>`);
  return shapes.join("");
}

export function identityPlates(token: string, phrase: string): { view: string; svg: string }[] {
  return ["front", "three-quarter", "profile"].map((view) => ({
    view,
    svg: plateSvg(token, phrase, view),
  }));
}

function plateSvg(token: string, phrase: string, view: string): string {
  const escapedPhrase = xml(phrase);
  const escapedView = xml(view);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270">
  <rect width="480" height="270" fill="#1c1915"/>
  <rect x="16" y="16" width="448" height="238" fill="none" stroke="#e25b2a" stroke-width="3"/>
  <text x="32" y="48" fill="#f6f0e4" font-family="Georgia, serif" font-size="18">Reference plate</text>
  <text x="32" y="74" fill="#efc27a" font-family="ui-sans-serif, sans-serif" font-size="13">${escapedView}</text>
  <g transform="translate(250,20)">${markShapes(token)}</g>
  <text x="32" y="210" fill="#a39b8d" font-family="ui-sans-serif, sans-serif" font-size="11">${escapedPhrase}</text>
  <text x="32" y="232" fill="#a39b8d" font-family="ui-sans-serif, sans-serif" font-size="11">Stand-in capture. Not a photograph. Not used for training.</text>
</svg>`;
}

export function takeSvg(input: {
  projectTitle: string;
  camera: string;
  action: string;
  durationMs: number;
  seed: string;
  token: string;
  consentId: string;
  characterNames: string[];
  attempt: number;
}): string {
  const seconds = (input.durationMs / 1000).toFixed(3);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#14120e"/>
  <rect x="36" y="36" width="1208" height="648" fill="none" stroke="#e25b2a" stroke-width="4"/>
  <text x="64" y="92" fill="#e25b2a" font-family="ui-sans-serif, sans-serif" font-size="18" letter-spacing="3">STAND-IN TAKE</text>
  <text x="64" y="140" fill="#f6f0e4" font-family="Georgia, serif" font-size="36">${xml(input.projectTitle)}</text>
  <text x="64" y="188" fill="#efc27a" font-family="ui-sans-serif, sans-serif" font-size="20">${xml(input.camera)} · ${seconds}s · attempt ${input.attempt}</text>
  <text x="64" y="240" fill="#f6f0e4" font-family="Georgia, serif" font-size="24">${xml(clip(input.action, 110))}</text>
  <text x="64" y="290" fill="#a39b8d" font-family="ui-sans-serif, sans-serif" font-size="18">On screen: ${xml(input.characterNames.join(", ") || "consented adult")}</text>
  <text x="64" y="328" fill="#a39b8d" font-family="ui-sans-serif, sans-serif" font-size="16">Consent ${xml(input.consentId.slice(0, 8))} · seed ${xml(input.seed.slice(0, 12))}</text>
  <g transform="translate(860,160) scale(1.4)">${markShapes(input.token)}</g>
  <text x="64" y="620" fill="#f6f0e4" font-family="ui-sans-serif, sans-serif" font-size="18">SYNTHETIC MEDIA</text>
  <text x="64" y="648" fill="#a39b8d" font-family="ui-sans-serif, sans-serif" font-size="14">Duration is the take length. This frame is the identity slate, not a looped still padding the film.</text>
</svg>`;
}

export function disclosureSvg(title: string, pictureLabel: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#14120e"/>
  <text x="80" y="220" fill="#e25b2a" font-family="ui-sans-serif, sans-serif" font-size="22" letter-spacing="4">SYNTHETIC MEDIA</text>
  <text x="80" y="300" fill="#f6f0e4" font-family="Georgia, serif" font-size="48">${xml(title)}</text>
  <text x="80" y="370" fill="#efc27a" font-family="ui-sans-serif, sans-serif" font-size="24">Picture ${xml(pictureLabel)}</text>
  <text x="80" y="450" fill="#f6f0e4" font-family="Georgia, serif" font-size="22">Generated picture and speech. Faces only under active written consent.</text>
</svg>`;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
