# moviola — setup & reference

Detailed, per-OS provisioning and tuning. The short path is:

```bash
bun scripts/setup.ts     # provision Parakeet binary + default model
bun scripts/doctor.ts    # verify
```

If anything is missing, `doctor` prints the exact install command for your OS.

---

## 1. Core dependencies

### ffmpeg + ffprobe (required)

- macOS: `brew install ffmpeg`
- Debian/Ubuntu: `sudo apt-get install -y ffmpeg`
- Fedora: `sudo dnf install -y ffmpeg`
- Arch: `sudo pacman -S ffmpeg`

### TS runner (required)

Pick one:

- **bun** (runs `.ts` directly, no install step):
  - macOS: `brew install oven-sh/bun/bun`
  - Linux: `curl -fsSL https://bun.sh/install | bash`
- **tsx** (on Node 18+): `npm i -g tsx`, then `npx tsx scripts/digest.ts ...`

---

## 2. Transcription backend

### Option A — Parakeet (default, recommended)

`mudler/parakeet.cpp` is a ggml-based C++ engine: cross-platform, prebuilt CLI
bundles, CPU/CUDA/Vulkan on Linux and Metal on macOS, no Python at inference.

**Automatic:** `bun scripts/setup.ts` discovers the latest release, downloads a
prebuilt `parakeet-cli` for your OS/arch into `bin/`, and pulls a default model
into `models/`.

**Manual binary:** download a bundle from
<https://github.com/mudler/parakeet.cpp/releases>, extract it, then either place
`parakeet-cli` in this skill's `bin/` or set `export PARAKEET_CLI=/path/to/parakeet-cli`.

**Docker (no local binary):**

```bash
docker run --rm \
  -v "$PWD/models:/models:ro" \
  -v "$PWD/audio:/audio:ro" \
  ghcr.io/mudler/parakeet.cpp transcribe \
  --model /models/<model>.gguf --input /audio/audio.wav --json
```

(If you go the Docker route, wrap it in a tiny `parakeet-cli` shell shim on your
PATH so the digest script can call it transparently.)

**Build from source:**

```bash
git clone --recursive https://github.com/mudler/parakeet.cpp
cd parakeet.cpp
cmake -B build -DPARAKEET_BUILD_CLI=ON && cmake --build build -j
# binary at build/examples/cli/parakeet-cli
# GPU: add -DPARAKEET_GGML_CUDA=ON  (Linux/NVIDIA)
#      or -DPARAKEET_GGML_METAL=ON  (macOS)
#      or -DPARAKEET_GGML_VULKAN=ON
```

**Models** live at <https://huggingface.co/mudler/parakeet-cpp-gguf>.

| Use case | Model | Notes |
| --- | --- | --- |
| English, fast (default) | `tdt_ctc-110m` | smallest, great for repros |
| English, higher accuracy | `tdt-0.6b-v2` | larger, slower |
| Multilingual | `tdt-0.6b-v3` | 25 European languages |

Pick a quantization to trade size for speed: `f16` (near-lossless) or `q8_0`
(smaller, still ~lossless) — e.g. the default is `tdt_ctc-110m-f16.gguf`. Point at a specific model per run with `--model`, or
drop a single `.gguf` into `models/` and it's auto-detected.

Custom model during setup:

```bash
bun scripts/setup.ts --model-url \
  "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/<file>.gguf?download=true"
```

### Option B — whisper.cpp (fallback)

Battle-tested, 99-language. Use it if Parakeet misbehaves on a given box.

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build && cmake --build build -j        # binary: build/bin/whisper-cli
# macOS Metal is on by default; CUDA: -DGGML_CUDA=1
./models/download-ggml-model.sh large-v3-turbo  # -> models/ggml-large-v3-turbo.bin
```

Then either place `whisper-cli` in this skill's `bin/` and the `.bin` in
`models/`, or set `WHISPER_CLI` / `WHISPER_MODEL`. Run the digest with
`--backend whisper`.

### Option C — OCR (optional, `--ocr`)

Reads on-screen text from each kept frame (handy for exact error strings in
screen recordings). The transcript already captures speech; OCR captures pixels.

- macOS: `brew install tesseract`
- Debian/Ubuntu: `sudo apt-get install -y tesseract-ocr`

---

## 3. Resolution order

For each binary/model the digest script checks, in order:

1. an explicit flag (`--model`, `--parakeet-cli`, `--whisper-cli`)
2. an environment variable (`PARAKEET_CLI`, `PARAKEET_MODEL`, `WHISPER_CLI`, `WHISPER_MODEL`)
3. the skill-local `bin/` and `models/` directories
4. your `PATH`

So you can install once globally, or keep everything self-contained inside the
skill folder — both work.

---

## 4. All digest.ts flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input` | — | Path to the video (required). |
| `--out` | `./moviola-out` | Output directory. |
| `--mode` | `scene` | `scene` or `interval`. |
| `--interval` | `2` | Seconds between frames (`interval` mode). |
| `--scene-threshold` | `0.3` | Lower = more frames (`scene` mode). |
| `--no-dedup` | off | Disable `mpdecimate` near-duplicate removal. |
| `--max-width` | `1024` | Downscale frames to fit this box (longest edge). |
| `--backend` | `parakeet` | `parakeet` or `whisper`. |
| `--model` | env/auto | Explicit model path. |
| `--parakeet-cli` | env/auto | Explicit parakeet-cli path. |
| `--whisper-cli` | env/auto | Explicit whisper-cli path. |
| `--lang` | model default | Language hint (whisper). |
| `--ocr` | off | Add `onscreenText` via tesseract. |
| `--keep-audio` | off | Keep extracted `audio.wav` in `--out`. |

---

## 5. How sampling works

The frame pass is a single ffmpeg filter chain:

```
[ select='gt(scene,T)+eq(n,0)' | fps=1/N ]  →  [ mpdecimate ]  →  scale  →  showinfo
```

- **scene mode** emits a frame whenever the picture changes by more than the
  threshold (plus the very first frame). Ideal for screen recordings that sit
  still for long stretches.
- **interval mode** emits a frame every N seconds — use it when motion is
  continuous and you want a guaranteed cadence.
- **mpdecimate** (on unless `--no-dedup`) drops frames that barely differ from
  the previous kept frame — the big token-saver on static screencasts.
- **showinfo** lets the script read the exact presentation timestamp of every
  surviving frame, which is how transcript words get bucketed into the right
  window.

Each frame defines a window `[its time, next frame's time)`; the words spoken in
that span become the window's transcript.

---

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `parakeet-cli not found` | `bun scripts/setup.ts`, or set `PARAKEET_CLI`. |
| `No Parakeet GGUF model found` | `bun scripts/setup.ts`, or `--model <file.gguf>`. |
| Too many near-identical frames | Raise `--scene-threshold` (e.g. `0.4`); keep dedup on. |
| Missed fast changes | Lower `--scene-threshold`, or `--mode interval --interval 1`. |
| macOS "cannot be opened" on binary | `xattr -dr com.apple.quarantine bin/` (setup does this). |
| Silent video, empty transcript | Expected — you get a frames-only digest. |
| GPU not used | Install/build a CUDA/Metal/Vulkan bundle (section 2). |

Always start with `bun scripts/doctor.ts` — it pinpoints the missing piece.
