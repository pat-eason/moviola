#!/usr/bin/env -S npx tsx
/**
 * Moviola doctor — verify the environment is ready and tell the user
 * exactly what to install (with macOS / Linux commands) for anything missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

function have(cmd: string): boolean {
  const r = spawnSync(
    isWin ? "where" : "command",
    isWin ? [cmd] : ["-v", cmd],
    { encoding: "utf-8", shell: !isWin }
  );
  return r.status === 0 && Boolean((r.stdout || "").trim());
}
function found(p?: string): boolean {
  return Boolean(p && existsSync(p));
}
function firstModel(dir: string, match: RegExp): string | undefined {
  if (!existsSync(dir)) return undefined;
  const hit = readdirSync(dir).filter((f) => match.test(f)).sort()[0];
  return hit ? join(dir, hit) : undefined;
}

type Check = {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  hint: string;
};

const checks: Check[] = [];

// --- TS runner -------------------------------------------------------------
const hasBun = have("bun");
const hasTsx = have("tsx") || have("npx");
checks.push({
  name: "TS runner (bun or tsx)",
  ok: hasBun || hasTsx,
  required: true,
  detail: hasBun ? "bun" : hasTsx ? "npx tsx" : "none",
  hint: isMac
    ? "brew install oven-sh/bun/bun   (or: npm i -g tsx)"
    : "curl -fsSL https://bun.sh/install | bash   (or: npm i -g tsx)",
});

// --- ffmpeg / ffprobe ------------------------------------------------------
const ff = have("ffmpeg");
const fp = have("ffprobe");
checks.push({
  name: "ffmpeg + ffprobe",
  ok: ff && fp,
  required: true,
  detail: `ffmpeg:${ff ? "yes" : "no"} ffprobe:${fp ? "yes" : "no"}`,
  hint: isMac ? "brew install ffmpeg" : "sudo apt-get install -y ffmpeg",
});

// --- Parakeet backend ------------------------------------------------------
const parakeetCli =
  [process.env.PARAKEET_CLI, join(SKILL_ROOT, "bin", "parakeet-cli")].find(found) ||
  (have("parakeet-cli") ? "parakeet-cli (PATH)" : undefined);
const parakeetModel =
  [process.env.PARAKEET_MODEL].find(found) ||
  firstModel(join(SKILL_ROOT, "models"), /\.gguf$/i);
checks.push({
  name: "Parakeet: parakeet-cli",
  ok: Boolean(parakeetCli),
  required: false,
  detail: parakeetCli ?? "not found",
  hint: "bun scripts/setup.ts   (or see references/setup.md)",
});
checks.push({
  name: "Parakeet: GGUF model",
  ok: Boolean(parakeetModel),
  required: false,
  detail: parakeetModel ?? "not found",
  hint: "bun scripts/setup.ts   (downloads a default model into models/)",
});

// --- whisper.cpp fallback --------------------------------------------------
const whisperCli =
  [process.env.WHISPER_CLI, join(SKILL_ROOT, "bin", "whisper-cli")].find(found) ||
  (have("whisper-cli") ? "whisper-cli (PATH)" : undefined);
const whisperModel =
  [process.env.WHISPER_MODEL].find(found) ||
  firstModel(join(SKILL_ROOT, "models"), /ggml.*\.bin$/i);
checks.push({
  name: "whisper.cpp (fallback): whisper-cli",
  ok: Boolean(whisperCli),
  required: false,
  detail: whisperCli ?? "not found",
  hint: "Optional. See references/setup.md (whisper.cpp section).",
});
checks.push({
  name: "whisper.cpp (fallback): model",
  ok: Boolean(whisperModel),
  required: false,
  detail: whisperModel ?? "not found",
  hint: "Optional. e.g. ggml-large-v3-turbo.bin in models/.",
});

// --- tesseract (optional, for --ocr) --------------------------------------
const tess = have("tesseract");
checks.push({
  name: "tesseract (optional, --ocr)",
  ok: tess,
  required: false,
  detail: tess ? "yes" : "no",
  hint: isMac ? "brew install tesseract" : "sudo apt-get install -y tesseract-ocr",
});

// --- report ----------------------------------------------------------------
console.log("\nMoviola doctor\n===================\n");
let requiredMissing = false;
let anyBackend = false;
for (const c of checks) {
  const mark = c.ok ? "OK " : c.required ? "FAIL" : "--  ";
  console.log(`[${mark}] ${c.name}`);
  console.log(`        ${c.detail}`);
  if (!c.ok) console.log(`        install: ${c.hint}`);
  if (!c.ok && c.required) requiredMissing = true;
}

const parakeetReady = Boolean(parakeetCli && parakeetModel);
const whisperReady = Boolean(whisperCli && whisperModel);
anyBackend = parakeetReady || whisperReady;

console.log("\n-------------------------------------------------------------");
if (requiredMissing) {
  console.log("Result: NOT READY — install the FAIL items above.");
} else if (!anyBackend) {
  console.log(
    "Result: PARTIAL — core tools present, but no transcription backend is\n" +
      "fully provisioned. Run `bun scripts/setup.ts` for Parakeet, or set up\n" +
      "whisper.cpp. (You can still produce frames-only digests for silent videos.)"
  );
} else {
  console.log(
    `Result: READY — backend available: ${
      parakeetReady ? "parakeet" : ""
    }${parakeetReady && whisperReady ? ", " : ""}${whisperReady ? "whisper" : ""}.`
  );
}
console.log("-------------------------------------------------------------\n");

process.exit(requiredMissing ? 1 : 0);
