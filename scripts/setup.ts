#!/usr/bin/env -S npx tsx
/**
 * moviola setup — best-effort provisioner for the Parakeet backend.
 *
 * It will:
 *   1. confirm ffmpeg is present (cannot auto-install system packages safely);
 *   2. discover the latest mudler/parakeet.cpp release via the GitHub API and
 *      download a prebuilt `parakeet-cli` asset matching this OS/arch;
 *   3. download a default GGUF model into ./models.
 *
 * Anything it can't do automatically (e.g. an unusual platform, or a GPU build)
 * it explains, then points at references/setup.md. Re-run is safe (idempotent).
 *
 * Override the model with:  bun scripts/setup.ts --model-url <url>
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(SKILL_ROOT, "bin");
const MODELS_DIR = join(SKILL_ROOT, "models");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const arch = process.arch; // 'arm64' | 'x64' | ...

// A small, fast, English hybrid TDT-CTC model is a good default. Multilingual
// users should swap in tdt-0.6b-v3 (see references/setup.md).
// NOTE: files in this repo are named without a `parakeet-` prefix
// (e.g. `tdt_ctc-110m-f16.gguf`); keep these in sync with the actual repo.
const DEFAULT_MODEL_URL =
  "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/tdt_ctc-110m-f16.gguf?download=true";
const DEFAULT_MODEL_FILENAME = "tdt_ctc-110m-f16.gguf";

function have(cmd: string): boolean {
  const r = spawnSync("command", ["-v", cmd], { encoding: "utf-8", shell: true });
  return r.status === 0 && Boolean((r.stdout || "").trim());
}
function log(msg: string) {
  console.log(`[setup] ${msg}`);
}
function warn(msg: string) {
  console.warn(`[setup] WARNING: ${msg}`);
}

async function download(url: string, dest: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body)
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

/** Pick the release asset whose name best matches this platform. */
function scoreAsset(name: string): number {
  const n = name.toLowerCase();
  let score = 0;
  if (isMac && (n.includes("macos") || n.includes("darwin") || n.includes("apple"))) score += 5;
  if (isLinux && n.includes("linux")) score += 5;
  if (arch === "arm64" && (n.includes("arm64") || n.includes("aarch64"))) score += 3;
  if (arch === "x64" && (n.includes("x86_64") || n.includes("amd64") || n.includes("x64"))) score += 3;
  // Prefer the plain CPU bundle for broad compatibility unless the user wants GPU.
  if (n.includes("cpu")) score += 2;
  if (n.includes("cuda") || n.includes("vulkan") || n.includes("hip")) score -= 1;
  if (n.endsWith(".tar.gz") || n.endsWith(".tgz") || n.endsWith(".zip")) score += 1;
  return score;
}

async function provisionBinary() {
  if (existsSync(join(BIN_DIR, "parakeet-cli"))) {
    log("parakeet-cli already present in bin/ — skipping download.");
    return;
  }
  mkdirSync(BIN_DIR, { recursive: true });
  log("Querying latest mudler/parakeet.cpp release…");
  const api = "https://api.github.com/repos/mudler/parakeet.cpp/releases/latest";
  const res = await fetch(api, {
    headers: { "User-Agent": "moviola-setup", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    warn(`GitHub API returned ${res.status}. Falling back to manual install.`);
    printManualBinaryHelp();
    return;
  }
  const rel: any = await res.json();
  const assets: any[] = rel.assets ?? [];
  const ranked = assets
    .map((a) => ({ a, s: scoreAsset(a.name) }))
    .sort((x, y) => y.s - x.s);
  const best = ranked[0];

  if (!best || best.s <= 0) {
    warn(`No prebuilt asset clearly matches ${process.platform}/${arch}.`);
    log(`Release ${rel.tag_name} assets: ${assets.map((a) => a.name).join(", ") || "(none)"}`);
    printManualBinaryHelp();
    return;
  }

  const asset = best.a;
  const archivePath = join(BIN_DIR, asset.name);
  log(`Downloading ${asset.name} (${rel.tag_name})…`);
  try {
    await download(asset.browser_download_url, archivePath);
  } catch (e) {
    warn(`Download failed: ${e}`);
    printManualBinaryHelp();
    return;
  }

  // Extract.
  log("Extracting…");
  if (asset.name.endsWith(".zip")) {
    spawnSync("unzip", ["-o", archivePath, "-d", BIN_DIR], { stdio: "inherit" });
  } else {
    spawnSync("tar", ["-xzf", archivePath, "-C", BIN_DIR], { stdio: "inherit" });
  }

  // Try to surface a top-level parakeet-cli for the resolver.
  const find = spawnSync(
    "bash",
    ["-lc", `find "${BIN_DIR}" -type f -name 'parakeet-cli' | head -n1`],
    { encoding: "utf-8" }
  );
  const cliPath = (find.stdout || "").trim();
  if (cliPath) {
    try {
      chmodSync(cliPath, 0o755);
    } catch {}
    if (cliPath !== join(BIN_DIR, "parakeet-cli")) {
      spawnSync("ln", ["-sf", cliPath, join(BIN_DIR, "parakeet-cli")]);
    }
    if (isMac) {
      // Clear Gatekeeper quarantine on freshly downloaded binaries.
      spawnSync("xattr", ["-dr", "com.apple.quarantine", BIN_DIR]);
    }
    log(`parakeet-cli ready: ${join(BIN_DIR, "parakeet-cli")}`);
  } else {
    warn("Extracted archive but could not locate a 'parakeet-cli' binary.");
    printManualBinaryHelp();
  }
}

function printManualBinaryHelp() {
  console.log(
    [
      "",
      "  Manual install (pick one):",
      "    • Download a prebuilt bundle from:",
      "        https://github.com/mudler/parakeet.cpp/releases",
      "      extract it, and either put `parakeet-cli` in this skill's bin/ dir",
      "      or set  export PARAKEET_CLI=/path/to/parakeet-cli",
      "    • Or run via Docker (see references/setup.md).",
      "    • Or build from source (CMake + ggml submodule; references/setup.md).",
      "",
    ].join("\n")
  );
}

const HF_REPO = "mudler/parakeet-cpp-gguf";

/**
 * Resolve the default model via the HF API so a repo rename (e.g. a dropped
 * `parakeet-` prefix) self-heals instead of 404ing. Returns the first GGUF
 * whose name matches `prefer`, falling back to a looser match.
 */
async function resolveDefaultModelFromHF(
  prefer: RegExp,
  loose: RegExp
): Promise<{ url: string; filename: string } | null> {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${HF_REPO}`, {
      headers: { "User-Agent": "moviola-setup" },
    });
    if (!res.ok) return null;
    const meta: any = await res.json();
    const ggufs: string[] = (meta.siblings ?? [])
      .map((s: any) => s.rfilename as string)
      .filter((f: string) => f.endsWith(".gguf"));
    const hit = ggufs.find((f) => prefer.test(f)) ?? ggufs.find((f) => loose.test(f));
    if (!hit) return null;
    return {
      url: `https://huggingface.co/${HF_REPO}/resolve/main/${hit}?download=true`,
      filename: hit,
    };
  } catch {
    return null;
  }
}

async function provisionModel(
  modelUrl: string,
  filename: string,
  isDefault: boolean
) {
  mkdirSync(MODELS_DIR, { recursive: true });
  let dest = join(MODELS_DIR, filename);
  if (existsSync(dest)) {
    log(`Model already present: ${dest} — skipping.`);
    return;
  }
  log(`Downloading model ${filename}…`);
  try {
    await download(modelUrl, dest);
    log(`Model ready: ${dest}`);
    return;
  } catch (e) {
    warn(`Model download failed: ${e}`);
    // For the built-in default, the pinned filename may have drifted in the
    // repo — ask the HF API what's actually there and retry once.
    if (isDefault) {
      log("Trying to resolve the default model from the HuggingFace API…");
      const resolved = await resolveDefaultModelFromHF(
        /tdt_ctc-110m.*f16\.gguf$/i,
        /tdt_ctc-110m.*\.gguf$/i
      );
      if (resolved) {
        dest = join(MODELS_DIR, resolved.filename);
        if (existsSync(dest)) {
          log(`Model already present: ${dest} — skipping.`);
          return;
        }
        log(`Resolved ${resolved.filename}; downloading…`);
        try {
          await download(resolved.url, dest);
          log(`Model ready: ${dest}`);
          return;
        } catch (e2) {
          warn(`Fallback model download also failed: ${e2}`);
        }
      } else {
        warn("Could not resolve a default model from the HuggingFace API.");
      }
    }
    console.log(
      [
        "",
        "  Manual model install:",
        "    Download a GGUF from https://huggingface.co/mudler/parakeet-cpp-gguf",
        `    save it into ${MODELS_DIR}/  (or set PARAKEET_MODEL=/path/to/model.gguf)`,
        "",
      ].join("\n")
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const modelUrlIdx = argv.indexOf("--model-url");
  const isDefaultModel = modelUrlIdx < 0;
  const modelUrl = isDefaultModel ? DEFAULT_MODEL_URL : argv[modelUrlIdx + 1];
  const filename = isDefaultModel
    ? DEFAULT_MODEL_FILENAME
    : (modelUrl.split("/").pop() || DEFAULT_MODEL_FILENAME).replace(/\?.*$/, "");

  log(`platform: ${process.platform}/${arch}`);

  if (!have("ffmpeg") || !have("ffprobe")) {
    warn(
      "ffmpeg/ffprobe not found. Install them first:\n" +
        (isMac
          ? "    brew install ffmpeg"
          : "    sudo apt-get install -y ffmpeg   (or your distro's package manager)")
    );
  }

  await provisionBinary();
  await provisionModel(modelUrl, filename, isDefaultModel);

  console.log("\nNext: run `bun scripts/doctor.ts` to confirm everything is ready.\n");
}

main().catch((e) => {
  console.error(`[setup] fatal: ${e}`);
  process.exit(1);
});
