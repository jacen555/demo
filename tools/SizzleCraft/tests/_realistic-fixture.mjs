// Builds a timing.json + calibration-observed.json pair in EXACTLY the shape `voice.mjs`
// writes them, so a test exercises the reader against what the writer actually produces.
//
// This file exists because the calibration tests that preceded it hand-wrote
// `{ wordsPerSecond, wpsSafetyMargin }` at the top level of calibration-observed.json —
// a shape voice.mjs has never emitted. Those tests passed, and the reader they "covered"
// missed on every real project. When the red and the green come from different bodies,
// the red proves nothing about what ships.
//
// Mirrors voice.mjs section 4 (reflow) and section 7 (calibration evidence):
//   seg.startMs = cursor; seg.endMs = cursor + clipMs      -> window IS the measured clip
//   cursor      = seg.endMs + insertedGapMs                 -> monotonic, NOT adjacent
//   aggregate.observedEffWps = words / (speechMs / 1000)    -> speech-only, nested
//   segments[].textHash      = sha256(voiceoverText)        -> the lineage fingerprint

import { narrationFingerprint } from "../src/cli-support.mjs";

/**
 * @param {Array<{id: string, words: number, clipMs: number, headMs?: number, tailMs?: number}>} specs
 * @param {{leadInMs?: number, gapsMs?: number[]}} [opts]
 */
export function measuredProject(specs, { leadInMs = 2016, gapsMs = [] } = {}) {
    let cursor = leadInMs;
    const segments = [];
    const calSegs = [];

    specs.forEach((spec, i) => {
        const headMs = spec.headMs ?? 240;
        const tailMs = spec.tailMs ?? 264;
        const text = Array.from(
            { length: spec.words },
            (_, w) => `word${w}`,
        ).join(" ");
        const startMs = cursor;
        const endMs = cursor + spec.clipMs;

        segments.push({
            id: spec.id,
            startMs,
            endMs,
            voiceoverText: text,
            // voice.mjs writes plannedDurationMs alongside the measured window.
            plannedDurationMs: spec.clipMs,
            audio: {
                file: `segment_0${i + 1}.mp3`,
                durationMs: spec.clipMs,
                headMs,
                tailMs,
                words: [],
            },
        });

        const speechMs = spec.clipMs - headMs - tailMs;
        calSegs.push({
            id: spec.id,
            words: spec.words,
            chars: text.length,
            clipMs: spec.clipMs,
            speechMs,
            effWps: +(spec.words / (speechMs / 1000)).toFixed(3),
            textHash: narrationFingerprint(text),
        });

        cursor = endMs + (i < specs.length - 1 ? (gapsMs[i] ?? 1416) : 0);
    });

    const totW = calSegs.reduce((a, c) => a + c.words, 0);
    const totMs = calSegs.reduce((a, c) => a + c.speechMs, 0);
    const obsEff = totW / (totMs / 1000);
    const roundedSpeed = 1.2;

    const contentMs = segments.at(-1).endMs;

    return {
        observedEffWps: +obsEff.toFixed(3),
        timing: {
            project: { name: "demo", fps: 30, width: 1280, height: 720 },
            durationMs: contentMs,
            contentMs,
            leadInMs,
            segments,
        },
        // Byte-for-byte the object literal voice.mjs passes to JSON.stringify.
        calibration: {
            voiceId: "en-US-AvaNeural",
            roundedSpeed,
            aggregate: {
                words: totW,
                speechMs: totMs,
                observedEffWps: +obsEff.toFixed(3),
                observedSafeWps: +(obsEff / roundedSpeed).toFixed(3),
            },
            segments: calSegs,
        },
    };
}
