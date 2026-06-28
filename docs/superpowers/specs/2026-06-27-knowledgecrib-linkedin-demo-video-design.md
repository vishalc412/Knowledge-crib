# KnowledgeCrib LinkedIn Demo Video Design

Date: 2026-06-27
Status: Approved creative direction; awaiting written-spec review

## Objective

Produce a polished 45-second product video that introduces KnowledgeCrib to engineering leaders and
developers on LinkedIn. The video must quickly establish the problem, explain the project-soul model,
prove that the product works through real captures, surface the major capability groups, and end with
the call to action: **Try it on GitHub**.

The product name is **KnowledgeCrib**. The final repository CTA is
`github.com/KnowledgeCrib/knowledge-crib`.

## Audience And Success Criteria

Primary audience:

- Engineering leaders evaluating AI-assisted development workflows.
- Senior developers and architects concerned with context loss, unsafe changes, and migration risk.

The video succeeds when a viewer can answer these questions after one viewing:

1. What is KnowledgeCrib? A portable, durable project soul for AI coding agents.
2. What does it do? It builds and serves a local-first knowledge graph of code, behavior, and
   architecture.
3. Why does it matter? Agents retain grounded context and can reason about impact, rules, paths,
   gaps, and migrations without repeatedly rebuilding understanding.
4. What should the viewer do next? Try KnowledgeCrib on GitHub.

## Locked Format

- Duration: exactly 45 seconds.
- Canvas: 1920 x 1080 landscape, square pixels.
- Frame rate: 30 fps constant frame rate.
- Delivery codec: H.264 High Profile in MP4, `yuv420p`, Rec. 709 color metadata.
- Audio: AAC stereo, normalized near -14 LUFS integrated, true peak no higher than -1 dBTP.
- Narration: professional, confident, neutral US English.
- Music: original energetic electronic track, approximately 132 BPM.
- Captions: burned into the primary LinkedIn file, with a separate SRT deliverable.

## Creative Direction: Signal Grid

The approved direction is technical, fast, and credible rather than decorative or futuristic for its
own sake.

Visual rules:

- Solid charcoal and near-black backgrounds.
- Acid green for primary claims and successful state.
- Teal for graph relationships, commands, and data flow.
- Amber for emphasis, warnings, and rhythmic accents.
- Fine grid lines, compact data labels, sharp wipes, and graph traces.
- Sans-serif display typography for claims; monospace typography for commands and metrics.
- Real product footage remains the hero. Motion graphics frame, label, and connect the footage.
- No stock imagery, decorative gradient fields, floating blobs, or simulated product output.
- Minimum on-screen text size is 32 px at 1920 x 1080. Critical copy stays inside a 96 px safe area.

Palette:

- Near black: `#050706`
- Charcoal: `#111412`
- Acid green: `#B8F044`
- Teal: `#43D8C9`
- Amber: `#FFB23F`
- Primary text: `#F3F6EF`
- Secondary text: `#A8B1AA`

## Narrative And Storyboard

Scene boundaries below are visual edit points, not hard narration boundaries. Voiceover may bridge a
cut so dense proof points remain naturally paced; the final mix must preserve the exact 45-second
runtime and the minimum CTA hold.

### 0-4 seconds: The Problem

Narration: "Your AI coding agent forgets your codebase every session."

Visual: code fragments and relationship lines appear briefly, then reset and scatter. A hard cut on
the first bass hit introduces the problem statement.

### 4-9 seconds: The Product

Narration: "KnowledgeCrib gives your project a portable, durable soul."

Visual: the KnowledgeCrib wordmark locks into a living graph. The phrase `PROJECT SOUL / ONLINE`
appears as a compact system label.

### 9-16 seconds: Index Once

Narration: "Index once. It parses TypeScript, PL/SQL, Python, Java, C-sharp, Go, Rust, and Markdown;
resolves relationships; and commits the graph with your code."

Real capture: `crib index .` runs against a deterministic demo project. The result transitions into
animated counts for files, nodes, edges, and supported languages. A local-first indicator confirms
that the deterministic core does not require a network.

### 16-24 seconds: See The Architecture

Narration: "Explore call chains, framework semantics, dependencies, and the true blast radius of
change."

Real capture: the graph visualization opens on a real KnowledgeCrib soul, zooms to a selected node,
and highlights incoming and outgoing relationships. The capture must remain readable and avoid a
full-screen unstructured graph mesh.

### 24-33 seconds: Ask Deeper Questions

Narration: "Search bodies. Extract rules. Build dossiers. Reconstruct packages. Find gaps before your
agent breaks anything."

Real capture montage, cut to the music:

- Query with body-aware results.
- Impact analysis and dependency direction.
- Decision-table rule extraction.
- Persisted dossier output.
- Package reconstruction.
- Analysis-readiness gaps.

A compact feature rail additionally surfaces `PATH`, `VIZ`, `MCP`, `HOOKS`, and `ENRICH` without
requiring a spoken explanation for every command.

### 33-40 seconds: Any Agent, One Memory

Narration: "One MCP server gives every supported IDE the same grounded project context."

Motion graphic: a committed project soul flows into one MCP server and fans out to text labels for
Claude, Cursor, VS Code, and Codex. The design must not imply provider-specific runtime coupling.

### 40-45 seconds: Promise And CTA

Narration: "Local-first. Agent-agnostic. Apache licensed. Try KnowledgeCrib on GitHub."

Visual: final graph pulse resolves into the KnowledgeCrib wordmark and
`github.com/KnowledgeCrib/knowledge-crib`. The URL remains fully visible for at least 2.5 seconds.

## Final Narration Script

> Your AI coding agent forgets your codebase every session. KnowledgeCrib gives your project a
> portable, durable soul. Index once. It parses TypeScript, PL/SQL, Python, Java, C-sharp, Go, Rust,
> and Markdown; resolves relationships; and commits the graph with your code. Explore call chains,
> framework semantics, dependencies, and the true blast radius of change. Search bodies. Extract
> rules. Build dossiers. Reconstruct packages. Find gaps before your agent breaks anything. One MCP
> server gives every supported IDE the same grounded project context. Local-first. Agent-agnostic.
> Apache licensed. Try KnowledgeCrib on GitHub.

The script is 87 words. It should be delivered near 150 words per minute, leaving roughly 10 seconds
for deliberate pauses around the product name, proof montage, and CTA. Timing changes should adjust
pauses, visual holds, and voiceover carry across scene cuts before changing the approved copy.

## Capture Plan

Two real capture sources are required:

1. A compact deterministic demo project for readable terminal commands and stable command output.
2. The KnowledgeCrib self-soul for the graph visualization and credible large-project scale.

Capture requirements:

- Build and invoke the current local release commit, not a mocked CLI.
- Use deterministic fixtures and stable terminal dimensions.
- Remove personal paths, credentials, machine-specific identifiers, and unrelated terminal history.
- Capture only implemented commands and supported claims.
- Record or render at 1920 x 1080 so UI footage is never upscaled.
- Use controlled pans and zooms only when necessary for legibility.

## Audio Design

Voice:

- Select the best installed premium or enhanced US-English system voice.
- Prefer a clear mid-register voice with restrained delivery over a theatrical trailer voice.
- If no premium voice is installed, use the clearest available US-English system voice and apply
  conservative EQ, compression, and de-essing.

Original soundtrack:

- Approximately 132 BPM.
- Tight electronic kick and snare pattern, low synth pulse, and bright restrained arpeggio.
- Energy rises through indexing and the feature montage, then leaves space for the CTA.
- The soundtrack must be generated for this project and must not sample copyrighted music.

Mix:

- Narration remains intelligible at all times.
- Music ducks under speech and rises only in narration gaps.
- Sound effects are limited to UI clicks, short data pulses, and restrained transition sweeps.
- Final loudness target is approximately -14 LUFS integrated with a maximum true peak of -1 dBTP.

## Production Architecture

Source material and render automation will live under `media/linkedin-demo/` with clear boundaries:

- `script/`: approved narration, captions, scene timing, and LinkedIn copy.
- `captures/`: sanitized real terminal and visualization footage or frame sequences.
- `graphics/`: Signal Grid backgrounds, wordmark scenes, labels, and thumbnail source.
- `audio/`: narration, original music stems, sound effects, and final mix.
- `render/`: reproducible scripts and scene definitions.

Final deliverables will be generated under `dist/media/`:

- `knowledgecrib-linkedin-45s-captioned.mp4`
- `knowledgecrib-linkedin-45s-clean.mp4`
- `knowledgecrib-linkedin-45s-captions.srt`
- `knowledgecrib-linkedin-thumbnail.png`
- `knowledgecrib-linkedin-post.md`

The render pipeline must fail with a non-zero status when a required source asset is missing, capture
dimensions are wrong, narration is absent, or FFmpeg reports an encoding failure. Intermediate files
must remain available after a failure for diagnosis.

## Fallback Behavior

- If live browser recording is unreliable, use deterministic high-resolution screenshots with
  controlled pan and zoom. Do not simulate interactions that did not occur.
- If the preferred system voice is unavailable, select the clearest installed US-English voice and
  preserve the approved timing and captions.
- If a required font is unavailable, use a verified system sans-serif and monospace pair with the
  same measured text fit.
- If narration timing exceeds the scene budget, first tighten pauses and music-only holds. Do not
  accelerate speech beyond natural comprehension or remove proof points without approval.
- If graph footage is visually dense, use node-focused captures and relationship filtering instead
  of shrinking the entire graph.

## Verification

Automated checks:

- `ffprobe` confirms duration, dimensions, frame rate, codecs, pixel format, and audio stream.
- FFmpeg loudness analysis confirms the final integrated loudness and peak constraints.
- Black-frame detection finds no unintended blank sections.
- Captions remain within the title-safe region and match the final narration script.
- The final repository URL is continuously visible for at least 2.5 seconds.
- Every stated command and capability is checked against the current CLI help and release docs.

Visual checks:

- Generate a contact sheet spanning the complete video.
- Inspect at least one full-resolution frame from every storyboard segment.
- Confirm terminal text, graph labels, URL, and captions are readable at 100% and mobile-preview size.
- Confirm no text overlaps, clipped lines, personal paths, credentials, or stale product claims.
- Watch the final captioned file end to end with sound and once muted.

## Deliverables

The primary deliverable is the captioned LinkedIn-ready MP4. The clean MP4, SRT, thumbnail, and post
copy are supporting artifacts so the same production can be reused without rebuilding the video.
