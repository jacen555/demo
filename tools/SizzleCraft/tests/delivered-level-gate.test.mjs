// check-levels gates the DELIVERED RESULT, and the gate has to fire.
//
// The mix registry's audit (mix-parameters.mjs) accounts for every number in the final
// `-filter_complex` string, and its header lists seven things it cannot see — everything
// outside the graph (`-b:a`, `-ar`, a changed codec or `-map`), every non-numeric change,
// and two values moved within one chain among them. Until this gate existed, check-levels
// only REPORTED, and its own usage said so — "Exit codes: 0 every file measured (silence
// included)" — so a render that delivered no audio at all exited 0.
//
// Three properties are under test here, and the last two are the ones that are easy to
// fake:
//
//   1. SILENCE IN A WINDOW IS STILL CORRECT. The lead-in is deliberately silent and
//      astats reports `-inf`. A previous fix classified that as a failed measurement and
//      made this script exit 1 on every correct narration-only render. A gate that
//      refuses silence anywhere reintroduces exactly that.
//   2. THE GATE ACTUALLY REFUSES. A condition that passes everything is indistinguishable
//      from no gate at all, so every acceptance below is paired with a refusal of the same
//      shape.
//   3. THE CLI IS WIRED TO IT. A correct judge that check-levels never calls, or calls
//      without `wholeFile`, exits 0 on a silent render while every unit test still passes.
//      The last suite runs the real script end to end for that reason.
//
// ON THE BOUND THAT IS NOT HERE. A peak-above-full-scale refusal was built first, on the
// reasoning that remux-music clamps every mix below the rail. Measuring it instead of
// arguing it killed it: with the limiter CORRECTLY in force at the DEFAULT --ceiling 1.0,
// white noise measured +3.30 dBFS after the AAC encode, and +2.85 at --ceiling 0.1. The
// encode overshoots the clamped sample peaks by an amount the material decides, far past
// any headroom a supported ceiling leaves, so an over-the-rail reading is not evidence of
// a bad render. The reading that proves it is pinned in a test below so the bound cannot
// be reintroduced from the same plausible reasoning. judgeDeliveredLevels carries the
// sweep.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  readAstatsLevels,
  judgeDeliveredLevels,
} from "../src/astats-levels.mjs";
import { makeProject, runScript } from "./_helpers.mjs";

/** The input dump ffmpeg prints before the filter output, with a real audio stream. */
const WITH_AUDIO_TRACK = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'render-with-music.mp4':
  Duration: 00:04:12.19, start: 0.000000, bitrate: 12043 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 3840x2160, 11845 kb/s, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 191 kb/s (default)
`;

/**
 * An astats block as ffmpeg prints it. `RMS trough dB` and `Noise floor dB` are `-inf`
 * even for loud audio, which is why "does this output mention -inf" never tests silence.
 */
const astatsBlock = (peak, rms) => `[Parsed_astats_0 @ 000001f2c0] Channel: 1
[Parsed_astats_0 @ 000001f2c0] Peak level dB: ${peak}
[Parsed_astats_0 @ 000001f2c0] RMS level dB: ${rms}
[Parsed_astats_0 @ 000001f2c0] RMS trough dB: -inf
[Parsed_astats_0 @ 000001f2c0] Noise floor dB: -inf
[Parsed_astats_0 @ 000001f2c0] Overall
[Parsed_astats_0 @ 000001f2c0] Peak level dB: ${peak}
[Parsed_astats_0 @ 000001f2c0] RMS level dB: ${rms}
`;

/**
 * A real reading of a real render: the mix this pipeline delivers, limited at the default
 * --ceiling 1.0 and encoded to AAC (ffmpeg 9.0.2).
 */
const LIMITED_RENDER = WITH_AUDIO_TRACK + astatsBlock("-0.226870", "-5.104190");
/** A window of digital silence, which is what the lead-in correctly measures. */
const SILENT_WINDOW = WITH_AUDIO_TRACK + astatsBlock("-inf", "-inf");

const WHOLE_FILE = { label: "whole file", wholeFile: true };
const LEAD_IN = { label: "lead-in (first 1.5s)", wholeFile: false };
const TAIL = { label: "last 2s (tail)", wholeFile: false };

describe("check-levels — silence in a window stays a measurement, not a failure", () => {
  test("judgeDeliveredLevels_silentLeadInWindow_isAccepted", () => {
    // The regression this pipeline has already shipped once. The lead-in is silent BY
    // DESIGN, astats reports -inf, and exiting 1 on that made the last gate before
    // delivery red on every correct narration-only render.
    assert.equal(
      judgeDeliveredLevels(readAstatsLevels(SILENT_WINDOW), LEAD_IN),
      null,
      "digital silence in the lead-in is the correct measurement of a correct render",
    );
  });

  test("judgeDeliveredLevels_silentTailWindow_isAccepted", () => {
    assert.equal(
      judgeDeliveredLevels(readAstatsLevels(SILENT_WINDOW), TAIL),
      null,
    );
  });

  test("judgeDeliveredLevels_measuredWholeFile_isAccepted", () => {
    assert.equal(
      judgeDeliveredLevels(readAstatsLevels(LIMITED_RENDER), WHOLE_FILE),
      null,
    );
  });

  // THE POSITIVE CONTROL for the three above: silence is tolerated because the WINDOW is
  // allowed to be silent, not because silence is never judged. A whole file with no sound
  // anywhere in it has not delivered the narration it was made of — the `-map` /
  // wrong-stream class the graph audit cannot see at all — and it is refused.
  test("judgeDeliveredLevels_wholeFileIsDigitalSilence_refusesAndSaysWhatItFound", () => {
    const refusal = judgeDeliveredLevels(
      readAstatsLevels(SILENT_WINDOW),
      WHOLE_FILE,
    );

    assert.notEqual(
      refusal,
      null,
      "a render with no audio in it anywhere must not ship",
    );
    assert.match(
      refusal,
      /whole file/,
      "the refusal must name the window that failed",
    );
    assert.match(refusal, /silen/i, "it must say what it found");
    assert.match(
      refusal,
      /-map/,
      "and point at where to look, not just report a verdict",
    );
    assert.match(
      refusal,
      /--allow-silent/,
      "and name the one case where it is wrong",
    );
  });

  test("judgeDeliveredLevels_wholeFileSilentButNoAudioExpected_isAccepted", () => {
    // A SUPPORTED render, not an escape hatch. concat-audio documents a timeline where
    // every segment is deliberately silent — "no clip is matched to anything and each
    // window is generated" (README) — and that render is correctly silent end to end.
    // Refusing it would be the lead-in regression repeated one level up, which is why the
    // caller declares the case rather than the gate guessing it from the audio.
    assert.equal(
      judgeDeliveredLevels(readAstatsLevels(SILENT_WINDOW), {
        ...WHOLE_FILE,
        audioExpected: false,
      }),
      null,
    );
  });
});

describe("check-levels — the gate judges only what it measured", () => {
  test("judgeDeliveredLevels_peakOverFullScale_isAcceptedBecauseTheEncodeOvershoots", () => {
    // NOT an oversight. With the limiter correctly in force at the DEFAULT --ceiling 1.0,
    // white noise measured +3.295152 dBFS after the AAC encode on ffmpeg 9.0.2 — this
    // reading is that measurement. A peak bound would have refused a render that is
    // exactly what was asked for. Pinned so the bound cannot come back on the reasoning
    // that "remux-music clamps below the rail", which is true and still not sufficient.
    const correctButOverTheRail = readAstatsLevels(
      WITH_AUDIO_TRACK + astatsBlock("3.295152", "-11.4"),
    );

    assert.equal(correctButOverTheRail.state, "measured");
    assert.equal(judgeDeliveredLevels(correctButOverTheRail, WHOLE_FILE), null);
  });

  test("judgeDeliveredLevels_unmeasurableWindow_isNotJudged", () => {
    // Unmeasurable is already a refusal one layer up, at EXIT.FAILED, with a message that
    // names the cause. The gate must not re-decide it from levels it never got, which is
    // how "the file may have no audio track" was asserted about files that had one.
    const unmeasurable = readAstatsLevels(
      WITH_AUDIO_TRACK + "frame= 45 fps=0.0 time=00:00:01.50\n",
    );

    assert.equal(unmeasurable.state, "unmeasurable");
    assert.equal(judgeDeliveredLevels(unmeasurable, WHOLE_FILE), null);
  });
});

/** The marker path the fake answers for. It is never executed, so it need not exist. */
const MARKER_FFMPEG = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "no-such-ffmpeg.exe",
);

/** The --import URL of the canned-astats ffmpeg. See _fake-astats.mjs. */
function fakeAstats({ whole, window: win }) {
  const url = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "_fake-astats.mjs"),
  );
  url.search = new URLSearchParams({
    ffmpeg: MARKER_FFMPEG,
    whole,
    ...(win ? { window: win } : {}),
  }).toString();
  return url.href;
}

/** Runs the real check-levels against a canned reading. Each window is `peak,rms`. */
function checkLevels(t, { whole, window: win, args = [] }) {
  const dir = makeProject(t, {
    "render.mp4": "not really a video; ffmpeg is faked",
  });
  return runScript(
    "check-levels.mjs",
    ["--project", dir, "--ffmpeg", MARKER_FFMPEG, ...args, "render.mp4"],
    dir,
    { nodeArgs: ["--import", fakeAstats({ whole, window: win })] },
  );
}

describe("check-levels — the CLI is wired to the gate", () => {
  test("checkLevels_silentLeadInAndMeasuredWholeFile_reportsAndExitsZero", (t) => {
    // THE POSITIVE CONTROL, and the one that matters most: the shape of a CORRECT
    // narration-only render. Silent lead-in, silent tail, audio overall. If the gate is
    // wired to the wrong window this exits 1, and this pipeline has shipped that bug.
    const r = checkLevels(t, {
      whole: "-0.226870,-5.104190",
      window: "-inf,-inf",
    });

    assert.equal(r.code, 0, `a correct render must pass; got:\n${r.all}`);
    assert.match(
      r.all,
      /digital silence/i,
      "the silent window is still reported as measured",
    );
    assert.match(
      r.all,
      /-0\.2 dBFS/,
      "and the whole-file reading is still printed",
    );
  });

  test("checkLevels_wholeFileIsDigitalSilence_exitsFailedAndNamesTheFile", (t) => {
    const r = checkLevels(t, { whole: "-inf,-inf" });

    assert.equal(
      r.code,
      1,
      `a silent render must be refused at EXIT.FAILED; got:\n${r.all}`,
    );
    assert.match(
      r.all,
      /carry no audio/i,
      "the refusal must say what is wrong",
    );
    assert.match(
      r.all,
      /render\.mp4/,
      "and name the file that must not be delivered",
    );
    // The whole report prints BEFORE the refusal. A gate that stops at the first bad
    // window hides the measurements that are the context for fixing it.
    assert.match(r.all, /whole file[\s\S]*lead-in[\s\S]*tail/i);
  });

  test("checkLevels_wholeFileIsDigitalSilence_isNotRefusedAsUsage", (t) => {
    // EXIT.USAGE is "the caller's fault / a missing prerequisite". A render that measured
    // fine and carries no audio is work that RAN and produced a bad result, which is
    // EXIT.FAILED — see EXIT in cli-support.mjs. Asserting the code is not 2 keeps the
    // distinction from quietly collapsing.
    const r = checkLevels(t, { whole: "-inf,-inf" });

    assert.notEqual(r.code, 2, "a bad result is not a usage error");
  });

  test("checkLevels_wholeFileIsDigitalSilenceWithAllowSilent_exitsZero", (t) => {
    // The escape is NARROW and it is wired: the same render that was refused above passes
    // once the caller declares the timeline silent. Paired with the refusal immediately
    // above, this is what shows the flag is read rather than ignored — and that the gate
    // is not simply off.
    const r = checkLevels(t, {
      whole: "-inf,-inf",
      args: ["--allow-silent"],
    });

    assert.equal(
      r.code,
      0,
      `a declared-silent render must pass; got:\n${r.all}`,
    );
    assert.doesNotMatch(r.all, /must not be delivered/);
  });

  test("checkLevels_allowSilent_doesNotSuppressAnUnmeasurableWindow", (t) => {
    // --allow-silent declares one thing: that no audio was expected. It must not become a
    // general quietener — an unreadable measurement is still a refusal, and that refusal
    // predates this gate.
    const r = checkLevels(t, {
      whole: "not-a-number,not-a-number",
      args: ["--allow-silent"],
    });

    assert.equal(
      r.code,
      1,
      `an unmeasurable window must still fail; got:\n${r.all}`,
    );
  });
});
