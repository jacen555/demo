// Two things a verification stage must get right.
//
//   1. check-levels called DIGITAL SILENCE a failed measurement. astats reports a silent
//      window as `-inf`, which fails `Number.isFinite`, so a correct measurement of the
//      deliberate ~2s lead-in was classified as "the file may have no audio track" — a
//      diagnosis that was false, at exit 1, on a good 4K render. `-inf` is an in-band
//      sentinel colliding with real data: the domain's legitimate extreme read as an
//      error value. Silence is a THIRD state, and "no audio track" is a claim that has to
//      be CHECKED rather than inferred from a missing number.
//
//   2. A calibration with no `textHash` is lineage UNPROVEN, and the report used to tell
//      the reader to "re-run the voice stage to record one" — which is a REGENERATION
//      wearing the words of a verification, and it cost a consumer a 25-minute render.
//
//      A tool to record the fingerprint without re-synthesising was built here and
//      WITHDRAWN. `textHash` is over the EXACT narration bytes, and no voice-stage-bound
//      record of them survives: `chars` is a count, and segments[].audio.words is the TTS
//      service's tokenisation, which does not voice punctuation — so `?` -> `!` is
//      invisible there while changing the hash. (storyboard.html holds the narration
//      verbatim, but S2 regenerates it from the current timing.json, so it follows edits
//      rather than recording a synthesis — a copy, not a receipt.) Evidence weaker than
//      the claim cannot establish the claim. What remains is the message, which now says
//      what is true and stops.
//
// The fixtures below are deliberately hostile to the obvious wrong fixes:
//
//   * The MEASURED astats fixture contains `RMS trough dB: -inf` and `Noise floor dB:
//     -inf`, because real astats output almost always does. A fix that asks "is `-inf`
//     anywhere in this output" reports a perfectly good window as silent.
//   * timingSeal_resealingAnEditedTimeline_producesAValidSealForEditedText pins the
//     property that killed the stamping tool: a valid seal is self-consistency, not
//     provenance, because `remix` re-seals timelines it did not synthesise.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { EXIT, timingSeal } from "../src/cli-support.mjs";
import {
    readAstatsLevels,
    findAudioStream,
    formatLevels,
    describeUnusableLevels,
} from "../src/astats-levels.mjs";
import { makeProject, runScript, assertCleanExit } from "./_helpers.mjs";
import { measuredProject } from "./_realistic-fixture.mjs";

// ---------------------------------------------------------------------------
// ffmpeg output fixtures — shaped as ffmpeg actually prints them.
// ---------------------------------------------------------------------------

/** The input dump ffmpeg prints before the filter output, with a real audio stream. */
const WITH_AUDIO_TRACK = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'EvalLoopDemo.mp4':
  Duration: 00:25:42.19, start: 0.000000, bitrate: 12043 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 3840x2160, 11845 kb/s, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 191 kb/s (default)
`;

/** The same dump for a file that genuinely carries no audio. */
const WITHOUT_AUDIO_TRACK = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'silent-render.mp4':
  Duration: 00:00:12.00, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 9000 kb/s, 30 fps
`;

/**
 * An astats block. Note `RMS trough dB` and `Noise floor dB` are `-inf` even for loud
 * audio — they are why "does the output mention -inf" is not a usable test for silence.
 */
const astatsBlock = (peak, rms) => `[Parsed_astats_0 @ 000001f2c0] Channel: 1
[Parsed_astats_0 @ 000001f2c0] DC offset: 0.000014
[Parsed_astats_0 @ 000001f2c0] Peak level dB: ${peak}
[Parsed_astats_0 @ 000001f2c0] RMS level dB: ${rms}
[Parsed_astats_0 @ 000001f2c0] RMS peak dB: ${peak}
[Parsed_astats_0 @ 000001f2c0] RMS trough dB: -inf
[Parsed_astats_0 @ 000001f2c0] Noise floor dB: -inf
[Parsed_astats_0 @ 000001f2c0] Overall
[Parsed_astats_0 @ 000001f2c0] Peak level dB: ${peak}
[Parsed_astats_0 @ 000001f2c0] RMS level dB: ${rms}
`;

const MEASURED_WINDOW =
    WITH_AUDIO_TRACK + astatsBlock("-4.278638", "-21.061829");
/** The deliberate lead-in: music has not started, speech has not started. Correctly measured. */
const SILENT_WINDOW = WITH_AUDIO_TRACK + astatsBlock("-inf", "-inf");
/** ffmpeg exited 0 but the filter never reported — the only genuinely unmeasurable case. */
const NO_ASTATS_AT_ALL =
    WITH_AUDIO_TRACK + "frame=   45 fps=0.0 q=-0.0 size=N/A time=00:00:01.50\n";

describe("check-levels — silence is a measurement, not a failure", () => {
    test("readAstatsLevels_measuredWindow_reportsTheLevels", () => {
        const levels = readAstatsLevels(MEASURED_WINDOW);

        assert.equal(levels.state, "measured");
        assert.equal(levels.rms, -21.061829);
        assert.equal(levels.peak, -4.278638);
    });

    // The defect. A correct measurement of the lead-in must not be classified as a failure.
    test("readAstatsLevels_silentWindowInAFileWithAudio_isSilentNotUnmeasurable", () => {
        const levels = readAstatsLevels(SILENT_WINDOW);

        assert.equal(
            levels.state,
            "silent",
            "digital silence IS the measurement astats reported",
        );
        assert.equal(
            levels.rms,
            -Infinity,
            "and it must carry the level, not a substitute",
        );
        assert.equal(levels.peak, -Infinity);
    });

    // The trap the obvious wrong fix falls into: `-inf` appears in healthy output too.
    test("readAstatsLevels_measuredWindowWhoseTroughIsMinusInf_isStillMeasured", () => {
        assert.match(
            MEASURED_WINDOW,
            /RMS trough dB: -inf/,
            "fixture must contain the decoy, or it proves nothing",
        );

        assert.equal(readAstatsLevels(MEASURED_WINDOW).state, "measured");
    });

    test("readAstatsLevels_noAstatsOutput_isUnmeasurable", () => {
        const levels = readAstatsLevels(NO_ASTATS_AT_ALL);

        assert.equal(levels.state, "unmeasurable");
        assert.match(
            levels.detail,
            /no .*RMS level dB/i,
            "the reason must name what was missing",
        );
    });

    test("readAstatsLevels_nonNumericLevel_isUnmeasurableAndQuotesTheToken", () => {
        const levels = readAstatsLevels(
            WITH_AUDIO_TRACK + astatsBlock("-4.2", "nan"),
        );

        assert.equal(levels.state, "unmeasurable");
        assert.match(
            levels.detail,
            /nan/,
            "the reason must quote the token it could not read",
        );
    });

    test("findAudioStream_fileWithAnAudioTrack_returnsTheStreamLine", () => {
        assert.match(String(findAudioStream(WITH_AUDIO_TRACK)), /Audio: aac/);
    });

    test("findAudioStream_fileWithVideoOnly_returnsNull", () => {
        assert.equal(findAudioStream(WITHOUT_AUDIO_TRACK), null);
    });

    // AUDIT OF THE FIX ITSELF. The stream regex tracks ffmpeg's output FORMAT, and a guard
    // keyed on a symptom expires when the symptom does. If a future ffmpeg reworded its
    // dump, "no stream matched" would mean "I could not read it", not "there is no track" —
    // and announcing the latter would be the original false diagnosis, freshly reintroduced
    // inside its own fix.
    test("describeUnusableLevels_streamDumpUnreadable_doesNotClaimThereIsNoAudioTrack", () => {
        const unparseable =
            "Input #0, mov, from 'mystery.mp4':\n  <audio elementary stream, aac>\n";
        const levels = readAstatsLevels(unparseable);

        const message = describeUnusableLevels(
            "mystery.mp4",
            unparseable,
            levels,
        );

        assert.doesNotMatch(
            message,
            /has no audio track/,
            "nothing was established, so nothing may be claimed",
        );
        assert.match(
            message,
            /NOT been established/i,
            "and the report must say so plainly",
        );
    });

    // A NaN reaching the formatter must not be rendered as digital silence: printing an
    // unknown value as a specific claim is the defect this module exists to undo.
    test("formatLevels_levelThatIsNeitherFiniteNorMinusInf_isNotPrintedAsSilence", () => {
        const line = formatLevels({ state: "measured", rms: NaN, peak: -4.2 });

        assert.doesNotMatch(line, /-inf/, "NaN is not silence");
        assert.match(
            line,
            /unreadable/,
            "an unreadable level must be named as unreadable",
        );
    });

    // A filename is printed mid-line on the `from '...'` line, so the stream match is
    // anchored — otherwise a path could assert the presence of a track that is not there.
    test("findAudioStream_filenameContainingTheStreamText_isNotMistakenForATrack", () => {
        const decoy = `Input #0, mov, from 'C:\\clips\\Stream #0:1: Audio: aac.mp4':
  Stream #0:0[0x1](und): Video: h264, yuv420p, 1920x1080
`;

        assert.equal(
            findAudioStream(decoy),
            null,
            "a path is not a stream declaration",
        );
    });

    // Assert the MESSAGE, not just that it refused: a "must refuse" test passes for free
    // when the subject refuses for an unrelated reason.
    test("describeUnusableLevels_fileWithAnAudioTrack_doesNotClaimThereIsNoAudioTrack", () => {
        const levels = readAstatsLevels(NO_ASTATS_AT_ALL);
        const message = describeUnusableLevels(
            "EvalLoopDemo.mp4",
            NO_ASTATS_AT_ALL,
            levels,
        );

        assert.doesNotMatch(
            message,
            /may have no audio track|has no audio track/,
            "the file HAS an audio track — naming a false cause is what sent the consumer looking in the wrong place",
        );
        assert.match(
            message,
            /Audio: aac/,
            "it must show the track it actually found",
        );
    });

    test("describeUnusableLevels_fileWithNoAudioStream_namesTheMissingTrackAsChecked", () => {
        const levels = readAstatsLevels(WITHOUT_AUDIO_TRACK);
        const message = describeUnusableLevels(
            "silent-render.mp4",
            WITHOUT_AUDIO_TRACK,
            levels,
        );

        assert.match(
            message,
            /the file has no audio track/,
            "now the diagnosis is earned, so it must be stated plainly",
        );
        assert.match(
            message,
            /1 stream\(s\), none of them audio/,
            "and it must show the evidence that earned it",
        );
    });

    test("formatLevels_silentWindow_printsMinusInfRatherThanNaNOrInfinity", () => {
        const line = formatLevels({
            state: "silent",
            rms: -Infinity,
            peak: -Infinity,
        });

        assert.match(line, /-inf/, "astats says -inf, so the report says -inf");
        assert.doesNotMatch(
            line,
            /NaN|Infinity/,
            "never print a JS artefact as though it were a level",
        );
        assert.match(
            line,
            /silence/i,
            "and it must be labelled, so a reader is not left guessing",
        );
    });

    test("formatLevels_measuredWindow_printsTheLevelsToOneDecimal", () => {
        const line = formatLevels({
            state: "measured",
            rms: -21.061829,
            peak: -4.278638,
        });

        assert.match(line, /RMS -21\.1 dB/);
        assert.match(line, /peak -4\.3 dBFS/);
    });
});

// ---------------------------------------------------------------------------
// The UNPROVEN message is itself an instruction, and it is now the WHOLE answer.
//
// A stamping tool was built for this and withdrawn. `textHash` is a fingerprint over the
// EXACT narration bytes, and no voice-stage-bound record of them survives: `chars` is a
// count, and segments[].audio.words is the TTS service's tokenisation, which does not
// voice punctuation — so "ends with ?" and "ends with !" are identical there while
// producing different hashes. Evidence weaker than the claim cannot establish the claim,
// so the report states what is true and stops.
//
// What it must still do is stop reading like a cheap verification step. "re-run the voice
// stage to record one" is a REGENERATION, and that instruction cost a consumer a
// 25-minute render before anyone noticed it was not a check.
// ---------------------------------------------------------------------------

const MEASURED = measuredProject(
    [
        { id: "hard", words: 93, clipMs: 24936 },
        { id: "bdd", words: 68, clipMs: 20208 },
    ],
    { gapsMs: [1416] },
);

/** A project whose calibration predates fingerprinting — the case the message addresses. */
function unprovenProject(t) {
    const timing = structuredClone(MEASURED.timing);
    const calibration = structuredClone(MEASURED.calibration);
    for (const c of calibration.segments) delete c.textHash;
    timing.timingHash = timingSeal(timing);
    return makeProject(t, {
        "timing.json": JSON.stringify(timing, null, 2),
        "calibration-observed.json": JSON.stringify(calibration, null, 2),
    });
}

describe("the UNPROVEN message must not send a reader to regenerate the artefact", () => {
    test("validateTiming_lineageUnproven_isReportedAsUnprovenRatherThanStale", (t) => {
        const dir = unprovenProject(t);

        const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

        assertCleanExit(
            r,
            EXIT.OK,
            "an unproven calibration is not a failure: ",
        );
        assert.match(
            r.all,
            /UNPROVEN/,
            "nothing disagrees, so this is unproven, not stale",
        );
        assert.doesNotMatch(
            r.all,
            /calibration lineage: STALE/,
            "STALE claims a disagreement that was never found",
        );
    });

    test("validateTiming_lineageUnproven_warnsThatVoiceApplyIsNotReadOnly", (t) => {
        const dir = unprovenProject(t);

        const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

        assert.match(
            r.all,
            /REGENERATION/,
            "the reader must be told what `voice --apply` actually is",
        );
        assert.match(
            r.all,
            /length-deterministic but NOT byte-deterministic/,
            "and why a re-run is not a no-op",
        );
        assert.match(
            r.all,
            /restore the/i,
            "and that the recovery exists, if they need both",
        );
    });

    // The withdrawn tool must not be advertised, and the impossibility must be stated
    // rather than left for the next person to rediscover by building it again.
    test("validateTiming_lineageUnproven_saysNoPostHocProofIsAvailableAndNamesNoTool", (t) => {
        const dir = unprovenProject(t);

        const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

        assert.match(
            r.all,
            /no way to record the fingerprint without re-synthesising/i,
        );
        assert.match(
            r.all,
            /EXACT narration bytes/,
            "and it must say why: the claim is over exact bytes",
        );
        assert.doesNotMatch(
            r.all,
            /stamp-lineage/,
            "a withdrawn tool must not be advertised",
        );
    });

    // The impossibility argument must be stated at the strength the evidence supports.
    // "nothing retains the exact narration" is FALSE — storyboard.html embeds voiceoverText
    // verbatim. It is not a receipt (S2 regenerates it from the current timing.json, so it
    // follows edits), but a reader who finds that file and reads an overbroad claim will
    // conclude the README is wrong and rebuild the withdrawn tool — the exact outcome this
    // message exists to prevent.
    test("validateTiming_lineageUnproven_boundsTheImpossibilityClaimToVoiceStageBoundRecords", (t) => {
        const dir = unprovenProject(t);

        const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

        assert.match(
            r.all,
            /VOICE-STAGE-BOUND/i,
            "the claim must be bounded, not absolute",
        );
        assert.match(
            r.all,
            /storyboard\.html/,
            "and the near-miss must be named rather than left to be found",
        );
        assert.doesNotMatch(
            r.all,
            /no artefact retains/i,
            "the overbroad form must not come back",
        );
    });

    // Guard against OVER-correcting. Where the narration genuinely changed, the audio on
    // disk really is for the old text and re-synthesising is the right move.
    test("validateTiming_genuineFingerprintMismatch_stillPrescribesTheVoiceStage", (t) => {
        const timing = structuredClone(MEASURED.timing);
        const seg = timing.segments[1];
        seg.voiceoverText = [
            "other",
            ...seg.voiceoverText.split(/\s+/).slice(1),
        ].join(" ");
        const dir = makeProject(t, {
            "timing.json": JSON.stringify(timing, null, 2),
            "calibration-observed.json": JSON.stringify(
                MEASURED.calibration,
                null,
                2,
            ),
        });

        const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

        assert.match(
            r.all,
            /calibration lineage: STALE/,
            "here something really does disagree",
        );
        assert.match(
            r.all,
            /does not match the fingerprint/,
            "and the fingerprint is what caught it",
        );
        assert.match(
            r.all,
            /Re-run the/,
            "so re-synthesising IS the right advice on this branch",
        );
    });

    test("voice_help_warnsThatApplyIsNotReadOnly", (t) => {
        const dir = makeProject(t, {});

        const r = runScript("voice.mjs", ["--help"], dir);

        assertCleanExit(r, EXIT.OK, "help must be free: ");
        assert.match(
            r.all,
            /NOT a verification step/,
            "the warning belongs where the instruction is read",
        );
        assert.doesNotMatch(
            r.all,
            /stamp-lineage/,
            "and must not point at a withdrawn tool",
        );
    });
});

describe("timingSeal — one definition of the seal, shared by voice and remix", () => {
    /** A sealed timeline, as voice.mjs and remix.mjs both leave one. */
    const sealed = () => {
        const timing = structuredClone(MEASURED.timing);
        timing.timingHash = timingSeal(timing);
        return timing;
    };

    test("timingSeal_ignoresAnExistingTimingHash_soResealingIsStable", () => {
        const timing = sealed();

        assert.equal(
            timingSeal(timing),
            timing.timingHash,
            "sealing a sealed timeline must reproduce the same seal",
        );
    });

    test("timingSeal_doesNotMutateTheTimelineItSeals", () => {
        const timing = sealed();
        const before = JSON.stringify(timing);

        timingSeal(timing);

        assert.equal(
            JSON.stringify(timing),
            before,
            "a verifier that edits its subject is not a verifier",
        );
    });

    test("timingSeal_narrationEditedByAnEqualLengthRewrite_changesTheSeal", () => {
        const timing = sealed();
        const before = timingSeal(timing);
        const seg = timing.segments[1];
        seg.voiceoverText = [
            "other",
            ...seg.voiceoverText.split(/\s+/).slice(1),
        ].join(" ");

        assert.notEqual(
            timingSeal(timing),
            before,
            "the seal is over the bytes, so a rewrite must break it",
        );
    });

    // The seal is self-consistency, NOT provenance. Pinned because reading it as provenance
    // is what produced a tool that certified lineage it could not establish: `remix` re-seals
    // a timeline it did not synthesise, so a valid seal says nothing about which stage wrote it.
    test("timingSeal_resealingAnEditedTimeline_producesAValidSealForEditedText", () => {
        const timing = sealed();
        const seg = timing.segments[1];
        seg.voiceoverText = [
            "other",
            ...seg.voiceoverText.split(/\s+/).slice(1),
        ].join(" ");

        delete timing.timingHash;
        timing.timingHash = timingSeal(timing); // exactly what remix.mjs does after reflowing

        assert.equal(
            timingSeal(timing),
            timing.timingHash,
            "the seal verifies — on text no voice stage ever spoke",
        );
    });
});
