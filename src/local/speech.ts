import type { SpeechModelAdapter } from "../adapters.js";
import type { SpeechRequest, SpeechResult } from "../types.js";

/**
 * Local speech. A deterministic oscillator speaks the line.
 * It is built from the text only. It is not a voice print and not a clone.
 */
export class LocalSpeechAdapter implements SpeechModelAdapter {
  readonly id = "local-synthetic-speech-v1";

  speak(input: SpeechRequest): SpeechResult {
    const wav = synthesize(input.text);
    const durationMs = Math.round(((wav.length - 44) / 2 / 16_000) * 1000);
    return { wav, durationMs, model: this.id, voice: "synthetic" };
  }
}

function synthesize(text: string): Buffer {
  const sampleRate = 16_000;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const durationSec = Math.min(5.2, Math.max(0.7, words.length * 0.28));
  const count = Math.floor(sampleRate * durationSec);
  const samples = new Int16Array(count);
  const chars = (text.trim() || "line").toLowerCase();
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 20) * Math.min(1, (durationSec - t) * 20);
    const char = chars[Math.floor((t / durationSec) * chars.length) % chars.length] ?? "a";
    const base = 140 + (char.charCodeAt(0) % 17) * 12;
    const vowel = "aeiou".includes(char);
    const tone = Math.sin(2 * Math.PI * base * t) + 0.35 * Math.sin(2 * Math.PI * base * 2 * t);
    const noise = vowel ? 0 : ((hashStep(i, char) % 1000) / 1000 - 0.5) * 0.6;
    const syllable = 0.65 + 0.35 * Math.sin(2 * Math.PI * 4 * t);
    const value = (tone * (vowel ? 0.55 : 0.2) + noise) * env * syllable;
    samples[i] = Math.max(-32767, Math.min(32767, Math.round(value * 12000)));
  }
  return wavFromPcm(samples, sampleRate);
}

function hashStep(index: number, char: string): number {
  return (index * 1103515245 + char.charCodeAt(0) * 12345) >>> 0;
}

function wavFromPcm(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  }
  return buffer;
}
