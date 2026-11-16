import { findPublicFigures, scanForDeniedDepiction, scanForMinors } from "./scan.js";

export function compileShotPrompt(input: {
  camera: string;
  action: string;
  continuity: string;
  durationMs: number;
  characterNames: string[];
  line: string | null;
}): string {
  return [
    "style: stylized",
    `camera: ${input.camera}`,
    `action: ${input.action}`,
    `continuity: ${input.continuity}`,
    `on screen: ${input.characterNames.join(", ")}`,
    input.line ? `line: ${input.line}` : "line: none",
    `duration_ms: ${input.durationMs}`,
    "people outside the cast stay off screen",
    "training: denied",
  ].join("\n");
}

export function promptViolation(prompt: string): string | null {
  const minor = scanForMinors(prompt);
  if (minor) return minor.term;
  const depiction = scanForDeniedDepiction(prompt);
  if (depiction) return depiction.term;
  const figures = findPublicFigures(prompt);
  if (figures.length > 0) return figures[0] ?? "public figure";
  return null;
}
