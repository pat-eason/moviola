#!/usr/bin/env -S npx tsx
/**
 * moviola — turn a video into time-aligned (frame + transcript) windows.
 *
 * Runs fully on-device:
 *   video -> audio.wav (16k mono) -> transcript (words + timestamps)
 *   video -> sampled + de-duplicated frames (with timestamps)
 *   -> bucket words into each frame's window -> digest.json
 *
 * No runtime npm dependencies — Node built-ins only. Run with `bun` or `tsx`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
type Args = Record<string, string | boolean>;
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function str(key: string, fallback?: string): string | undefined {
  const v = args[key];
  if (typeof v === "string") return v;
  return fallback;
}
function flag(key: string): boolean {
  return args[key] === true || args[key] === "true";
}
function num(key: string, fallback: number): number {
  const v = str(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function die(msg: string): never {
  console.error(`\n[moviola] ERROR: ${msg}\n`);
  console.error("Run `bun scripts/doctor.ts` to diagnose your environment.\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// small process helpers
// ---------------------------------------------------------------------------
function run(cmd: string, cmdArgs: string[]) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf-8", maxBuffer: 1 << 28 });
}
function have(cmd: string): boolean {
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? [cmd] : ["-v", cmd],
    { encoding: "utf-8", shell: process.platform !== "win32" }
  );
  return probe.status === 0 && Boolean((probe.stdout || "").trim());
}

/** First existing candidate path, else the bare name if it's on PATH, else undefined. */
function resolveBinary(
  flagVal: string | undefined,
  envVar: string,
  localCandidates: string[],
  bareName: string
): string | undefined {
  const candidates = [
    flagVal,
    process.env[envVar],
    ...localCandidates,
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  if (have(bareName)) return bareName;
  return undefined;
}
function resolveModel(
  flagVal: string | undefined,
  envVar: string,
  glob: { dir: string; match: RegExp }
): string | undefined {
  const direct = [flagVal, process.env[envVar]].filter(Boolean) as string[];
  for (const c of direct) if (existsSync(c)) return c;
  if (existsSync(glob.dir)) {
    const hit = readdirSync(glob.dir)
      .filter((f) => glob.match.test(f))
      .sort()[0];
    if (hit) return join(glob.dir, hit);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe
// ---------------------------------------------------------------------------
function probeDuration(input: string): number {
  const r = run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nokey=1:noprint_wrappers=1",
    input,
  ]);
  const d = Number((r.stdout || "").trim());
  return Number.isFinite(d) ? d : 0;
}
function hasAudioStream(input: string): boolean {
  const r = run("ffprobe", [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    input,
  ]);
  return Boolean((r.stdout || "").trim());
}

/** Extract 16 kHz mono PCM wav for the speech recognizer. */
function extractAudio(input: string, wavPath: string): boolean {
  const r = run("ffmpeg", [
    "-y", "-i", input,
    "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le",
    wavPath,
  ]);
  return r.status === 0 && existsSync(wavPath);
}

/**
 * Sample frames and return [{ file, timeSec }] in presentation order.
 * Uses a single filter chain ending in showinfo so we can read exact
 * timestamps for every frame that survives sampling + de-duplication.
 */
function extractFrames(
  input: string,
  framesDir: string,
  opts: {
    mode: "scene" | "interval";
    interval: number;
    sceneThreshold: number;
    dedup: boolean;
    maxWidth: number;
  }
): { file: string; timeSec: number }[] {
  mkdirSync(framesDir, { recursive: true });

  const sampler =
    opts.mode === "scene"
      ? `select='gt(scene\\,${opts.sceneThreshold})+eq(n\\,0)'`
      : `fps=1/${opts.interval}`;

  const chain = [sampler];
  if (opts.dedup) chain.push("mpdecimate");
  chain.push(
    `scale=w=min(${opts.maxWidth}\\,iw):h=min(${opts.maxWidth}\\,ih):force_original_aspect_ratio=decrease`
  );
  chain.push("showinfo");
  const vf = chain.join(",");

  const out = join(framesDir, "f-%05d.jpg");
  const r = run("ffmpeg", [
    "-y", "-i", input,
    "-an",
    "-vf", vf,
    "-fps_mode", "vfr",
    "-q:v", "3",
    out,
  ]);
  if (r.status !== 0 && !existsSync(framesDir)) {
    die(`ffmpeg frame extraction failed:\n${r.stderr || r.error}`);
  }

  // showinfo writes one "pts_time:<sec>" per surviving frame, in order.
  const times = [...(r.stderr || "").matchAll(/pts_time:([0-9.]+)/g)].map((m) =>
    Number(m[1])
  );
  const files = readdirSync(framesDir)
    .filter((f) => /^f-\d+\.jpg$/.test(f))
    .sort();

  const n = Math.min(files.length, times.length || files.length);
  const frames: { file: string; timeSec: number }[] = [];
  for (let i = 0; i < files.length; i++) {
    frames.push({
      file: files[i],
      // Fall back to a synthetic timestamp if showinfo parsing came up short.
      timeSec: times[i] ?? (opts.mode === "interval" ? i * opts.interval : 0),
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// transcription backends -> normalized words [{ w, start, end }]
// ---------------------------------------------------------------------------
type Word = { w: string; start: number; end: number };

function transcribeParakeet(
  cli: string,
  model: string,
  wav: string
): Word[] {
  const r = run(cli, ["transcribe", "--model", model, "--input", wav, "--json"]);
  if (r.status !== 0) die(`parakeet-cli failed:\n${r.stderr || r.error}`);
  let parsed: any;
  try {
    // The CLI prints a single JSON object; tolerate leading/trailing log noise.
    const text = r.stdout || "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    die(`Could not parse parakeet-cli JSON output: ${e}`);
  }
  const words: any[] = Array.isArray(parsed.words) ? parsed.words : [];
  return words.map((x) => ({
    w: String(x.w ?? ""),
    start: Number(x.start ?? 0),
    end: Number(x.end ?? x.start ?? 0),
  }));
}

function transcribeWhisper(
  cli: string,
  model: string,
  wav: string,
  outDir: string,
  lang?: string
): Word[] {
  const base = join(outDir, "whisper-out");
  const wargs = [
    "-m", model,
    "-f", wav,
    "-oj",        // JSON output
    "-ml", "1",   // max segment length -> ~word-level segments
    "-of", base,
  ];
  if (lang) wargs.push("-l", lang);
  const r = run(cli, wargs);
  const jsonPath = `${base}.json`;
  if (r.status !== 0 || !existsSync(jsonPath)) {
    die(`whisper-cli failed:\n${r.stderr || r.error}`);
  }
  const parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const segs: any[] = Array.isArray(parsed.transcription)
    ? parsed.transcription
    : [];
  rmSync(jsonPath, { force: true });
  return segs.map((s) => ({
    w: String(s.text ?? "").trim(),
    start: Number(s?.offsets?.from ?? 0) / 1000,
    end: Number(s?.offsets?.to ?? 0) / 1000,
  }));
}

// ---------------------------------------------------------------------------
// optional OCR
// ---------------------------------------------------------------------------
function ocrFrame(framePath: string): string {
  const r = run("tesseract", [framePath, "stdout", "-l", "eng"]);
  if (r.status !== 0) return "";
  return (r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("  |  ")
    .slice(0, 2000);
}

// ---------------------------------------------------------------------------
// alignment: bucket words into each frame's [start, end) window
// ---------------------------------------------------------------------------
function buildWindows(
  frames: { file: string; timeSec: number }[],
  words: Word[],
  durationSec: number,
  doOcr: boolean,
  framesDirRel: string,
  framesDirAbs: string
) {
  return frames.map((f, i) => {
    const startSec = i === 0 ? 0 : f.timeSec;
    const endSec = i < frames.length - 1 ? frames[i + 1].timeSec : durationSec;
    const inWindow = words
      .filter((w) => w.start >= startSec && w.start < endSec)
      .map((w) => w.w.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const win: Record<string, unknown> = {
      index: i,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      frame: join(framesDirRel, f.file),
      transcript: inWindow,
    };
    if (doOcr) win.onscreenText = ocrFrame(join(framesDirAbs, f.file));
    return win;
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const input = str("input");
  if (!input) die("--input <video> is required.");
  if (!existsSync(input)) die(`Input not found: ${input}`);
  if (!have("ffmpeg") || !have("ffprobe"))
    die("ffmpeg and ffprobe must be installed and on PATH.");

  const outDir = resolve(str("out", "./moviola-out")!);
  const framesDirRel = "frames";
  const framesDirAbs = join(outDir, framesDirRel);
  mkdirSync(outDir, { recursive: true });

  const mode = (str("mode", "scene") as "scene" | "interval") ?? "scene";
  const backend = (str("backend", "parakeet") as "parakeet" | "whisper") ?? "parakeet";
  const doOcr = flag("ocr");
  if (doOcr && !have("tesseract"))
    die("--ocr requested but tesseract is not installed.");

  console.log(`[moviola] input=${basename(input)} mode=${mode} backend=${backend}`);

  // 1. duration + audio presence
  const durationSec = probeDuration(input);
  const audioPresent = hasAudioStream(input);

  // 2. transcript (only if there is an audio stream)
  let words: Word[] = [];
  let modelLabel = "(none)";
  if (audioPresent) {
    const wav = join(outDir, "audio.wav");
    if (!extractAudio(input, wav))
      die("Failed to extract audio with ffmpeg.");

    if (backend === "parakeet") {
      const cli = resolveBinary(
        str("parakeet-cli"),
        "PARAKEET_CLI",
        [join(SKILL_ROOT, "bin", "parakeet-cli")],
        "parakeet-cli"
      );
      if (!cli)
        die("parakeet-cli not found. Run `bun scripts/setup.ts` or set PARAKEET_CLI.");
      const model = resolveModel(str("model"), "PARAKEET_MODEL", {
        dir: join(SKILL_ROOT, "models"),
        match: /\.gguf$/i,
      });
      if (!model)
        die("No Parakeet GGUF model found. Run `bun scripts/setup.ts` or pass --model.");
      modelLabel = basename(model);
      words = transcribeParakeet(cli, model, wav);
    } else {
      const cli = resolveBinary(
        str("whisper-cli"),
        "WHISPER_CLI",
        [join(SKILL_ROOT, "bin", "whisper-cli")],
        "whisper-cli"
      );
      if (!cli)
        die("whisper-cli not found. Build whisper.cpp or set WHISPER_CLI.");
      const model = resolveModel(str("model"), "WHISPER_MODEL", {
        dir: join(SKILL_ROOT, "models"),
        match: /ggml.*\.bin$/i,
      });
      if (!model)
        die("No whisper.cpp model (.bin) found. Pass --model or set WHISPER_MODEL.");
      modelLabel = basename(model);
      words = transcribeWhisper(cli, model, wav, outDir, str("lang"));
    }

    if (!flag("keep-audio")) rmSync(wav, { force: true });
  } else {
    console.log("[moviola] no audio stream — producing a frames-only digest.");
  }

  // 3. frames
  const frames = extractFrames(input, framesDirAbs, {
    mode,
    interval: num("interval", 2),
    sceneThreshold: num("scene-threshold", 0.3),
    dedup: !flag("no-dedup"),
    maxWidth: num("max-width", 1024),
  });
  if (frames.length === 0)
    die("No frames were extracted — check the input or lower --scene-threshold.");

  // 4. align + assemble
  const windows = buildWindows(
    frames,
    words,
    durationSec || (frames.at(-1)?.timeSec ?? 0) + 1,
    doOcr,
    framesDirRel,
    framesDirAbs
  );

  const digest = {
    source: resolve(input),
    generatedAt: new Date().toISOString(),
    durationSec: Number(durationSec.toFixed(3)),
    hasAudio: audioPresent,
    backend: audioPresent ? backend : "(none)",
    model: modelLabel,
    sampleMode: mode,
    params: {
      interval: num("interval", 2),
      sceneThreshold: num("scene-threshold", 0.3),
      dedup: !flag("no-dedup"),
      maxWidth: num("max-width", 1024),
      ocr: doOcr,
    },
    frameCount: frames.length,
    wordCount: words.length,
    windows,
  };

  const digestPath = join(outDir, "digest.json");
  writeFileSync(digestPath, JSON.stringify(digest, null, 2));

  console.log(
    `[moviola] done: ${frames.length} frames, ${words.length} words across ` +
      `${windows.length} windows.\n` +
      `  digest: ${digestPath}\n` +
      `  frames: ${framesDirAbs}\n` +
      `\nNext: read digest.json, then view individual frames only where the ` +
      `transcript is ambiguous or references something visual.`
  );
}

main();
