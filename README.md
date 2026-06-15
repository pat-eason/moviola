# 🎞️ Moviola

**Turn a video into something Claude can actually read.**

Moviola is an on-device tool (and a Claude Code [skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)) that converts a video file into a structured, time-aligned **digest**: sampled, de-duplicated screenshots paired with the transcript spoken during each one. Claude reads the digest to understand what a video *shows* and *says* — without watching it in real time, and without burning a frame on every second of footage.

It's named after the [Moviola](https://en.wikipedia.org/wiki/Moviola), the editing machine that let film editors review footage frame-by-frame with synced sound. Same idea.

Everything runs locally. No upload, no cloud speech-to-text.

> Especially handy for **bug reports**: someone drops a Loom or screen recording of a repro (with or without commentary) and you want Claude to figure out what's breaking.

---

## How it works

```
video ─┬─► audio.wav (16k mono) ─► transcript (words + timestamps)
       └─► sampled + de-duplicated frames (with timestamps)
                          │
                          ▼
        bucket words into each frame's window ─► digest.json
```

Each kept frame defines a window `[its timestamp, the next frame's timestamp)`, and the speech spoken in that span becomes the window's transcript. The result is `digest.json` plus a `frames/` directory.

- **ffmpeg** does frame sampling (scene-change *or* fixed interval), near-duplicate removal (`mpdecimate`), and downscaling.
- **[Parakeet](https://github.com/mudler/parakeet.cpp)** (default) or **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)** (fallback) does on-device transcription with word-level timestamps.
- An optional **tesseract** pass adds on-screen text (`--ocr`) — useful for exact error strings in screencasts.

---

## Requirements

| Tool | Required? | Purpose |
| --- | --- | --- |
| `ffmpeg` + `ffprobe` | ✅ | frame & audio extraction |
| `bun` *or* `npx tsx` (Node 18+) | ✅ | runs the TypeScript scripts |
| `parakeet-cli` + a GGUF model | ✅ (one backend) | transcription (recommended) |
| `whisper-cli` + a `ggml-*.bin` model | alt backend | transcription fallback |
| `tesseract` | optional | `--ocr` on-screen text |
| `yt-dlp` | optional | fetch the video when `--input` is a URL (Loom/YouTube/…) |

Run `doctor` and it'll tell you exactly what's missing and how to install it on your OS.

---

## Quickstart

```bash
# 1. Get the code
git clone https://github.com/pat-eason/moviola.git
cd moviola

# 2. Provision the transcription backend (parakeet-cli + a default model)
bun scripts/setup.ts            # or: npx tsx scripts/setup.ts

# 3. Verify the environment
bun scripts/doctor.ts           # aim for "Result: READY"

# 4. Digest a video
bun scripts/digest.ts --input ~/Downloads/repro.mp4 --out ./repro-digest --ocr
```

That writes `repro-digest/digest.json` and `repro-digest/frames/*.jpg`.

---

## Using it with Claude Code

This is the intended path. Install Moviola as a skill, then just **reference a video in conversation** — the skill triggers on its own.

**Install as a skill:**

```bash
# Personal (available in every session):
git clone https://github.com/pat-eason/moviola.git ~/.claude/skills/moviola
# …or per-project:
git clone https://github.com/pat-eason/moviola.git <your-project>/.claude/skills/moviola

cd ~/.claude/skills/moviola
bun scripts/setup.ts && bun scripts/doctor.ts
```

**Then in a Claude Code session:**

> "A customer sent this bug repro — watch it and tell me what's going wrong. `~/Downloads/repro.mp4`"

Claude consults `SKILL.md`, runs `digest.ts` on the file, reads `digest.json`, and pulls up individual frames only where the transcript is ambiguous or references something visual. You don't run anything by hand — you just point at the video.

> **Why it's frame-frugal:** `SKILL.md` instructs Claude to reason from the transcript first and view frames *selectively*, so a 5-minute screencast costs a handful of vision inputs instead of 150.

---

## Programmatic use with the Claude Agent SDK

Moviola is a normal local CLI plus a skill, so it drops into the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) (the engine behind Claude Code, formerly the "Claude Code SDK") two ways.

### Requirements

Everything the CLI needs, on the machine/container where the **agent runs** (the agent shells out to these — they are not bundled):

- **`@anthropic-ai/claude-agent-sdk`** (TypeScript) or **`claude-agent-sdk`** (Python), and an **`ANTHROPIC_API_KEY`** in the environment.
- **ffmpeg + ffprobe**, a **transcription backend** (parakeet-cli + a GGUF model, or whisper.cpp) — run `bun scripts/setup.ts` once in the deployment.
- **yt-dlp** if you pass Loom/URL inputs; **tesseract** if you use `--ocr`.
- The agent must be allowed to run **Bash** (to invoke `digest.ts`) and **Read** (to load `digest.json` and view frames).

### Pattern A — let the agent drive the skill

Clone Moviola into the project's `.claude/skills/`, then point the agent at a video and let `SKILL.md` trigger. The agent runs `digest.ts`, reads `digest.json`, and views frames selectively — same behavior as interactive Claude Code.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// cwd must contain .claude/skills/moviola; settingSources loads project skills.
const run = query({
  prompt:
    "Watch this bug repro and tell me what's broken: " +
    "https://www.loom.com/share/<id>",
  options: {
    cwd: process.cwd(),
    settingSources: ["project"],
    allowedTools: ["Bash", "Read", "Glob"],
    permissionMode: "acceptEdits", // or handle the permission prompts yourself
  },
});

for await (const msg of run) {
  if (msg.type === "result") console.log(msg.result);
}
```

### Pattern B — preprocess, then prompt (deterministic)

Run the digest yourself as a build/ingest step and feed the result into any SDK call. This removes the agent's discretion over *whether* to run the tool and is the better fit for pipelines.

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

// 1. Build the digest (on-device). A loom.com URL auto-uses interval mode.
execFileSync("bun", [
  "scripts/digest.ts",
  "--input", "https://www.loom.com/share/<id>",
  "--out", "/tmp/repro",
  "--keep-video",
]);

// 2. Hand the digest to the model; let it ask for frames it needs.
const digest = readFileSync("/tmp/repro/digest.json", "utf8");
const run = query({
  prompt:
    "Here is a time-aligned digest of a screen recording. Reason from the " +
    "transcript first; the `frame` paths are images you can read on disk " +
    "only where the text references something visual.\n\n" + digest,
  options: { cwd: "/tmp/repro", allowedTools: ["Read"] },
});
for await (const msg of run) {
  if (msg.type === "result") console.log(msg.result);
}
```

The same shape works from the Python SDK (`from claude_agent_sdk import query`) and with the raw Anthropic Messages API — in that case read the `frame` JPEGs and attach them as image content blocks yourself instead of relying on a file-reading tool. Exact option names follow the [Agent SDK reference](https://docs.claude.com/en/api/agent-sdk/overview).

---

## Standalone CLI usage

Run it directly whenever you want the JSON yourself or to script it:

```bash
bun scripts/digest.ts --input <video> --out <dir> [options]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input` | — | Local video path **or a URL** (Loom/YouTube/Vimeo/…) (**required**). |
| `--out` | `./moviola-out` | Output directory. |
| `--mode` | `scene` (auto `interval` for `loom.com` URLs) | `scene` (frame on visual change) or `interval` (fixed cadence). |
| `--interval` | `2` | Seconds between frames in `interval` mode. |
| `--scene-threshold` | `0.3` | Sensitivity for `scene` mode (lower = more frames). |
| `--no-dedup` | off | Disable near-duplicate frame removal. |
| `--max-width` | `1024` | Downscale frames to fit this box (longest edge). |
| `--backend` | `parakeet` | `parakeet` or `whisper`. |
| `--model` | env/auto | Explicit model path. |
| `--lang` | model default | Language hint (whisper backend). |
| `--ocr` | off | Add `onscreenText` to each window via tesseract. |
| `--keep-audio` | off | Keep the extracted `audio.wav`. |
| `--keep-video` | off | Keep the fetched `source.*` when `--input` is a URL. |
| `--cookies-from-browser` | — | Forward browser cookies to yt-dlp for gated URLs (e.g. `chrome`). |
| `--cookies` | — | Netscape cookies file passed to yt-dlp. |

### URL inputs (Loom & friends)

Pass a link instead of a path and Moviola fetches it with **yt-dlp** into
`<out>/source.*`, digests that file, then removes it (`--keep-video` keeps it):

```bash
bun scripts/digest.ts --input https://www.loom.com/share/<id> --out ./repro-digest --ocr
```

The download is the only network step — transcription and frame sampling still
run entirely on-device, and `digest.json`'s `source` records the original URL.
A `loom.com` URL also auto-selects `--mode interval` (2s cadence), since Looms
are usually a narrated, near-static screen that scene detection under-samples;
pass `--mode scene` to override.

Only publicly reachable / link-shareable videos work out of the box. For a
private or login-gated link, forward your session to yt-dlp with
`--cookies-from-browser chrome` (or `firefox`/`safari`/`edge`/…) or
`--cookies <file>`:

```bash
bun scripts/digest.ts --input https://www.loom.com/share/<id> \
  --out ./repro-digest --cookies-from-browser chrome
```

---

## Output: `digest.json`

```jsonc
{
  "source": "/abs/path/repro.mp4",
  "durationSec": 73.4,
  "hasAudio": true,
  "backend": "parakeet",
  "model": "tdt_ctc-110m-f16.gguf",
  "sampleMode": "scene",
  "frameCount": 11,
  "windows": [
    {
      "index": 0,
      "startSec": 0.0,
      "endSec": 6.2,
      "frame": "frames/f-00001.jpg",
      "transcript": "okay so when I click submit nothing happens",
      "onscreenText": "Submit  |  Error: 500"   // only with --ocr
    }
  ]
}
```

Frame paths are relative to `--out`.

---

## Tuning

- **Mostly-static screen recording** → keep `--mode scene` (default); it emits a frame only when the screen meaningfully changes.
- **Continuous motion** (animation, smooth scrolling) → `--mode interval --interval 1`.
- **Too many / too few frames** → `--scene-threshold` lower is *more* sensitive; raise it (e.g. `0.4`) for fewer. Real recordings score higher on real changes than flat test footage does, so `0.3` is a sane default.
- **Token budget tight** → raise `--scene-threshold` and/or lower `--max-width` (e.g. `768`).

---

## Backends & models

**Parakeet** (`mudler/parakeet.cpp`) is the default: ggml-based, cross-platform (CPU/CUDA/Vulkan on Linux, Metal on macOS), prebuilt CLI bundles, no Python at inference.

| Use case | Model |
| --- | --- |
| English, fast (default) | `tdt_ctc-110m` |
| English, higher accuracy | `tdt-0.6b-v2` |
| Multilingual (25 EU langs) | `tdt-0.6b-v3` |

Models: <https://huggingface.co/mudler/parakeet-cpp-gguf>. Use `f16` or `q8_0` quantizations to trade size for speed.

**whisper.cpp** is the fallback (`--backend whisper`) — battle-tested, 99 languages, use it if Parakeet misbehaves on a given machine.

Binaries/models are resolved in this order: explicit flag → env var (`PARAKEET_CLI`, `PARAKEET_MODEL`, `WHISPER_CLI`, `WHISPER_MODEL`) → the repo's `bin/` and `models/` → your `PATH`. See [`references/setup.md`](references/setup.md) for per-OS, GPU, Docker, and build-from-source details.

---

## Project layout

```
moviola/
├── SKILL.md              # Claude Code skill definition + usage guidance
├── README.md             # you are here
├── package.json
├── scripts/
│   ├── digest.ts         # the orchestrator
│   ├── doctor.ts         # environment preflight
│   └── setup.ts          # provisions parakeet-cli + a model
├── references/
│   └── setup.md          # detailed install / tuning / troubleshooting
├── bin/                  # provisioned binaries land here (gitignored)
└── models/               # GGUF / ggml models land here (gitignored)
```

---

## Troubleshooting

Run `bun scripts/doctor.ts` first — it pinpoints the missing piece and prints the install command for your OS. The digest script also fails fast with a pointer back to the doctor when a binary or model is absent. Common cases are listed in [`references/setup.md`](references/setup.md#6-troubleshooting).

---

## Notes & credits

- The transcription leg is validated by contract (the documented `parakeet-cli --json` shape); the frame-sampling and alignment legs are exercised end-to-end. First run against a real video is the true test.
- `mudler/parakeet.cpp` is a young project — `setup.ts` discovers release assets dynamically rather than hardcoding names, and you can override the model with `--model-url`.
- Built on the excellent [ffmpeg](https://ffmpeg.org/), [parakeet.cpp](https://github.com/mudler/parakeet.cpp), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and [tesseract](https://github.com/tesseract-ocr/tesseract).

## License

MIT — see [LICENSE](LICENSE).
