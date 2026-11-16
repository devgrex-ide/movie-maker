import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function renderStereoMix(input: {
  outPath: string;
  durationMs: number;
  dialogue: { path: string; startMs: number }[];
  motif: string;
}): void {
  const seconds = (input.durationMs / 1000).toFixed(3);
  const root = Number(input.motif.split(":")[1]?.split("+")[0] ?? 196);
  const fifth = Number(input.motif.split("+")[1]?.split(":")[0] ?? root * 1.25);
  const dialogue = input.dialogue.filter((item) => fs.existsSync(item.path));
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${scoreExpression(root, fifth)}:s=16000:d=${seconds}`,
  ];
  dialogue.forEach((item) => {
    args.push("-i", item.path);
  });
  const filterParts = [
    `[0:a]aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=stereo,volume=0.35[bed]`,
  ];
  const labels = ["[bed]"];
  dialogue.forEach((item, index) => {
    const delay = Math.max(0, Math.round(item.startMs));
    const label = `d${index}`;
    filterParts.push(
      `[${index + 1}:a]aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=stereo,adelay=${delay}|${delay},volume=0.9[${label}]`,
    );
    labels.push(`[${label}]`);
  });
  filterParts.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0[out]`,
  );
  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[out]",
    "-t",
    seconds,
    "-c:a",
    "pcm_s16le",
    input.outPath,
  );
  execFileSync("ffmpeg", args, { stdio: "pipe" });
}

export function probeDurationMs(file: string): number {
  const output = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 1000);
}

function scoreExpression(root: number, fifth: number): string {
  return `0.2*sin(2*PI*${root}*t)+0.12*sin(2*PI*${fifth}*t)+0.05*sin(2*PI*${root * 2}*t)`;
}
