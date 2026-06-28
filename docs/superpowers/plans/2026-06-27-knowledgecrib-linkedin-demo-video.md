# KnowledgeCrib LinkedIn Demo Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify a polished 45-second, 1920 x 1080 LinkedIn product video using real KnowledgeCrib CLI and graph data, professional narration, original electronic music, captions, a thumbnail, and post copy.

**Architecture:** A deterministic Node.js pipeline captures sanitized output from the built KnowledgeCrib CLI and samples the repository's real committed soul. A frame renderer converts timeline state into SVG and rasterizes it with Sharp directly into FFmpeg, while separate scripts generate segmented narration and an original PCM soundtrack. A final orchestrator mixes audio, encodes captioned and clean H.264 files, extracts the thumbnail, and runs machine-verifiable quality checks.

**Tech Stack:** Node.js 20 ESM, Sharp 0.34, FFmpeg/ffprobe, macOS `say`, Vitest, SVG, PCM WAV, H.264/AAC.

---

## File Map

- `package.json`: add media render, test, and verify commands plus the Sharp development dependency.
- `pnpm-lock.yaml`: lock Sharp and its native runtime packages.
- `media/linkedin-demo/.gitignore`: exclude generated captures, audio, frames, and work files.
- `media/linkedin-demo/README.md`: document prerequisites and one-command production.
- `media/linkedin-demo/content.mjs`: single source of truth for format, scenes, narration, captions, claims, and CTA.
- `media/linkedin-demo/content.test.mjs`: assert timeline continuity, caption coverage, copy consistency, and safe-area rules.
- `media/linkedin-demo/fixtures/demo-project/*`: compact multilingual source project used by the real CLI capture.
- `media/linkedin-demo/capture.mjs`: build the product, index the fixture, collect real command output, and sample the real repository graph.
- `media/linkedin-demo/capture.test.mjs`: assert capture sanitization and required product evidence.
- `media/linkedin-demo/audio.mjs`: generate narration segments, original music, and the mastered 45-second mix.
- `media/linkedin-demo/audio.test.mjs`: assert WAV headers, duration, finite samples, and deterministic music output.
- `media/linkedin-demo/render.mjs`: render Signal Grid scenes from captured data and encode the captioned and clean videos.
- `media/linkedin-demo/render.test.mjs`: test interpolation, scene selection, XML escaping, text fitting, and frame output.
- `media/linkedin-demo/verify.mjs`: verify media metadata, duration, loudness, black frames, deliverables, and contact sheet.
- `media/linkedin-demo/produce.mjs`: run capture, audio, render, verification, thumbnail extraction, and post-copy generation.
- `dist/media/*`: ignored generated deliverables listed in the approved design.

### Task 1: Scaffold The Reproducible Media Workspace

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `media/linkedin-demo/.gitignore`
- Create: `media/linkedin-demo/README.md`

- [ ] **Step 1: Add root media commands and Sharp**

Add these scripts to `package.json`:

```json
"media:test": "node --test media/linkedin-demo/*.test.mjs",
"media:capture": "node media/linkedin-demo/capture.mjs",
"media:render": "node media/linkedin-demo/produce.mjs",
"media:verify": "node media/linkedin-demo/verify.mjs"
```

Add `"sharp": "^0.34.5"` to `devDependencies`, then run:

```bash
corepack pnpm@9.15.0 install
```

Expected: install succeeds and `pnpm-lock.yaml` records Sharp 0.34.x.

- [ ] **Step 2: Isolate generated media**

Create `media/linkedin-demo/.gitignore` with:

```gitignore
captures/generated/
audio/generated/
work/
```

Create `media/linkedin-demo/README.md` describing the macOS `say`, FFmpeg, and Node prerequisites; `pnpm media:render` as the production command; and the five files written to `dist/media/`.

- [ ] **Step 3: Verify the scaffold**

Run:

```bash
corepack pnpm@9.15.0 exec node -e "import('sharp').then(m => console.log(m.default.versions.vips))"
git diff --check
```

Expected: a libvips version is printed and `git diff --check` is silent.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml media/linkedin-demo/.gitignore media/linkedin-demo/README.md
git commit -m "build: scaffold LinkedIn video pipeline"
```

### Task 2: Define And Test The 45-Second Timeline

**Files:**
- Create: `media/linkedin-demo/content.mjs`
- Create: `media/linkedin-demo/content.test.mjs`

- [ ] **Step 1: Write failing timeline tests**

The tests must assert:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { captions, format, scenes } from './content.mjs';

test('timeline is exactly 45 seconds with contiguous scenes', () => {
  assert.equal(format.duration, 45);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes.at(-1).end, 45);
  for (let i = 1; i < scenes.length; i += 1) assert.equal(scenes[i - 1].end, scenes[i].start);
});

test('delivery format is LinkedIn-ready HD', () => {
  assert.deepEqual([format.width, format.height, format.fps], [1920, 1080, 30]);
});

test('captions are ordered, non-overlapping, and title-safe', () => {
  for (let i = 0; i < captions.length; i += 1) {
    assert.ok(captions[i].start >= 0 && captions[i].end <= 45);
    assert.ok(captions[i].text.length <= 92);
    if (i) assert.ok(captions[i - 1].end <= captions[i].start);
  }
});
```

- [ ] **Step 2: Run tests and observe the missing-module failure**

Run: `node --test media/linkedin-demo/content.test.mjs`

Expected: FAIL because `content.mjs` does not exist.

- [ ] **Step 3: Implement the content contract**

Export these immutable values from `content.mjs`:

```js
export const format = Object.freeze({ width: 1920, height: 1080, fps: 30, duration: 45 });
export const palette = Object.freeze({ ink: '#050706', panel: '#111412', green: '#B8F044', teal: '#43D8C9', amber: '#FFB23F', text: '#F3F6EF', muted: '#A8B1AA' });
export const scenes = Object.freeze([
  { id: 'problem', start: 0, end: 4 },
  { id: 'product', start: 4, end: 9 },
  { id: 'index', start: 9, end: 16 },
  { id: 'architecture', start: 16, end: 24 },
  { id: 'features', start: 24, end: 33 },
  { id: 'mcp', start: 33, end: 40 },
  { id: 'cta', start: 40, end: 45 },
]);
export const voiceSegments = Object.freeze([
  { start: 0.2, end: 3.8, text: 'Your AI coding agent forgets your codebase every session.' },
  { start: 4.2, end: 8.4, text: 'KnowledgeCrib gives your project a portable, durable soul.' },
  { start: 8.9, end: 17.4, text: 'Index once. It parses TypeScript, P L SQL, Python, Java, C-sharp, Go, Rust, and Markdown; resolves relationships; and commits the graph with your code.' },
  { start: 17.5, end: 23.6, text: 'Explore call chains, framework semantics, dependencies, and the true blast radius of change.' },
  { start: 24.1, end: 32.6, text: 'Search bodies. Extract rules. Build dossiers. Reconstruct packages. Find gaps before your agent breaks anything.' },
  { start: 33.1, end: 39.4, text: 'One M C P server gives every supported I D E the same grounded project context.' },
  { start: 40.0, end: 44.0, text: 'Local-first. Agent-agnostic. Apache licensed. Try KnowledgeCrib on GitHub.' },
]);
export const captions = Object.freeze([
  { start: 0.2, end: 2.1, text: 'Your AI coding agent forgets your codebase' },
  { start: 2.1, end: 3.8, text: 'every session.' },
  { start: 4.2, end: 6.2, text: 'KnowledgeCrib gives your project' },
  { start: 6.2, end: 8.4, text: 'a portable, durable soul.' },
  { start: 8.9, end: 10.0, text: 'Index once.' },
  { start: 10.0, end: 13.2, text: 'It parses TypeScript, PL/SQL, Python, Java,' },
  { start: 13.2, end: 15.5, text: 'C-sharp, Go, Rust, and Markdown;' },
  { start: 15.5, end: 17.4, text: 'resolves relationships; and commits the graph with your code.' },
  { start: 17.5, end: 20.4, text: 'Explore call chains, framework semantics, dependencies,' },
  { start: 20.4, end: 23.6, text: 'and the true blast radius of change.' },
  { start: 24.1, end: 26.0, text: 'Search bodies. Extract rules.' },
  { start: 26.0, end: 27.7, text: 'Build dossiers. Reconstruct packages.' },
  { start: 27.7, end: 32.6, text: 'Find gaps before your agent breaks anything.' },
  { start: 33.1, end: 35.8, text: 'One MCP server gives every supported IDE' },
  { start: 35.8, end: 39.4, text: 'the same grounded project context.' },
  { start: 40.0, end: 42.0, text: 'Local-first. Agent-agnostic. Apache licensed.' },
  { start: 42.0, end: 44.0, text: 'Try KnowledgeCrib on GitHub.' },
]);
export const cta = 'github.com/KnowledgeCrib/knowledge-crib';
export const narration = 'Your AI coding agent forgets your codebase every session. KnowledgeCrib gives your project a portable, durable soul. Index once. It parses TypeScript, PL/SQL, Python, Java, C-sharp, Go, Rust, and Markdown; resolves relationships; and commits the graph with your code. Explore call chains, framework semantics, dependencies, and the true blast radius of change. Search bodies. Extract rules. Build dossiers. Reconstruct packages. Find gaps before your agent breaks anything. One MCP server gives every supported IDE the same grounded project context. Local-first. Agent-agnostic. Apache licensed. Try KnowledgeCrib on GitHub.';
export const linkedInPost = `AI coding agents should not have to rediscover your system every session.\n\nKnowledgeCrib gives your repository a portable, local-first project soul:\n\n• Index code, documentation, relationships, and framework semantics\n• Explore search, call paths, rules, dossiers, reconstruction, gaps, and blast radius\n• Serve the same grounded context to Claude, Cursor, VS Code, and Codex through one MCP server\n\nTry the Apache-2.0 project on GitHub:\nhttps://${cta}\n\n#AIEngineering #DeveloperTools #MCP #OpenSource #SoftwareArchitecture`;
```

- [ ] **Step 4: Run tests**

Run: `node --test media/linkedin-demo/content.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/linkedin-demo/content.mjs media/linkedin-demo/content.test.mjs
git commit -m "feat: define LinkedIn video timeline"
```

### Task 3: Capture Real Product Evidence

**Files:**
- Create: `media/linkedin-demo/fixtures/demo-project/auth.ts`
- Create: `media/linkedin-demo/fixtures/demo-project/policy.py`
- Create: `media/linkedin-demo/fixtures/demo-project/Billing.java`
- Create: `media/linkedin-demo/fixtures/demo-project/access.sql`
- Create: `media/linkedin-demo/fixtures/demo-project/README.md`
- Create: `media/linkedin-demo/capture.mjs`
- Create: `media/linkedin-demo/capture.test.mjs`

- [ ] **Step 1: Write failing capture-contract tests**

Test `sanitizeText()` and `sampleGraph()` directly:

```js
test('sanitizer removes absolute paths and credentials', () => {
  const input = '/Users/name/demo npm_gSecret sk-live-secret';
  const output = sanitizeText(input, '/Users/name/demo');
  assert.equal(output.includes('/Users/'), false);
  assert.equal(output.includes('npm_'), false);
  assert.equal(output.includes('sk-live'), false);
});

test('graph sampler returns a readable connected subgraph', () => {
  const sample = sampleGraph(graphFixture, 22);
  assert.ok(sample.nodes.length >= 8 && sample.nodes.length <= 22);
  assert.ok(sample.edges.length >= 7);
  assert.ok(sample.edges.every(edge => sample.nodes.some(node => node.id === edge.from)));
});
```

- [ ] **Step 2: Run tests and observe failure**

Run: `node --test media/linkedin-demo/capture.test.mjs`

Expected: FAIL because capture exports do not exist.

- [ ] **Step 3: Implement deterministic real captures**

`capture.mjs` must:

1. Run `corepack pnpm@9.15.0 -r run build`.
2. Copy the committed demo fixture into `media/linkedin-demo/work/demo-project`.
3. Run the built `packages/cli/dist/cli.js` for `index`, `status`, `query auth --with-source --with-rules`, `impact`, `rules`, `dossier`, `reconstruct`, and `gaps` against that working copy.
4. Sanitize absolute paths and token-shaped strings before persisting output.
5. Export the current repository soul with `crib export --format graph.json` and select a deterministic connected subgraph centered on `packages/cli/src/cli.ts`.
6. Write one stable JSON payload to `media/linkedin-demo/captures/generated/product.json` containing command labels, terminal lines, index counts, supported languages, graph nodes, and graph edges.
7. Fail non-zero when required commands fail or when the graph sample is not connected.

Use `spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })`, parse JSON structurally, and truncate display lines only after parsing.

- [ ] **Step 4: Run capture tests and the real capture**

Run:

```bash
node --test media/linkedin-demo/capture.test.mjs
node media/linkedin-demo/capture.mjs
```

Expected: tests pass; `product.json` exists; no `/Users/`, `npm_`, `ghp_`, `sk-`, or bearer token text is present.

- [ ] **Step 5: Commit**

```bash
git add media/linkedin-demo/fixtures media/linkedin-demo/capture.mjs media/linkedin-demo/capture.test.mjs
git commit -m "feat: capture real KnowledgeCrib product evidence"
```

### Task 4: Generate Narration And Original Music

**Files:**
- Create: `media/linkedin-demo/audio.mjs`
- Create: `media/linkedin-demo/audio.test.mjs`

- [ ] **Step 1: Write failing audio-unit tests**

Use these assertions for `writeWav()` and `musicSample()`:

```js
test('music synthesis is deterministic, finite, and headroom-safe', () => {
  for (const index of [0, 1, 22050, 48000, 48000 * 44]) {
    assert.deepEqual(musicSample(index), musicSample(index));
    for (const value of musicSample(index)) {
      assert.equal(Number.isFinite(value), true);
      assert.ok(Math.abs(value) <= 0.92);
    }
  }
});

test('WAV writer emits 48 kHz stereo PCM', async () => {
  const file = join(tmpdir(), `knowledgecrib-${process.pid}.wav`);
  await writeWav(file, new Float32Array(48000 * 2), { sampleRate: 48000, channels: 2 });
  const bytes = await readFile(file);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(22), 2);
  assert.equal(bytes.readUInt32LE(24), 48000);
});
```

- [ ] **Step 2: Run tests and observe failure**

Run: `node --test media/linkedin-demo/audio.test.mjs`

Expected: FAIL because `audio.mjs` does not exist.

- [ ] **Step 3: Implement the original soundtrack**

Generate 45 seconds at 48 kHz with deterministic synthesis:

```js
const beat = 60 / 132;
const kick = Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-t * 28)) * t) * Math.exp(-t * 16);
const snare = seededNoise(sampleIndex) * Math.exp(-t * 22);
const bass = Math.sin(2 * Math.PI * bassHz * localTime) * envelope;
const arp = Math.sin(2 * Math.PI * arpHz * localTime) * envelope;
```

Arrange kick, snare, hats, bass, arpeggio, transition sweeps, and a final resolve across the seven scenes. Keep the generated pre-master peak below `0.92`.

- [ ] **Step 4: Implement segmented narration and mastering**

Discover installed US-English voices from `say -v ?`, choosing the first available from `Samantha`,
`Ava`, `Allison`, and `Tom`, then falling back to the first non-novelty `en_US` voice. For every
`voiceSegments` entry, run `say -v <voice> -r 165 -o <segment>.aiff <text>`. Probe each duration,
retry up to 180 words per minute if it exceeds its allocated window, and otherwise fail with the
measured duration. Delay each segment to its specified start, then mix narration, music, and
restrained transition effects with FFmpeg. Apply conservative high-pass, compression, narration
ducking, and `loudnorm` to produce `audio/generated/master.wav` at 48 kHz stereo.

- [ ] **Step 5: Run audio tests and generate the master**

Run:

```bash
node --test media/linkedin-demo/audio.test.mjs
node media/linkedin-demo/audio.mjs
ffprobe -v error -show_entries format=duration -of default=nw=1 media/linkedin-demo/audio/generated/master.wav
```

Expected: tests pass and duration is `45.000000` within 50 ms.

- [ ] **Step 6: Commit**

```bash
git add media/linkedin-demo/audio.mjs media/linkedin-demo/audio.test.mjs
git commit -m "feat: generate narration and original demo soundtrack"
```

### Task 5: Render The Signal Grid Video

**Files:**
- Create: `media/linkedin-demo/render.mjs`
- Create: `media/linkedin-demo/render.test.mjs`

- [ ] **Step 1: Write failing renderer tests**

Use these assertions for the pure renderer surface:

```js
test('every frame maps to one scene', () => {
  for (let frame = 0; frame < 1350; frame += 1) assert.ok(sceneAt(frame / 30));
});

test('interpolation clamps and XML escaping is safe', () => {
  assert.equal(lerp(10, 20, -1), 10);
  assert.equal(lerp(10, 20, 2), 20);
  assert.equal(escapeXml('&<>\"\''), '&amp;&lt;&gt;&quot;&apos;');
});

test('representative frames rasterize at 1920 x 1080', async () => {
  for (const frame of [0, 120, 270, 480, 720, 990, 1200]) {
    const png = await rasterFrame(frame, captureFixture, { captions: true });
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.width, meta.height], [1920, 1080]);
  }
});
```

- [ ] **Step 2: Run tests and observe failure**

Run: `node --test media/linkedin-demo/render.test.mjs`

Expected: FAIL because `render.mjs` does not exist.

- [ ] **Step 3: Implement scene rendering**

Export pure `sceneAt(time)`, `lerp()`, `ease()`, `escapeXml()`, `fitText()`, and `frameSvg(frame, capture, options)` functions. The SVG renderer must implement:

- Problem: code fragments and graph relationships reset on the first bass hit.
- Product: KnowledgeCrib wordmark and `PROJECT SOUL / ONLINE` lock into a graph.
- Index: a real sanitized `crib index .` terminal capture plus actual file/node/edge/language counts.
- Architecture: the sampled real graph with focused incoming/outgoing relationships and a blast-radius rail.
- Features: rhythmic real-output panels for query, impact, rules, dossier, reconstruct, and gaps, plus `PATH`, `VIZ`, `MCP`, `HOOKS`, and `ENRICH` labels.
- MCP: one soul fans through a single MCP server to Claude, Cursor, VS Code, and Codex.
- CTA: wordmark, `LOCAL-FIRST / AGENT-AGNOSTIC / APACHE 2.0`, and the repository URL held from 42.5 through 45 seconds.

All scenes must use the approved palette, 96 px safe area, at least 32 px body type, and phrase-level
burned captions in the captioned variant. Use Helvetica Neue and Menlo when installed; fall back to
Helvetica and monospace after measuring text fit through the same `fitText()` helper.

- [ ] **Step 4: Stream frames into FFmpeg**

Rasterize each SVG with Sharp using `sharp(Buffer.from(svg)).png().toBuffer()`, then stream sequential PNG frames to FFmpeg:

```bash
ffmpeg -f image2pipe -framerate 30 -vcodec png -i - -i master.wav \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -r 30 -vsync cfr \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a aac -b:a 192k -movflags +faststart -t 45 output.mp4
```

Render once without captions and once with captions. Fail immediately on a broken pipe or non-zero FFmpeg exit.

- [ ] **Step 5: Run renderer tests and a seven-frame visual smoke test**

Run:

```bash
node --test media/linkedin-demo/render.test.mjs
node media/linkedin-demo/render.mjs --smoke
```

Expected: tests pass and seven smoke-test PNGs are written under `media/linkedin-demo/work/smoke/`.

- [ ] **Step 6: Commit**

```bash
git add media/linkedin-demo/render.mjs media/linkedin-demo/render.test.mjs
git commit -m "feat: render Signal Grid product video"
```

### Task 6: Orchestrate Deliverables And Quality Gates

**Files:**
- Create: `media/linkedin-demo/produce.mjs`
- Create: `media/linkedin-demo/verify.mjs`

- [ ] **Step 1: Implement the production orchestrator**

`produce.mjs` must create required directories, run capture, audio, clean render, captioned render, SRT generation, thumbnail extraction at 43 seconds, LinkedIn post generation, and verification in that order. It must preserve work files after failure and print absolute paths for all deliverables after success.

- [ ] **Step 2: Implement strict media verification**

`verify.mjs` must use `ffprobe` JSON to require:

```js
assert.equal(video.width, 1920);
assert.equal(video.height, 1080);
assert.equal(video.pix_fmt, 'yuv420p');
assert.equal(video.avg_frame_rate, '30/1');
assert.equal(video.codec_name, 'h264');
assert.equal(audio.codec_name, 'aac');
assert.ok(Math.abs(Number(probe.format.duration) - 45) <= 0.05);
```

It must run `ebur128` and require integrated loudness from -15 to -13 LUFS and peak no higher than -1 dBFS, run `blackdetect` and reject unintended black spans longer than 0.25 seconds, assert the URL appears in content data, verify the SRT final cue ends by 45 seconds, and generate a 14-frame contact sheet.

- [ ] **Step 3: Generate the post copy**

Write concise LinkedIn copy with a problem hook, three concrete capability bullets, the GitHub URL, and relevant engineering/AI hashtags. Do not claim package publication or adoption metrics.

- [ ] **Step 4: Run unit tests and a full production render**

Run:

```bash
pnpm media:test
pnpm media:render
```

Expected: all tests pass and all five approved deliverables exist under `dist/media/`.

- [ ] **Step 5: Commit**

```bash
git add media/linkedin-demo/produce.mjs media/linkedin-demo/verify.mjs package.json pnpm-lock.yaml
git commit -m "feat: produce and verify LinkedIn demo deliverables"
```

### Task 7: Inspect The Final Video End To End

**Files:**
- Verify: `dist/media/knowledgecrib-linkedin-45s-captioned.mp4`
- Verify: `dist/media/knowledgecrib-linkedin-45s-clean.mp4`
- Verify: `dist/media/knowledgecrib-linkedin-45s-captions.srt`
- Verify: `dist/media/knowledgecrib-linkedin-thumbnail.png`
- Verify: `dist/media/knowledgecrib-linkedin-post.md`

- [ ] **Step 1: Inspect the contact sheet and representative full-resolution frames**

Check every storyboard segment for clipped text, unreadable terminal output, dense graph labels, caption overlap, personal paths, secrets, and visual discontinuities. Regenerate after any correction.

- [ ] **Step 2: Watch the captioned output with sound and muted**

Confirm narration intelligibility, music energy, synchronization, natural pronunciation, caption accuracy, and a clear 2.5-second CTA hold.

- [ ] **Step 3: Run complete project verification**

Run:

```bash
pnpm media:test
pnpm media:verify
pnpm verify
git diff --check
git status --short
```

Expected: all media and repository checks pass; only intentionally generated ignored deliverables remain outside Git.

- [ ] **Step 4: Record production completion**

Update this plan's checklist, commit any final source corrections, and report the absolute deliverable paths plus measured duration, codec, frame rate, resolution, and loudness.
