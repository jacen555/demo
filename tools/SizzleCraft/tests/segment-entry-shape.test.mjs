/*
 * A null entry in `timing.segments` must be REFUSED, not crashed on.
 *
 * Measured before the fix, plan path, nothing written, at b375d95:
 *
 *   frame-capture.mjs     TypeError: Cannot read properties of null (reading 'endMs')   exit 1
 *   write-storyboard.mjs  TypeError: Cannot read properties of null (reading 'visual')  exit 1
 *   concat-audio.mjs      TypeError: Cannot read properties of null (reading 'audio')   exit 1
 *
 * Exit 1 there is Node's default for an uncaught exception, not a designed refusal — the
 * path had no exit code at all. EXIT.USAGE is therefore naming a code for a path that
 * never had one, and is what cli-support.mjs's own semantics require: a null where a
 * segment object belongs is bad input, refused before any work runs.
 *
 * THE RULE HAS ONE STATEMENT. `segmentEntryBlocker` (silent-segment.mjs) is the whole-list
 * form of the predicate `shapeBlocker` itself calls, so these three stages and the two
 * gates cannot drift into separate accounts of what a segment entry is.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHANGE, and why each is pinned below rather than
 * asserted in a comment:
 *   - an ID-LESS segment stays accepted in all three. frame-capture.mjs tolerates one ON
 *     PURPOSE and labels it by index, because `segment "1"` would send an author to the
 *     wrong line when another segment really carries the id "1". Adopting shapeBlocker
 *     wholesale to fix the crash would have silently reversed that — and no test would
 *     have caught it, which is why these pins exist.
 *   - an EMPTY, ABSENT or NON-ARRAY list keeps exactly the behaviour each stage has today,
 *     including concat-audio's own wording and its exit 1. `segmentEntryBlocker` returns
 *     null for a non-array by design: it refuses entries and has no opinion about lists.
 *
 * This file is separate from silent-segments.test.mjs on purpose: that file is edited by
 * another stream, and these tests span three stages rather than belonging to any one of
 * the existing per-stage suites.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { EXIT } from "../src/cli-support.mjs";
import { makeProject, runScript } from "./_helpers.mjs";
import {
    ttsClip,
    ttsWords,
    FRAME_MS,
    HEAD_FRAMES,
    TAIL_FRAMES,
    FRAMES_PER_WORD,
} from "./fixtures/fake-audio-backends.mjs";

// --------------------------------------------------------------------------------------
// Fixtures — a timeline every one of the three stages can read, with real marker-frame
// clips whose measured duration matches what the timeline declares. The control MUST plan
// cleanly in all three, or a refusal below proves only that the fixture is broken.
// --------------------------------------------------------------------------------------

const clipMs = (text) =>
    (HEAD_FRAMES + ttsWords(text).length * FRAMES_PER_WORD + TAIL_FRAMES) *
    FRAME_MS;

function segment(id, startMs, file, text) {
    const durationMs = clipMs(text);
    return {
        id,
        startMs,
        endMs: startMs + durationMs,
        voiceoverText: text,
        audio: {
            file,
            durationMs,
            headMs: HEAD_FRAMES * FRAME_MS,
            tailMs: TAIL_FRAMES * FRAME_MS,
            words: ttsWords(text).map((word, k) => ({
                word,
                startMs:
                    startMs + (HEAD_FRAMES + k * FRAMES_PER_WORD) * FRAME_MS,
                endMs:
                    startMs +
                    (HEAD_FRAMES + (k + 1) * FRAMES_PER_WORD) * FRAME_MS,
            })),
        },
    };
}

const ONE = segment("one", 0, "segment_000.mp3", "hello there friend");
const TWO = segment("two", ONE.endMs, "segment_001.mp3", "second segment here");

const timing = (segments, durationMs = TWO.endMs) =>
    JSON.stringify({
        project: {
            name: "demo",
            fps: 30,
            width: 1280,
            height: 720,
            lede: "a lede",
        },
        durationMs,
        contentMs: durationMs,
        outroMs: 2500,
        endCard: { enabled: true },
        // aspectRatio is carried so the metadata tests below isolate an absent `project` or
        // `intake`. It has its own unguarded site, pinned separately at the end of this file.
        aspectRatio: "16:9",
        intake: {
            leadInMs: 2000,
            perceivedGapMs: 2000,
            toleranceMs: 750,
            voice: "en-US-AvaNeural",
            speed: 1,
            silenceMs: 2000,
        },
        segments,
    });

/** The same two segments, with the second carrying no id at all. */
const idless = () => {
    const s = structuredClone(TWO);
    delete s.id;
    return [ONE, s];
};

/** A project every one of the three stages can plan in. */
const project = (t, segments, durationMs) =>
    makeProject(t, {
        "timing.json": timing(segments, durationMs),
        "brand/tokens.json": JSON.stringify({
            audio: { ttsVoices: ["en-US-AvaNeural"] },
        }),
        "video-auto.html": "<html></html>",
        "segment_000.mp3": ttsClip("hello there friend"),
        "segment_001.mp3": ttsClip("second segment here"),
        "silence.mp3": ttsClip("pause"),
    });

/** A segment whose `silence` declaration is malformed — `silence: null` is an own property. */
const badlyDeclaredSilence = () => ({ ...structuredClone(ONE), silence: null });

const STAGES = [
    "frame-capture.mjs",
    "write-storyboard.mjs",
    "concat-audio.mjs",
];

/** Everything the run printed, and whether it ended in an uncaught exception. */
function plan(t, stage, segments, durationMs) {
    return planWith(t, stage, timing(segments, durationMs));
}

/** The same, for a timing document that cannot be expressed as a segment array. */
function planWith(t, stage, body) {
    const dir = makeProject(t, {
        "timing.json": body,
        "brand/tokens.json": JSON.stringify({
            audio: { ttsVoices: ["en-US-AvaNeural"] },
        }),
        "video-auto.html": "<html></html>",
        "segment_000.mp3": ttsClip("hello there friend"),
        "segment_001.mp3": ttsClip("second segment here"),
        "silence.mp3": ttsClip("pause"),
    });
    const before = new Set(fs.readdirSync(dir));
    const r = runScript(stage, [], dir);
    return {
        ...r,
        dir,
        wrote: fs.readdirSync(dir).filter((f) => !before.has(f)),
    };
}

/** The control timing with its segment list replaced by something that is not a list. */
const listShaped = (replacement) => {
    const doc = JSON.parse(timing([ONE, TWO]));
    if (replacement === undefined) delete doc.segments;
    else doc.segments = replacement;
    return JSON.stringify(doc);
};

const crashed = (r) =>
    /^(TypeError|ReferenceError)\b/m.test(r.all) && /\n\s+at /.test(r.all);

// --------------------------------------------------------------------------------------
// The control. Every assertion below is only worth something if this passes.
// --------------------------------------------------------------------------------------

describe("the control timeline plans cleanly in every stage", () => {
    for (const stage of STAGES) {
        test(`${stage.replace(".mjs", "")}_wellFormedTimeline_plansCleanlyWritingNothing`, (t) => {
            const r = plan(t, stage, [ONE, TWO]);

            assert.equal(
                r.code,
                EXIT.OK,
                `the control must plan cleanly or nothing here proves anything\n${r.all}`,
            );
            assert.equal(crashed(r), false, r.all);
            assert.deepEqual(r.wrote, [], "and a plan writes nothing");
        });
    }
});

// --------------------------------------------------------------------------------------
// R4: the null entry
// --------------------------------------------------------------------------------------

describe("a null entry in timing.segments is refused, not crashed on", () => {
    for (const stage of STAGES) {
        test(`${stage.replace(".mjs", "")}_timelineWithANullSegmentEntry_refusesNamingTheIndex`, (t) => {
            const r = plan(t, stage, [ONE, null]);

            assert.equal(
                crashed(r),
                false,
                `a malformed timeline must not reach an uncaught exception\n${r.all}`,
            );
            assert.equal(
                r.code,
                EXIT.USAGE,
                `bad input is a usage refusal, not a failed run\n${r.all}`,
            );
            assert.match(
                r.all,
                /timing\.segments\[1\] is not a segment object/,
                "the refusal must name the entry by its index, since it has no id to be named by",
            );
            assert.deepEqual(r.wrote, [], "and nothing may be written");
        });
    }

    // The index is read off the list, not guessed: a null in a different position must be
    // named for where it actually is.
    test("frameCapture_nullEntryAtTheHeadOfTheList_namesIndexZeroNotIndexOne", (t) => {
        const r = plan(t, "frame-capture.mjs", [null, TWO]);

        assert.equal(crashed(r), false, r.all);
        assert.match(
            r.all,
            /timing\.segments\[0\] is not a segment object/,
            r.all,
        );
    });

    // An array and a string are not segment objects either, and must not be coerced into
    // one — `typeof [] === 'object'` is exactly the hole the predicate closes.
    for (const [label, entry] of [
        ["anArray", []],
        ["aString", "two"],
        ["aNumber", 7],
    ]) {
        test(`writeStoryboard_entryThatIs_${label}_isRefusedAsNotASegmentObject`, (t) => {
            const r = plan(t, "write-storyboard.mjs", [ONE, entry]);

            assert.equal(crashed(r), false, r.all);
            assert.equal(r.code, EXIT.USAGE, r.all);
            assert.match(
                r.all,
                /timing\.segments\[1\] is not a segment object/,
                r.all,
            );
        });
    }
});

// --------------------------------------------------------------------------------------
// What this change must NOT touch. These pin the decisions that wholesale adoption of
// shapeBlocker would have reversed — six behaviour changes that no test covered.
// --------------------------------------------------------------------------------------

describe("the entry rule does not bring the id rule or the list rule with it", () => {
    for (const stage of STAGES) {
        test(`${stage.replace(".mjs", "")}_segmentWithNoId_isStillAccepted`, (t) => {
            const r = plan(t, stage, idless());

            assert.equal(crashed(r), false, r.all);
            assert.equal(
                r.code,
                EXIT.OK,
                `an id-less segment is tolerated on purpose and labelled by index — refusing it here would ` +
                    `reverse frame-capture's documented decision\n${r.all}`,
            );
        });
    }

    // Each stage answers the list question its own way, today. The entry rule has no opinion
    // about lists, so every one of these must read exactly as it did before.
    test("frameCapture_emptySegmentList_isStillTolerated", (t) => {
        const r = plan(t, "frame-capture.mjs", [], 4000);

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.OK, r.all);
    });

    test("writeStoryboard_emptySegmentList_isStillTolerated", (t) => {
        const r = plan(t, "write-storyboard.mjs", [], 4000);

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.OK, r.all);
    });

    // concat-audio already refuses an empty list, with its own wording and its own code.
    // Both are shipped, and the wording is better than the shared gate's. Left alone.
    test("concatAudio_emptySegmentList_keepsItsOwnRefusalAndItsOwnExitCode", (t) => {
        const r = plan(t, "concat-audio.mjs", [], 4000);

        assert.equal(crashed(r), false, r.all);
        assert.equal(
            r.code,
            EXIT.FAILED,
            `concat-audio's own exit code for this is 1, and it is shipped\n${r.all}`,
        );
        assert.match(
            r.all,
            /timing\.json declares no segments — there is nothing to concatenate/,
            "and its own longer wording survives",
        );
    });
});

// --------------------------------------------------------------------------------------
// PRECEDENCE. The entry guard was placed BEFORE write-storyboard's silence-declaration
// check on purpose, which changes which refusal a timeline carrying BOTH defects gets.
// That is a contract, so it is pinned rather than left to the placement.
//
// The reason for the order: `isSilentSegment(null)` is false, so the declaration check
// SKIPS a null entry and then refuses something else — reporting a caption problem on one
// segment while another entry is not a segment at all. Shape first means the reader is
// told what is actually wrong with the file.
// --------------------------------------------------------------------------------------

describe("a malformed entry is reported before a malformed silence declaration", () => {
    test("writeStoryboard_timelineWithBothANullEntryAndABadSilenceDeclaration_reportsTheEntry", (t) => {
        const r = plan(t, "write-storyboard.mjs", [
            badlyDeclaredSilence(),
            null,
        ]);

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.USAGE, r.all);
        assert.match(
            r.all,
            /timing\.segments\[1\] is not a segment object/,
            "the shape must be reported first",
        );
        assert.doesNotMatch(
            r.all,
            /declares `silence`/,
            "and the declaration problem must not be what a reader is sent to fix while an entry is not a segment",
        );
    });

    // THE CONTROL FOR THAT ORDERING. With no null entry, the declaration check still runs
    // and still refuses — the guard must not have swallowed it.
    test("writeStoryboard_timelineWithOnlyABadSilenceDeclaration_stillReportsTheDeclaration", (t) => {
        const r = plan(t, "write-storyboard.mjs", [
            badlyDeclaredSilence(),
            TWO,
        ]);

        assert.equal(crashed(r), false, r.all);
        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.match(
            r.all,
            /declares `silence`/,
            "the declaration check must still fire when nothing shadows it",
        );
    });
});

// --------------------------------------------------------------------------------------
// THE LIST RULE IS NOT THIS RULE — including where that leaves a crash in place.
//
// `segmentEntryBlocker` returns null for a non-array, so an absent or non-array list keeps
// exactly the behaviour each stage had. For two of them that behaviour is an uncaught
// TypeError, which this task deliberately does NOT fix: it is a different defect, in the
// same files, logged to shape-first-everywhere. Pinned here so the next reader knows it is
// known and scoped out rather than overlooked — and so that fixing it has to come here and
// change these expectations deliberately.
// --------------------------------------------------------------------------------------

describe("an absent or non-array segment list keeps each stage exactly as it was", () => {
    test("concatAudio_absentSegmentList_keepsItsOwnRefusal", (t) => {
        const r = planWith(t, "concat-audio.mjs", listShaped(undefined));

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.FAILED, r.all);
        assert.match(
            r.all,
            /timing\.json declares no segments — there is nothing to concatenate/,
            r.all,
        );
    });

    test("concatAudio_nonArraySegmentList_keepsItsOwnRefusal", (t) => {
        const r = planWith(t, "concat-audio.mjs", listShaped("two of them"));

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.FAILED, r.all);
        assert.match(
            r.all,
            /timing\.json declares no segments — there is nothing to concatenate/,
            r.all,
        );
    });

    test("frameCapture_absentSegmentList_isStillTolerated", (t) => {
        const r = planWith(t, "frame-capture.mjs", listShaped(undefined));

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.OK, r.all);
    });

    // CHANGED DELIBERATELY by shape-first-everywhere. This used to assert the crash, with the
    // note "if this ever stops crashing, it was fixed — update this expectation". It was
    // fixed, so the expectation is updated here rather than deleted: a list that is PRESENT
    // but not an array cannot be read, and is refused.
    test("frameCapture_nonArraySegmentList_isRefusedRatherThanCrashing", (t) => {
        const r = planWith(t, "frame-capture.mjs", listShaped("two of them"));

        assert.equal(
            crashed(r),
            false,
            `a list that cannot be read must be refused, not crashed on\n${r.all}`,
        );
        assert.equal(r.code, EXIT.USAGE, r.all);
        assert.match(
            r.all,
            /timing\.segments is not a list of segments/,
            r.all,
        );
    });

    // Also changed deliberately, same reason. For write-storyboard an ABSENT list is now
    // treated as an empty one — which is what this file already intended at the plan line,
    // `t.segments?.length ?? 0` — and only a non-array is refused.
    test("writeStoryboard_absentSegmentList_isTreatedAsAnEmptyOne", (t) => {
        const r = planWith(t, "write-storyboard.mjs", listShaped(undefined));

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.OK, r.all);
        assert.match(r.all, /0 segment\(s\)/, r.all);
    });

    test("writeStoryboard_nullSegmentList_isTreatedAsAnEmptyOne", (t) => {
        const r = planWith(t, "write-storyboard.mjs", listShaped(null));

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.OK, r.all);
        assert.match(r.all, /0 segment\(s\)/, r.all);
    });

    test("writeStoryboard_nonArraySegmentList_isRefusedRatherThanCrashing", (t) => {
        const r = planWith(
            t,
            "write-storyboard.mjs",
            listShaped("two of them"),
        );

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.USAGE, r.all);
        assert.match(
            r.all,
            /timing\.segments is not a list of segments/,
            r.all,
        );
    });

    // A null list is NOT a non-array for frame-capture either: `null || []` already made it
    // behave as empty, and that is preserved rather than converted into a refusal.
    test("frameCapture_nullSegmentList_isStillTolerated", (t) => {
        const r = planWith(t, "frame-capture.mjs", listShaped(null));

        assert.equal(crashed(r), false, r.all);
        assert.equal(r.code, EXIT.OK, r.all);
    });
});

// --------------------------------------------------------------------------------------
// THE OTHER HALF OF THE SAME MISTAKE. `t.project` and `t.intake` are rendering metadata,
// not the timeline: a storyboard with no intake has nothing to put in one badge, whereas a
// segments list that is not a list means the file cannot be read at all. So absence is
// rendered blank here rather than refused — the decision the user made at the gate, and
// the idiom this file already used for missing FIELDS (`t.project.lede || ... || ''`).
//
// NOT A TYPE CHECK. A `project` that is a string does not crash and never did — `'demo'.title`
// is undefined, which renders empty. Refusing it would widen past the defect, which is the
// trap the R4 measurement caught.
// --------------------------------------------------------------------------------------

describe("absent rendering metadata is rendered blank, not crashed on", () => {
    const withoutKey = (key) => {
        const doc = JSON.parse(timing([ONE, TWO]));
        delete doc[key];
        return JSON.stringify(doc);
    };

    for (const key of ["project", "intake"]) {
        test(`writeStoryboard_absent_${key}_plansAndRendersWithoutCrashing`, (t) => {
            const r = planWith(t, "write-storyboard.mjs", withoutKey(key));

            assert.equal(
                crashed(r),
                false,
                `an absent ${key} must not reach an uncaught exception\n${r.all}`,
            );
            assert.equal(r.code, EXIT.OK, r.all);
        });

        test(`writeStoryboard_absent_${key}_withApply_writesAStoryboardNamingNoUndefined`, (t) => {
            const dir = makeProject(t, {
                "timing.json": withoutKey(key),
                "brand/tokens.json": JSON.stringify({
                    audio: { ttsVoices: ["en-US-AvaNeural"] },
                }),
                "segment_000.mp3": ttsClip("hello there friend"),
                "segment_001.mp3": ttsClip("second segment here"),
            });

            const r = runScript("write-storyboard.mjs", ["--apply"], dir);

            assert.equal(r.code, EXIT.OK, r.all);
            const html = fs.readFileSync(
                path.join(dir, "storyboard.html"),
                "utf8",
            );
            assert.doesNotMatch(
                html,
                /undefined/,
                'a blank badge renders blank — the string "undefined" in a review artifact is the crash in a quieter coat',
            );
        });
    }

    // THE CONTROL. The badges must still carry their values when the metadata IS there, or
    // "renders blank" would just be "renders nothing, always".
    test("writeStoryboard_metadataPresent_stillRendersItIntoTheBadges", (t) => {
        const dir = makeProject(t, {
            "timing.json": timing([ONE, TWO]),
            "brand/tokens.json": JSON.stringify({
                audio: { ttsVoices: ["en-US-AvaNeural"] },
            }),
            "segment_000.mp3": ttsClip("hello there friend"),
            "segment_001.mp3": ttsClip("second segment here"),
        });

        const r = runScript("write-storyboard.mjs", ["--apply"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        const html = fs.readFileSync(path.join(dir, "storyboard.html"), "utf8");
        assert.match(
            html,
            /en-US-AvaNeural/,
            "the voice badge must carry the voice",
        );
        assert.match(html, /1280/, "and the dimensions badge its width");
    });

    // A wrong-TYPED project is not a crash and is not this task's business. Pinned so that
    // widening into it later is a deliberate act rather than a side effect.
    test("writeStoryboard_projectThatIsAString_isNotRefused_knownAndScopedOut", (t) => {
        const doc = JSON.parse(timing([ONE, TWO]));
        doc.project = "demo";

        const r = planWith(t, "write-storyboard.mjs", JSON.stringify(doc));

        assert.equal(crashed(r), false, r.all);
        assert.equal(
            r.code,
            EXIT.OK,
            "it renders empty badges today, and refusing it would widen past the defect",
        );
    });

    // OUT OF SCOPE, AND STILL WRONG. `${t.aspectRatio}` is the one token in that badge not
    // passed through `esc()`, so an absent aspectRatio renders the literal string "undefined"
    // beside siblings that now render blank. It does not crash, which is why it was excluded
    // at the gate: silent garbage is a different class from an uncaught exception, and this
    // task fixed crashes. Pinned so the next one has to change this expectation on purpose.
    test("writeStoryboard_absentAspectRatio_stillRendersTheStringUndefined_knownAndScopedOut", (t) => {
        const doc = JSON.parse(timing([ONE, TWO]));
        delete doc.aspectRatio;
        const dir = makeProject(t, {
            "timing.json": JSON.stringify(doc),
            "brand/tokens.json": JSON.stringify({
                audio: { ttsVoices: ["en-US-AvaNeural"] },
            }),
            "segment_000.mp3": ttsClip("hello there friend"),
            "segment_001.mp3": ttsClip("second segment here"),
        });

        const r = runScript("write-storyboard.mjs", ["--apply"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        assert.match(
            fs.readFileSync(path.join(dir, "storyboard.html"), "utf8"),
            /<span>undefined · /,
            "if this ever stops saying undefined, it was fixed — update this expectation",
        );
    });
});
// --------------------------------------------------------------------------------------
// ITEM 2 — the no-segments refusal names what to do next, and FOLLOWING IT WORKS.
//
// A remedy is a claim about what happens next, so it is verified by following it and
// watching the run be accepted — not by reading it. A sibling stream burned three rounds
// on a remedy that was a referral loop: voice sent the author to remix, and remix refuses
// that very timeline. None of its three failures was visible by reading.
//
// Only this fact gains a remedy. "timing.segments[1] is not a segment object" and
// "...'s id is missing — every segment needs a non-empty string id" each state their own
// fix in the sentence; adding one to the id rule alone would have cost 39 test updates to
// restate the clause above it. That was the user's call at the gate.
// --------------------------------------------------------------------------------------

describe("a timeline with no segments is told what to do next", () => {
    const bare = (segments) =>
        JSON.stringify({
            project: { name: "demo", fps: 30, width: 1280, height: 720 },
            durationMs: 1000,
            contentMs: 1000,
            ...(segments === undefined ? {} : { segments }),
        });

    const remixIn = (t, body) => {
        const dir = makeProject(t, {
            "timing.json": body,
            "brand/tokens.json": JSON.stringify({
                audio: { ttsVoices: ["en-US-AvaNeural"] },
            }),
        });
        return { ...runScript("remix.mjs", [], dir), dir };
    };

    for (const [label, segments] of [
        ["noSegmentsKey", undefined],
        ["anEmptyList", []],
    ]) {
        test(`remix_${label}_refusesWithTheFactAndARemedy`, (t) => {
            const r = remixIn(t, bare(segments));

            assert.equal(r.code, EXIT.USAGE, r.all);
            assert.match(
                r.all,
                /timing\.json declares no segments/,
                "the fact",
            );
            assert.match(
                r.all,
                /each needs a non-empty string id/,
                `and the remedy\n${r.all}`,
            );
        });
    }

    // THE REMEDY FOLLOWED. Not "the message reads well" — the thing it tells an author to do
    // is done here, and the refusal that gave the advice must be gone afterwards. That is the
    // only assertion that can catch a remedy which sends someone in a circle.
    test("remix_followingTheNoSegmentsRemedy_clearsTheRefusalThatGaveIt", (t) => {
        const before = remixIn(t, bare([]));
        assert.match(
            before.all,
            /declares no segments/,
            "the refusal must fire first, or this tests nothing",
        );
        // BIND THE ACTION TO THE ADVICE. Without this the test follows a hardcoded step that
        // can silently drift from whatever the remedy grows into, and would then be following
        // its own instruction rather than the engine's.
        assert.match(
            before.all,
            /each needs a non-empty string id/,
            "the step taken below must be the step the remedy actually asks for",
        );

        // Exactly what the remedy says: a segment, with a non-empty string id.
        const after = remixIn(
            t,
            bare([
                { id: "one", startMs: 0, endMs: 1000, voiceoverText: "hello" },
            ]),
        );

        assert.doesNotMatch(
            after.all,
            /declares no segments/,
            `following the remedy must clear the refusal that gave it\n${after.all}`,
        );
        assert.equal(after.code, EXIT.OK, `and the run proceeds\n${after.all}`);
    });
});
// --------------------------------------------------------------------------------------
// ITEM 3 — an id-less segment is named by its INDEX, never by an index dressed as an id.
//
// `segment "${s?.id ?? i}"` formats a 0-based index as a quoted id, so an author goes
// looking for a segment genuinely called "1" — and a timeline may really contain one. The
// correct form is settled and documented at frame-capture.mjs: `timing.segments[i]`.
//
// REACHABILITY WAS MEASURED BEFORE THESE WERE WRITTEN. concat-audio reaches both of its
// labels because it gates with segmentEntryBlocker, which refuses non-objects but has no
// opinion about ids. remix.mjs's labelOf is NOT reachable with an id-less segment — its
// gate asks shapeBlocker first, which refuses one — so it is corrected for the statement
// and pinned by a direct unit test rather than by a gate it can never reach. A green
// assertion over an unreachable branch would document a gap as covered.
// --------------------------------------------------------------------------------------

describe("an id-less segment is named by its index, not by an index dressed as an id", () => {
    const narratedFirst = {
        id: "one",
        startMs: 0,
        endMs: 960,
        voiceoverText: "hello there friend",
        audio: {
            file: "segment_000.mp3",
            durationMs: 960,
            headMs: 120,
            tailMs: 120,
            words: ttsWords("hello there friend").map((w, k) => ({
                word: w,
                startMs: (HEAD_FRAMES + k * FRAMES_PER_WORD) * FRAME_MS,
                endMs: (HEAD_FRAMES + (k + 1) * FRAMES_PER_WORD) * FRAME_MS,
            })),
        },
    };

    const concatIn = (t, second) => {
        const dir = makeProject(t, {
            "timing.json": JSON.stringify({
                project: { name: "demo", fps: 30, width: 1280, height: 720 },
                durationMs: 1920,
                contentMs: 1920,
                segments: [narratedFirst, second],
            }),
            "brand/tokens.json": JSON.stringify({
                audio: { ttsVoices: ["en-US-AvaNeural"] },
            }),
            "segment_000.mp3": ttsClip("hello there friend"),
        });
        return runScript("concat-audio.mjs", [], dir);
    };

    test("concatAudio_idlessSilentSegmentWithABadCaption_namesItByIndex", (t) => {
        const r = concatIn(t, {
            startMs: 960,
            endMs: 1920,
            voiceoverText: "",
            silence: { caption: "" },
        });

        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.match(
            r.all,
            /timing\.segments\[1\]/,
            `named by index\n${r.all}`,
        );
        assert.doesNotMatch(
            r.all,
            /segment "1"/,
            `never an index dressed as an id\n${r.all}`,
        );
    });

    test("concatAudio_idlessNarratedSegmentWithAMissingClip_namesItByIndex", (t) => {
        const r = concatIn(t, {
            startMs: 960,
            endMs: 1920,
            voiceoverText: "second here",
            audio: {
                file: "nope.mp3",
                durationMs: 960,
                headMs: 120,
                tailMs: 120,
                words: [{ word: "second", startMs: 1080, endMs: 1200 }],
            },
        });

        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.match(
            r.all,
            /timing\.segments\[1\]/,
            `named by index\n${r.all}`,
        );
        assert.doesNotMatch(
            r.all,
            /segment "1"/,
            `never an index dressed as an id\n${r.all}`,
        );
    });

    // REVIEWER FINDING, round 1. A third label in this stage restated `segment "${id}"` with no
    // index fallback at all, so an id-less silent segment became `segment "undefined"`. Reached
    // by a MIXED timeline: no segment names its clip, at least one is validly silent, at least
    // one is narrated. The refusal then named the same segment two ways in one sentence —
    // `segment "undefined"` at the start and `timing.segments[1]'s id is missing` at the end.
    test("concatAudio_idlessSilentSegmentInAMixedTimeline_isNeverNamedUndefined", (t) => {
        const dir = makeProject(t, {
            "timing.json": JSON.stringify({
                project: { name: "demo", fps: 30, width: 1280, height: 720 },
                durationMs: 1920,
                contentMs: 1920,
                segments: [
                    {
                        id: "one",
                        startMs: 0,
                        endMs: 960,
                        voiceoverText: "hello there friend",
                    },
                    {
                        startMs: 960,
                        endMs: 1920,
                        voiceoverText: "",
                        silence: { caption: "[music]" },
                    },
                ],
            }),
            "brand/tokens.json": JSON.stringify({
                audio: { ttsVoices: ["en-US-AvaNeural"] },
            }),
        });

        const r = runScript("concat-audio.mjs", [], dir);

        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.doesNotMatch(
            r.all,
            /segment "undefined"/,
            `no segment may be named "undefined"\n${r.all}`,
        );
        assert.match(
            r.all,
            /timing\.segments\[1\]/,
            `it is named by its index instead\n${r.all}`,
        );
    });

    // REVIEWER FINDING, round 2. Two more sites formatted `p.id` straight into a label with no
    // fallback of any kind, and these are not refusals — they are the ordinary PLAN and APPLY
    // output, at exit 0. An id-less silent segment was announced as `segment "undefined"` in a
    // successful run, which is the same broken rule in the place an author reads most often.
    for (const [mode, args] of [
        ["plan", []],
        ["apply", ["--apply"]],
    ]) {
        test(`concatAudio_${mode}WithAnIdlessSilentSegment_namesItByIndexNotUndefined`, (t) => {
            const dir = makeProject(t, {
                "timing.json": JSON.stringify({
                    project: {
                        name: "demo",
                        fps: 30,
                        width: 1280,
                        height: 720,
                    },
                    durationMs: 1920,
                    contentMs: 1920,
                    segments: [
                        {
                            id: "one",
                            startMs: 0,
                            endMs: 960,
                            voiceoverText: "hello there friend",
                            audio: {
                                file: "segment_000.mp3",
                                durationMs: 960,
                                headMs: 120,
                                tailMs: 120,
                                words: ttsWords("hello there friend").map(
                                    (w, k) => ({
                                        word: w,
                                        startMs:
                                            (HEAD_FRAMES +
                                                k * FRAMES_PER_WORD) *
                                            FRAME_MS,
                                        endMs:
                                            (HEAD_FRAMES +
                                                (k + 1) * FRAMES_PER_WORD) *
                                            FRAME_MS,
                                    }),
                                ),
                            },
                        },
                        {
                            startMs: 960,
                            endMs: 1920,
                            voiceoverText: "",
                            silence: { caption: "[music]" },
                        },
                    ],
                }),
                "brand/tokens.json": JSON.stringify({
                    audio: { ttsVoices: ["en-US-AvaNeural"] },
                }),
                "segment_000.mp3": ttsClip("hello there friend"),
            });

            const r = runScript("concat-audio.mjs", args, dir);

            assert.equal(
                r.code,
                EXIT.OK,
                `this timeline is accepted — the label is the only defect\n${r.all}`,
            );
            assert.doesNotMatch(
                r.all,
                /segment "undefined"/,
                `a successful run must not name a segment "undefined"\n${r.all}`,
            );
            assert.match(
                r.all,
                /timing\.segments\[1\]/,
                `it is named by its index instead\n${r.all}`,
            );
        });
    }

    // REVIEWER FINDING, round 3. A FOURTH site, in a different stage and broken a fourth way:
    // write-storyboard called silentSegmentProblems(s) with no label at all, so it fell back to
    // the default `segment "${seg?.id}"` and an id-less segment became `segment "undefined"`.
    // The `.filter().flatMap()` had discarded the index before the label needed it.
    test("writeStoryboard_idlessSilentSegmentWithABadCaption_namesItByIndexNotUndefined", (t) => {
        const dir = makeProject(t, {
            "timing.json": JSON.stringify({
                project: {
                    name: "demo",
                    title: "D",
                    fps: 30,
                    width: 1280,
                    height: 720,
                },
                aspectRatio: "16:9",
                durationMs: 1920,
                contentMs: 1920,
                outroMs: 2500,
                intake: { voice: "en-US-AvaNeural", speed: 1 },
                segments: [
                    {
                        id: "one",
                        startMs: 0,
                        endMs: 960,
                        voiceoverText: "hello",
                    },
                    {
                        startMs: 960,
                        endMs: 1920,
                        voiceoverText: "",
                        silence: { caption: "" },
                    },
                ],
            }),
        });

        const r = runScript("write-storyboard.mjs", [], dir);

        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.doesNotMatch(
            r.all,
            /segment "undefined"/,
            `no segment may be named "undefined"\n${r.all}`,
        );
        assert.match(
            r.all,
            /timing\.segments\[1\]/,
            `it is named by its index instead\n${r.all}`,
        );
    });

    // THE CONTROL. A segment that HAS an id is still named by it — including an id that
    // merely looks like an index. The distinction is HAVING an id, never how it is spelled.
    test("concatAudio_segmentWhoseIdLooksLikeAnIndex_isStillNamedByThatId", (t) => {
        const r = concatIn(t, {
            id: "1",
            startMs: 960,
            endMs: 1920,
            voiceoverText: "",
            silence: { caption: "" },
        });

        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.match(
            r.all,
            /segment "1"/,
            `an id that looks like an index is still an id\n${r.all}`,
        );
        assert.doesNotMatch(r.all, /timing\.segments\[1\]/, r.all);
    });
});
// --------------------------------------------------------------------------------------
// ITEM 4 — a plan that has just said --apply will REFUSE must not then invite --apply.
//
// remix prints the shared footer, "Re-run with --apply to proceed", immediately after
// disclosing "not voiced yet, so --apply refuses the run until voice.mjs (S3) has run".
// Both sentences are true of different things and the pair is a contradiction: the footer
// is advice about the next step, and the next step is a refusal.
//
// The footer is shared by fourteen callers, so the fix is ADDITIVE — the default wording is
// unchanged to the byte, which the control below pins for the thirteen that do not opt in.
// --------------------------------------------------------------------------------------

describe("a plan does not invite --apply when it has said --apply will refuse", () => {
    const clip = (text, startMs) => ({
        file: "segment_000.mp3",
        durationMs: 960,
        headMs: 120,
        tailMs: 120,
        words: ttsWords(text).map((w, k) => ({
            word: w,
            startMs: startMs + (HEAD_FRAMES + k * FRAMES_PER_WORD) * FRAME_MS,
            endMs:
                startMs + (HEAD_FRAMES + (k + 1) * FRAMES_PER_WORD) * FRAME_MS,
        })),
    });
    const voicedSeg = {
        id: "one",
        startMs: 0,
        endMs: 960,
        voiceoverText: "hello there friend",
        audio: clip("hello there friend", 0),
    };
    const unvoicedSeg = {
        id: "two",
        startMs: 960,
        endMs: 1920,
        voiceoverText: "second segment here",
    };

    const remixPlan = (t, segments) => {
        const dir = makeProject(t, {
            "timing.json": JSON.stringify({
                project: { name: "demo", fps: 30, width: 1280, height: 720 },
                durationMs: 1920,
                contentMs: 1920,
                segments,
            }),
            "brand/tokens.json": JSON.stringify({
                audio: { ttsVoices: ["en-US-AvaNeural"] },
            }),
            "segment_000.mp3": ttsClip("hello there friend"),
        });
        return { ...runScript("remix.mjs", [], dir), dir };
    };

    test("remix_planDisclosingThatApplyWillRefuse_doesNotAlsoInviteApply", (t) => {
        const r = remixPlan(t, [voicedSeg, unvoicedSeg]);

        assert.equal(r.code, EXIT.OK, `the plan itself succeeds\n${r.all}`);
        assert.match(
            r.all,
            /--apply refuses the run/,
            "the plan must disclose the refusal, or this tests nothing",
        );
        assert.doesNotMatch(
            r.all,
            /Re-run with --apply to proceed/,
            `a plan that has just said --apply refuses must not then invite it\n${r.all}`,
        );
        assert.match(
            r.all,
            /nothing was written or deleted/,
            "but it must still say nothing happened",
        );
    });

    // FOLLOWING THE FOOTER'S OWN CLAIM. If the plan says --apply would refuse, then --apply
    // must actually refuse — otherwise the new footer is as wrong as the old one, in the
    // opposite direction.
    test("remix_applyOnTheTimelineThePlanSaidWouldBeRefused_isRefused", (t) => {
        const { dir } = remixPlan(t, [voicedSeg, unvoicedSeg]);

        const applied = runScript("remix.mjs", ["--apply", "--replace"], dir);

        assert.notEqual(
            applied.code,
            EXIT.OK,
            `the plan's claim about --apply must be true\n${applied.all}`,
        );
    });

    // THE CONTROL FOR THE OTHER THIRTEEN CALLERS. A plan with nothing to disclose keeps the
    // shipped footer exactly, so the additive change cannot have moved it for anyone else.
    test("remix_planWithNoDisclosedRefusal_keepsTheShippedFooterByteForByte", (t) => {
        const r = remixPlan(t, [voicedSeg]);

        assert.equal(r.code, EXIT.OK, r.all);
        assert.doesNotMatch(
            r.all,
            /--apply refuses the run/,
            "nothing to disclose, or this is the wrong control",
        );
        assert.match(
            r.all,
            /^nothing was written or deleted\. Re-run with --apply to proceed\.$/m,
            r.all,
        );
    });

    test("writeStoryboard_plan_keepsTheShippedFooterByteForByte", (t) => {
        const r = planWith(t, "write-storyboard.mjs", timing([ONE, TWO]));

        assert.equal(r.code, EXIT.OK, r.all);
        assert.match(
            r.all,
            /^nothing was written or deleted\. Re-run with --apply to proceed\.$/m,
            r.all,
        );
    });
});
