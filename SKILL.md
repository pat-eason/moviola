---
name: moviola
description: >-
  Turn a video file into a structured, time-aligned digest (sampled screenshots
  paired with transcript chunks) so Claude can understand what a video SHOWS and
  what it SAYS without watching it in real time. Use this whenever the user
  references a video file, a screen recording, a Loom, a bug-repro recording, or
  an .mp4/.mov/.webm/.mkv/.m4v, or asks Claude to "watch", "review", "look at",
  "check out", or "understand" a video — even if they don't say the word "video"
  explicitly. Especially useful for issue reports where someone recorded a
  reproduction with or without spoken commentary. Runs fully on-device via
  ffmpeg + Parakeet (or whisper.cpp as a fallback). Run `doctor` first on a new
  machine.
---

# Moviola

Convert a local video into `digest.json`: an ordered list of time windows, each
with one representative frame (a screenshot) and the transcript spoken during
that window. The consuming Claude session reads the JSON to understand the video
and selectively views frames for visual detail.

Everything runs locally. No upload, no cloud STT.

## When to use

- A user attaches or points at a video / screen recording / Loom and wants
  Claude to understand it.
- An issue report includes a reproduction video (with or without narration).
- Any task phrased as "watch / review / look at this video".

If there's no spoken audio, the digest is frames-only — still useful for silent
screen-capture repros.

## Pipeline

```
video ─┬─► audio.wav (16k mono) ─► transcript (words + timestamps)
       └─► sampled + de-duplicated frames (with timestamps)
                          │
                          ▼
        bucket words into each frame's window ─► digest.json
```

## Requirements

Run the doctor before first use — it checks everything and prints OS-specific
install hints for whatever is missing:

```bash
bun scripts/doctor.ts        # or: npx tsx scripts/doctor.ts
```

Needed:

- **ffmpeg** and **ffprobe** — frame + audio extraction.
- **A TS runner** — `bun` (runs `.ts` directly, zero install) or `npx tsx` on
  Node 18+.
- **A transcription backend** (one of):
  - **Parakeet** (default, recommended) — `parakeet-cli` from
    `mudler/parakeet.cpp` + a GGUF model. Fast, cross-platform (CPU/CUDA/Vulkan
    on Linux, Metal on macOS), no Python at inference.
  - **whisper.cpp** (fallback) — `whisper-cli` + a `ggml-*.bin` model.
- **tesseract** — optional, only if you pass `--ocr` to read on-screen text.

`scripts/setup.ts` attempts to provision the Parakeet binary + model
automatically. See `references/setup.md` for manual / per-OS / GPU steps, model
choices, and backend selection.

## One-time setup

```bash
bun scripts/setup.ts          # downloads parakeet-cli + a default model
bun scripts/doctor.ts         # verify the environment is ready
```

The scripts look for binaries/models in this order: explicit `--model` /
`--parakeet-cli` flags → environment variables (`PARAKEET_CLI`, `PARAKEET_MODEL`,
`WHISPER_CLI`, `WHISPER_MODEL`) → the skill's local `bin/` and `models/`
directories → your `PATH`.

## Usage

```bash
bun scripts/digest.ts --input <video> --out <dir> [options]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input` | — | Path to the video (required). |
| `--out` | `./moviola-out` | Output dir for `digest.json` + frames. |
| `--mode` | `scene` | `scene` (frame on visual change) or `interval` (fixed cadence). |
| `--interval` | `2` | Seconds between frames in `interval` mode. |
| `--scene-threshold` | `0.3` | Sensitivity for `scene` mode (lower = more frames). |
| `--no-dedup` | off | Disable near-duplicate frame removal (`mpdecimate`). |
| `--max-width` | `1024` | Downscale frames to fit this box (longest edge). |
| `--backend` | `parakeet` | `parakeet` or `whisper`. |
| `--model` | env/auto | Path to the GGUF (parakeet) or `.bin` (whisper) model. |
| `--lang` | model default | Language hint (whisper backend). |
| `--ocr` | off | Run tesseract on each kept frame → `onscreenText`. |
| `--keep-audio` | off | Keep the extracted `audio.wav` in `--out`. |

Example (a Loom bug repro with on-screen text extraction):

```bash
bun scripts/digest.ts --input ~/Downloads/repro.mp4 --out ./repro-digest --ocr
```

## Output: `digest.json`

```jsonc
{
  "source": "/abs/path/repro.mp4",
  "durationSec": 73.4,
  "hasAudio": true,
  "backend": "parakeet",
  "model": "parakeet-tdt_ctc-110m.gguf",
  "sampleMode": "scene",
  "frameCount": 11,
  "windows": [
    {
      "index": 0,
      "startSec": 0.0,
      "endSec": 6.2,
      "frame": "frames/f-00001.jpg",
      "transcript": "okay so when I click submit nothing happens",
      "onscreenText": "Submit  |  Error: 500"   // only present with --ocr
    }
  ]
}
```

Frame paths are relative to `--out`. A window's transcript is the speech whose
timing falls inside `[startSec, endSec)`.

## How to consume the digest (IMPORTANT)

After running the script, read `<out>/digest.json` and reason over the windows.

**Be selective about viewing frames — each frame is a vision input and costs
tokens.** Don't blindly view every frame. Instead:

1. Read all `transcript` (and `onscreenText`) fields first to build a model from
   text alone — cheap, and often sufficient.
2. Use the `view` tool on a frame only when the text is ambiguous, references
   something visual ("see this error", "this button"), or you need to confirm UI
   state at a specific moment.
3. For a long video, view a handful of pivotal frames rather than all of them.
   The window timestamps tell you where to look.

## Tuning

- **Mostly-static screen recording** → keep `--mode scene` (default); it emits a
  frame only when the screen meaningfully changes, so a 5-minute Loom may produce
  ~15 frames instead of 150.
- **Need a guaranteed cadence** (animation, smooth scrolling) → `--mode interval
  --interval 1`.
- **Too many / too few frames** → `--scene-threshold` lower is *more* sensitive;
  raise it (e.g. `0.4`) for fewer frames. Dedup is on by default.
- **Token budget tight** → raise `--scene-threshold` and/or lower `--max-width`
  (e.g. `768`).

## Troubleshooting

Run `bun scripts/doctor.ts`. It reports which dependency is missing and how to
install it on macOS or Linux. The digest script also fails fast with a pointer
back to the doctor when a binary or model is absent.
