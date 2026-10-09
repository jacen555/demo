// The fakes loaded by fake-audio.mjs, plus the marker-frame codec that tests use to build
// inputs and read outputs back. fake-audio.mjs explains the model and how to load it.
//
// A test may import this module directly for the codec: importing it has no side effects.
// The fake OfflineAudioContext exists only while a fake page.evaluate() is running.
import fs from "node:fs";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { requireTestOwnedPath } from "./suite-owned-path.mjs";

// ---- the marker-frame codec ------------------------------------------------------------------

export const FRAME_BYTES = 288;
export const FRAME_MS = 24;
export const FRAME_HEADER = Object.freeze([0xff, 0xf3, 0xa4, 0xc0]);
/** Payload byte of a silent frame. It is byte-identical to silence-gen.mjs output. */
export const SILENT = 0x00;
/** Silent frames before the first word and after the last, in every synthesised clip. */
export const HEAD_FRAMES = 5;
export const TAIL_FRAMES = 5;
export const FRAMES_PER_WORD = 10;
/** The PCM level the fake decoder gives a voiced frame, well above any silence threshold. */
export const VOICED_LEVEL = 0.25;

/** `count` whole frames carrying one payload byte: SILENT, or a speech marker. */
export function frames(count, payload = SILENT) {
  const buf = Buffer.alloc(FRAME_BYTES * count, payload);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < FRAME_HEADER.length; k++)
      buf[i * FRAME_BYTES + k] = FRAME_HEADER[k];
  }
  return buf;
}

/** The speech marker for `text`. It is stable per text, never SILENT, and never a sync byte. */
export function markerFor(text) {
  return (
    0x10 +
    (crypto.createHash("sha256").update(String(text), "utf8").digest()[0] %
      0xc0)
  );
}

/** The words the fake service reports for `text`: whitespace-split, punctuation stripped. */
export function ttsWords(text) {
  return String(text ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter(Boolean);
}

/** Exactly the bytes the fake service returns for `text`. Empty text gives no bytes. */
export function ttsClip(text) {
  const words = ttsWords(text);
  if (words.length === 0) return Buffer.alloc(0);
  return Buffer.concat([
    frames(HEAD_FRAMES),
    frames(words.length * FRAMES_PER_WORD, markerFor(text)),
    frames(TAIL_FRAMES),
  ]);
}

/**
 * The payload byte of every frame in a marker MP3, in order. It throws on anything that
 * is not whole marker frames, so a test fails loudly on audio it cannot account for.
 */
export function readFrames(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length === 0 || buf.length % FRAME_BYTES !== 0) {
    throw new Error(
      `not whole ${FRAME_BYTES}-byte marker frames: ${buf.length} bytes`,
    );
  }
  const payloads = [];
  for (let o = 0; o < buf.length; o += FRAME_BYTES) {
    if (!FRAME_HEADER.every((b, k) => buf[o + k] === b))
      throw new Error(`no marker frame header at byte ${o}`);
    const payload = buf[o + FRAME_HEADER.length];
    for (let j = o + FRAME_HEADER.length; j < o + FRAME_BYTES; j++) {
      if (buf[j] !== payload)
        throw new Error(
          `frame at byte ${o} mixes payload bytes — not a marker frame`,
        );
    }
    payloads.push(payload);
  }
  return payloads;
}

// ---- fake msedge-tts ---------------------------------------------------------------------------

const TICKS_PER_MS = 10_000; // WordBoundary offsets are in 100 ns units

function logRequest(entry) {
  const log = process.env.FAKE_TTS_LOG;
  if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

export class MsEdgeTTS {
  #voice = null;
  #format = null;
  #wordBoundary = false;

  async setMetadata(voice, format, options = {}) {
    this.#voice = voice;
    this.#format = format;
    this.#wordBoundary = options?.wordBoundaryEnabled === true;
  }

  toStream(text, options = {}) {
    if (this.#voice === null)
      throw new Error(
        "fake msedge-tts: setMetadata() must be called before toStream()",
      );
    logRequest({
      voice: this.#voice,
      format: this.#format,
      rate: options?.rate ?? null,
      text,
    });

    const audio = ttsClip(text);
    const boundaries = ttsWords(text).map((word, k) =>
      Buffer.from(
        JSON.stringify({
          Metadata: [
            {
              Type: "WordBoundary",
              Data: {
                Offset:
                  (HEAD_FRAMES + k * FRAMES_PER_WORD) * FRAME_MS * TICKS_PER_MS,
                Duration: FRAMES_PER_WORD * FRAME_MS * TICKS_PER_MS,
                text: {
                  Text: word,
                  Length: word.length,
                  BoundaryType: "WordBoundary",
                },
              },
            },
          ],
        }),
        "utf8",
      ),
    );

    return {
      audioStream: Readable.from(audio.length ? [audio] : []),
      metadataStream: this.#wordBoundary ? Readable.from(boundaries) : null,
    };
  }
}

// ---- fake playwright ---------------------------------------------------------------------------

class FakeOfflineAudioContext {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  async decodeAudioData(arrayBuffer) {
    const payloads = readFrames(Buffer.from(arrayBuffer));
    const perFrame = Math.round((this.sampleRate * FRAME_MS) / 1000);
    const pcm = new Float32Array(payloads.length * perFrame);
    payloads.forEach((p, i) => {
      if (p !== SILENT)
        pcm.fill(VOICED_LEVEL, i * perFrame, (i + 1) * perFrame);
    });
    return {
      sampleRate: this.sampleRate,
      length: pcm.length,
      duration: pcm.length / this.sampleRate,
      numberOfChannels: 1,
      getChannelData(channel) {
        if (channel !== 0)
          throw new RangeError(
            `fake decoder produced 1 channel, asked for ${channel}`,
          );
        return pcm;
      },
    };
  }
}

async function evaluateLikeABrowser(fn, arg) {
  // Rebuilt from source, the way Playwright ships a function to the page. A closure over a
  // variable in the caller's module fails here exactly as it would in a real browser.
  const rebuilt =
    typeof fn === "function"
      ? new Function(`return (${fn.toString()});`)()
      : null;
  if (!rebuilt)
    throw new Error("fake playwright: only function evaluation is supported");
  const had = Object.hasOwn(globalThis, "OfflineAudioContext");
  const previous = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = FakeOfflineAudioContext;
  try {
    return structuredClone(await rebuilt(structuredClone(arg)));
  } finally {
    if (had) globalThis.OfflineAudioContext = previous;
    else delete globalThis.OfflineAudioContext;
  }
}

export const chromium = {
  async launch() {
    let open = true;
    return {
      async newPage() {
        if (!open) throw new Error("fake playwright: browser has been closed");
        return {
          // FAKE_PLAYWRIGHT_GOTO_SWAP / _WITH replace one file with another while the page
          // loads — the window between a script's first read of its input and the decode.
          // CONFINED to suite-owned files: runScript passes the parent's whole environment,
          // so an inherited pair would otherwise copy anything over anything. Out of bounds
          // throws, failing the run loudly, and copies nothing.
          async goto() {
            const {
              FAKE_PLAYWRIGHT_GOTO_SWAP: target,
              FAKE_PLAYWRIGHT_GOTO_SWAP_WITH: source,
            } = process.env;
            if (target && source) {
              const from = requireTestOwnedPath(
                source,
                "fake playwright: $FAKE_PLAYWRIGHT_GOTO_SWAP_WITH",
              );
              const to = requireTestOwnedPath(
                target,
                "fake playwright: $FAKE_PLAYWRIGHT_GOTO_SWAP",
                { mayBeAbsent: true },
              );
              fs.copyFileSync(from, to);
            }
            return null;
          },
          evaluate: evaluateLikeABrowser,
          async close() {},
        };
      },
      async close() {
        open = false;
      },
    };
  },
};
