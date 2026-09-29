// FAKE AUDIO BACKENDS: a controlled TTS service and a controlled audio decoder, so the
// --apply paths of voice.mjs (S3) and remix.mjs (S4) can be tested.
//
// WHY THIS EXISTS
//
// voice.mjs and remix.mjs do their real work only under --apply. There they need two
// things a test cannot use:
//   - `msedge-tts`, a network TTS service;
//   - `playwright`, a real browser whose Web Audio decoder measures each clip's head and
//     tail silence.
// Both are imported dynamically on the --apply path and nowhere else. So the plan path
// was testable, but the apply path was not: silent-clip generation, the gap solve, the
// reflow and the concatenation. A regression there turned no test red.
//
// This loader swaps both modules for deterministic in-process fakes in ONE child process,
// without editing the engine source:
//
//   import { FAKE_AUDIO, runScript } from './_helpers.mjs';
//   const r = runScript('voice.mjs', ['--apply', '--replace'], dir, {
//     nodeArgs: ['--import', FAKE_AUDIO],
//     env: { FAKE_TTS_LOG: path.join(logDir, 'tts.jsonl') },   // optional
//   });
//
// It is the same module-customization-hook mechanism as block-playwright.mjs, but it
// substitutes the modules instead of blocking them.
//
// THE AUDIO MODEL: MARKER FRAMES
//
// Every clip is a run of MPEG-2 Layer III frames in the engine's own profile: 24 kHz,
// 96 kbps, mono, 288 bytes and 24 ms per frame, header FF F3 A4 C0. Each frame's payload
// is one repeated byte that says what the frame "sounds like":
//   - 0x00 is silence. These frames are byte-identical to what silence-gen.mjs writes.
//   - 0x10..0xCF is speech, carrying a marker derived from the text.
// As a result:
//   - music-metadata, the engine's real probe, measures a clip's duration exactly, from
//     real frame headers;
//   - the fake decoder reads the same bytes back as silent or voiced, per 24 ms frame;
//   - a test can read any output back as "which clip is audible at millisecond N".
// Build inputs and read outputs with the codec that fake-audio-backends.mjs exports:
// frames, ttsClip, ttsWords, markerFor and readFrames.
//
// FAKE msedge-tts (voice.mjs)
//
// MsEdgeTTS#setMetadata(voice, format, { wordBoundaryEnabled }) and
// #toStream(text, { rate }) have the shapes msedge-tts 2.0.x uses:
//   - `{ audioStream, metadataStream }` as Readables, with metadataStream null when word
//     boundaries are off;
//   - WordBoundary metadata in 100 ns ticks.
// A synthesised clip is HEAD_FRAMES of silence, FRAMES_PER_WORD voiced frames per word,
// then TAIL_FRAMES of silence (see ttsClip). Words are whitespace-split with punctuation
// stripped, the way the service reports them. Empty text gets an empty stream with no
// boundaries, as the real service does.
// When $FAKE_TTS_LOG is set, every request is appended to it as one JSON line:
// { voice, format, rate, text }. A test can then assert WHAT was sent to the service,
// for example that a declared silent segment never was. Keep the log outside the project
// directory, so it cannot collide with anything the stage writes.
//
// FAKE playwright (remix.mjs)
//
// The chain is chromium.launch() → browser.newPage() → page.goto() / page.evaluate(fn, arg).
// The evaluated function is rebuilt from its SOURCE, as Playwright serialises it, so a
// closure reference that would fail in a real browser fails here too. Its argument and
// result are structured-cloned, and it runs in this process against a fake
// OfflineAudioContext. That context's decodeAudioData() turns marker frames into 48 kHz
// PCM: 0.0 for a silent frame, VOICED_LEVEL for a voiced one. Anything that is not a
// marker frame is rejected, as a real decoder rejects garbage.
//
// LIMITS: READ THESE BEFORE REUSING IT
//
//   - It covers the surface voice.mjs and remix.mjs use today and nothing else. The fake
//     browser cannot render a page, so never load it into a stage that captures frames.
//   - Child processes the stage spawns (silence-gen.mjs) do not inherit --import. They do
//     not need to, because neither faked module is imported there.
//   - It is a TEST fixture. Nothing in src/ may import it.
import { register } from 'node:module';

register('./fake-audio-hooks.mjs', import.meta.url);
