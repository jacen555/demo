/*
 * preview's layout audit attributes each issue to the slide it belongs to — and the binding
 * record that lets `coach-pack` prove what the coach was shown.
 *
 * WHY THE ATTRIBUTION COMES FIRST. `window.auditLayout` walks `document.querySelectorAll('.sl')`
 * — EVERY slide, not the one on screen (write-build-html.mjs). preview called it once per
 * segment and filed the whole-document result under that segment's id, so one slide's overflow
 * was reported under every segment previewed. Measured before this was written: with only the
 * second slide overflowing, both segments reported `[{"id":"seg-1",...}]` and the failure line
 * read `layout issues in 2 segment(s): ok, big`.
 *
 * That matters here more than it looks. G2 binds each still TO ITS AUDIT TRANSCRIPT. Binding a
 * still to a transcript describing a different slide would produce a record that is
 * cryptographically sound and semantically false — its hash would prove the wrong thing was
 * checked, which is worse than having no record at all.
 *
 * THE FIXTURE CARRIES THE REAL ID FORMAT, AND THAT IS NOT A DETAIL. Slides are `seg-${index}`
 * (write-build-html.mjs), NOT the segment's id. A first probe used a scene whose slide ids were
 * the segment ids; it reproduced the symptom and would have made the fix look like a one-line
 * filter on `issue.id === segmentId`, which matches nothing against a real build. Verified
 * against a genuine `write-build-html --apply`: its slides are `seg-0, seg-1` while the
 * segments are `ok, big`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXIT } from "../src/cli-support.mjs";
import {
    makeProject,
    runScript,
    tryMakeFileLink,
    removeFixture,
} from "./_helpers.mjs";

const SRC_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
);
// The stage writes under the tool's own coach/ folder, not into the project — that is
// where the coach agent is told to look. Tests therefore touch the real location, which is
// precisely why the ignore rule below has to be right.
//
// The folder is `<basename>-<digest of the absolute path>`: two projects can share a
// basename, and the basename alone would point both packs at one destination.
const packIdentity = (projectDir) =>
    `${path.basename(projectDir).replace(/[^A-Za-z0-9._-]/g, "_") || "project"}-${crypto
        .createHash("sha256")
        .update(path.resolve(projectDir))
        .digest("hex")
        .slice(0, 12)}`;
const manifestPathFor = (projectDir) =>
    path.join(
        SRC_DIR,
        "..",
        "coach",
        "pack",
        packIdentity(projectDir),
        "manifest.json",
    );

// --------------------------------------------------------------------------------------
// A scene with the shipped audit's shape: it reports EVERY overflowing slide, whichever is
// on screen, and names each by its `seg-<index>` id.
// --------------------------------------------------------------------------------------

const scene = (
    overflowing,
) => `<!doctype html><html><head><meta charset="utf-8"><style>
.sl{position:absolute;inset:0;display:none}
.sl.on{display:block}
.safe{width:200px;height:100px;overflow:hidden}
.tall{height:400px}
</style></head><body>
<section id="seg-0" class="sl on"><div class="safe"><p${overflowing.includes(0) ? ' class="tall"' : ""}>one</p></div></section>
<section id="seg-1" class="sl"><div class="safe"><p${overflowing.includes(1) ? ' class="tall"' : ""}>two</p></div></section>
<section id="seg-2" class="sl"><div class="safe"><p${overflowing.includes(2) ? ' class="tall"' : ""}>end card</p></div></section>
<script>
function safeOverflow(el){return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;}
window.auditLayout=function(){const out=[];document.querySelectorAll('.sl').forEach(sl=>{
  const safe=sl.querySelector('.safe');if(!safe)return;
  const on=sl.classList.contains('on');sl.classList.add('on');
  if(safeOverflow(safe))out.push({id:sl.id,reason:'overflow-after-fit'});
  if(!on)sl.classList.remove('on');});return out;};
window.masterTimeline={seek(){},pause(){}};
window.fireTriggersUpTo=function(){};
</script></body></html>`;

const timing = (extra = {}) =>
    JSON.stringify({
        project: { name: "demo", fps: 30, width: 320, height: 200 },
        durationMs: 2000,
        contentMs: 2000,
        segments: [
            { id: "ok", startMs: 0, endMs: 1000, voiceoverText: "first" },
            { id: "big", startMs: 1000, endMs: 2000, voiceoverText: "second" },
        ],
        ...extra,
    });

const previewIn = (
    t,
    { overflowing = [], timingExtra = {}, args = ["--apply"] } = {},
) => {
    const dir = makeProject(t, {
        "video-auto.html": scene(overflowing),
        "timing.json": timing(timingExtra),
    });
    return { ...runScript("preview.mjs", args, dir), dir };
};

describe("preview attributes a layout issue to the slide it belongs to", () => {
    // THE CONTROL. Nothing overflows, so nothing is reported and the run succeeds. Without it
    // a fix that reported nothing at all would satisfy every assertion below.
    test("preview_noSlideOverflows_succeedsAndReportsNothing", (t) => {
        const r = previewIn(t);

        assert.equal(r.code, EXIT.OK, r.all);
        assert.doesNotMatch(r.all, /FAILED/, r.all);
    });

    test("preview_oneSlideOverflows_namesOnlyThatSegment", (t) => {
        const r = previewIn(t, { overflowing: [1] });

        assert.equal(
            r.code,
            EXIT.FAILED,
            `an overflow is still a failure\n${r.all}`,
        );
        assert.match(
            r.all,
            /\bbig\b/,
            `the segment that actually overflows must be named\n${r.all}`,
        );
        assert.doesNotMatch(
            r.all,
            /segment\(s\): .*\bok\b/,
            `a clean segment must not be named as having layout issues\n${r.all}`,
        );
        assert.match(
            r.all,
            /1 segment\(s\)/,
            `one slide overflows, so one segment is named\n${r.all}`,
        );
    });

    // COVERAGE IS NOT TRADED FOR CORRECTNESS. preview audits the whole document but may be
    // asked for a subset. Attributing issues strictly to the previewed segment would make an
    // overflow on an unpicked slide vanish — a silent coverage loss hidden inside a
    // correctness fix. It is still reported, and still named for the segment that owns it.
    test("preview_overflowOnASlideNotPreviewed_isStillReportedAndNamedForItsOwnSegment", (t) => {
        const r = previewIn(t, {
            overflowing: [1],
            args: ["--apply", "--id", "ok"],
        });

        assert.equal(
            r.code,
            EXIT.FAILED,
            `an overflow anywhere is still a failure\n${r.all}`,
        );
        assert.match(
            r.all,
            /\bbig\b/,
            `the owning segment is named even though it was not previewed\n${r.all}`,
        );
    });

    // THE END CARD HAS A SLIDE AND NO SEGMENT OWNS IT. It is `seg-<segments.length>`, so
    // without its own mapping it would fall through to the raw slide id, or worse be
    // attributed to whichever segment happened to be last. Exercised with a real overflowing
    // end-card slide, because the mapping branch is otherwise never reached.
    test("preview_endCardSlideOverflows_isAttributedToTheEndCardAndCountedOnce", (t) => {
        const r = previewIn(t, { overflowing: [2] });

        assert.equal(
            r.code,
            EXIT.FAILED,
            `an overflow anywhere is a failure\n${r.all}`,
        );
        assert.match(
            r.all,
            /segment\(s\): endcard/,
            `the end card is named as itself\n${r.all}`,
        );
        assert.match(r.all, /1 segment\(s\)/, `and counted once\n${r.all}`);
        assert.match(
            r.all,
            /^endcard\s+layout issue:/m,
            `the issue line is labelled by owner\n${r.all}`,
        );
        // The issue OBJECT carries its slide id as data, which is useful and stays. What must
        // never appear is a raw slide id in the OWNER list, where a reader looks for a segment.
        assert.doesNotMatch(
            r.all,
            /segment\(s\): .*seg-\d/,
            `never a raw slide id as an owner\n${r.all}`,
        );
    });

    // `contentMs` decides the end card's seek time. `Number(null)` and `Number('')` are both
    // ZERO, so a guard built on Number() accepts them and seeks to 1.2s — a still that claims
    // to show the end card and shows the opening instead, at exit 0. The `||` idiom guards
    // ABSENCE and not TYPE; `Number()` guards neither.
    for (const [label, contentMs] of [
        ["absent", undefined],
        ["null", null],
        ["anEmptyString", ""],
        ["aString", "2000"],
        ["notANumber", "soon"],
    ]) {
        test(`preview_endCardSeekWith_${label}_contentMs_isRefusedRatherThanSeekingToAGuess`, (t) => {
            const r = previewIn(t, { timingExtra: { contentMs } });

            assert.doesNotMatch(
                r.all,
                /t=NaNs/,
                `a seek target that is not a number must not be used\n${r.all}`,
            );
            assert.notEqual(
                r.code,
                EXIT.OK,
                `and the run must not report success\n${r.all}`,
            );
            assert.match(
                r.all,
                /contentMs/,
                `the refusal must name the field\n${r.all}`,
            );
            // REFUSED BEFORE ANYTHING IS WRITTEN. Checked after the segment shots, this left
            // partial output, and the retry was then blocked by the very files the failed run
            // had just written — a refusal that makes itself harder to act on.
            assert.equal(
                fs.existsSync(path.join(r.dir, "preview")),
                false,
                `a refusal must leave no partial output\n${r.all}`,
            );
        });
    }

    // THE CONTROL FOR THAT GUARD. A real contentMs still produces an end-card shot, so the
    // refusal cannot have been written as "always refuse".
    test("preview_endCardSeekWithAFiniteContentMs_takesTheShot", (t) => {
        const r = previewIn(t);

        assert.equal(r.code, EXIT.OK, r.all);
        assert.match(
            r.all,
            /^endcard\s+t=3\.2s$/m,
            `2000ms content + 1.2s\n${r.all}`,
        );
        assert.equal(
            fs.existsSync(path.join(r.dir, "preview", "endcard.png")),
            true,
            "and writes the still",
        );
    });
});

// --------------------------------------------------------------------------------------
// G2 — the binding record. It says WHAT WAS SHOWN, by sha256, so a later stage can prove
// the stills it packs are the ones this audit describes.
//
// PUBLISHED LAST, and the reason is NOT make-music's. make-music publishes its ducking
// record FIRST, deliberately, because it fingerprints an IN-MEMORY buffer: the record can
// precede the write, and a failed write leaves a record describing bytes not on disk,
// which remux refuses as another bed. preview's stills are PNG bytes the BROWSER writes to
// disk; they cannot be hashed until they exist. Same engine, opposite order, and the
// distinguishing condition — whether the bytes exist before the write — is stated in
// neither file. A precedent cited without that condition transfers a conclusion without
// the reason that bounds it.
//
// IT DESCRIBES WHAT EACH STILL IS, NEVER WHAT IT SHOWS. A still is taken at 86% of its
// segment's window and can miss a late reveal, so a record claiming the still shows
// everything would assert coverage it cannot deliver.
// --------------------------------------------------------------------------------------

describe("preview writes a record binding what it shot to what it shot it from", () => {
    const RECORD = "preview-record.json";
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
    const readRecord = (dir) =>
        JSON.parse(fs.readFileSync(path.join(dir, "preview", RECORD), "utf8"));

    test("preview_plan_writesNoRecord", (t) => {
        const r = previewIn(t, { args: [] });

        assert.equal(r.code, EXIT.OK, r.all);
        assert.equal(
            fs.existsSync(path.join(r.dir, "preview", RECORD)),
            false,
            "a plan writes nothing",
        );
    });

    test("preview_apply_bindsTheTimingAndTheSceneByTheirOwnBytes", (t) => {
        const r = previewIn(t);

        assert.equal(r.code, EXIT.OK, r.all);
        const rec = readRecord(r.dir);
        assert.equal(
            rec.timing.sha256,
            sha(fs.readFileSync(path.join(r.dir, "timing.json"))),
            "the timing it read",
        );
        assert.equal(
            rec.scene.sha256,
            sha(fs.readFileSync(path.join(r.dir, "video-auto.html"))),
            "the scene it loaded",
        );
        assert.equal(rec.timing.file, "timing.json");
        assert.equal(rec.scene.file, "video-auto.html");
    });

    // THE PROOF THAT IT IS PUBLISHED LAST. Every still's recorded hash matches the bytes on
    // disk, which can only hold if the record was written after the screenshots were.
    test("preview_apply_bindsEveryStillToTheBytesActuallyOnDisk", (t) => {
        const r = previewIn(t);

        const rec = readRecord(r.dir);
        assert.deepEqual(rec.stills.map((s) => s.file).sort(), [
            "big.png",
            "endcard.png",
            "ok.png",
        ]);
        for (const still of rec.stills) {
            const onDisk = fs.readFileSync(
                path.join(r.dir, "preview", still.file),
            );
            assert.equal(
                still.sha256,
                sha(onDisk),
                `${still.file} must bind the bytes on disk`,
            );
            assert.equal(
                still.bytes,
                onDisk.length,
                `${still.file} must bind its length`,
            );
        }
    });

    // THE AUDIT TRANSCRIPT IS PART OF THE BINDING. A still bound to a transcript describing a
    // different slide would be cryptographically sound and semantically false.
    test("preview_apply_bindsTheAuditTranscriptAttributedToItsOwningSegment", (t) => {
        const r = previewIn(t, { overflowing: [1] });

        assert.equal(
            r.code,
            EXIT.FAILED,
            `the overflow is still a failure\n${r.all}`,
        );
        const rec = readRecord(r.dir);
        assert.equal(rec.audit.issues.length, 1, JSON.stringify(rec.audit));
        assert.equal(
            rec.audit.issues[0].owner,
            "big",
            "attributed to the segment that owns the slide",
        );
        assert.equal(
            rec.audit.issues[0].id,
            "seg-1",
            "and still carrying the slide it came from",
        );
    });

    test("preview_apply_withACleanAudit_recordsAnEmptyTranscriptRatherThanOmittingIt", (t) => {
        const r = previewIn(t);

        assert.deepEqual(
            readRecord(r.dir).audit.issues,
            [],
            "an empty transcript is a finding, not an absence",
        );
    });

    // The record is a name the ENGINE chose, so a link at it is refused rather than followed.
    test("preview_recordNameIsALinkToAnotherInRootFile_refusesWithoutWritingThroughIt", (t) => {
        const dir = makeProject(t, {
            "video-auto.html": scene([]),
            "timing.json": timing(),
            "notes.md": "ORIGINAL",
        });
        fs.mkdirSync(path.join(dir, "preview"), { recursive: true });
        if (
            !tryMakeFileLink(
                path.join(dir, "preview", RECORD),
                path.join(dir, "notes.md"),
            )
        ) {
            return t.skip("platform refused to create a file link");
        }

        const r = runScript("preview.mjs", ["--apply", "--replace"], dir);

        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.equal(
            fs.readFileSync(path.join(dir, "notes.md"), "utf8"),
            "ORIGINAL",
            "the victim keeps its bytes",
        );
    });
});
// --------------------------------------------------------------------------------------
// G3 — the coach pack. It collects the exact input set the coach may read and writes a
// hash manifest the coach cites, so a ruling can be tied to the bytes it was made against.
//
// ABSENCE OF A RECORD IS A REFUSAL, NOT A PASS. That is the whole point of the stage: "no
// record" must never read as "nothing wrong", which is the same silent-zero we have been
// hunting everywhere else.
//
// EXIT CODES, CHOSEN DELIBERATELY: 0 plan/success, 1 refusal, 2 bad usage. A stale or
// missing record is a bad RESULT of a run that worked, not a caller error, so it is
// FAILED(1) — with write-subtitles, validate-timing and write-chapters. remix's 2 is the
// outlier and is not a precedent for this.
// --------------------------------------------------------------------------------------

describe("coach-pack collects an input set and binds it with a manifest", () => {
    const COACH = path.join(SRC_DIR, "..", "coach");
    const packed = (dir) =>
        JSON.parse(fs.readFileSync(manifestPathFor(dir), "utf8"));

    function previewed(t, extra = {}) {
        const r = previewIn(t, extra);
        assert.equal(
            r.code,
            extra.overflowing ? EXIT.FAILED : EXIT.OK,
            `preview must produce the stills\n${r.all}`,
        );
        fs.writeFileSync(
            path.join(r.dir, "script.md"),
            "# Script\n\nSegment one.\n",
        );
        fs.writeFileSync(
            path.join(r.dir, "storyboard.html"),
            "<!doctype html><title>sb</title>\n",
        );
        // The stage writes into the real coach/ folder, so each test takes its own away again.
        t.after(() => removeFixture(path.dirname(manifestPathFor(r.dir))));
        return r.dir;
    }

    test("coachPack_pass1_plan_listsOnlyTheScriptAndWritesNothing", (t) => {
        const dir = previewed(t);

        const r = runScript("coach-pack.mjs", ["--pass", "1"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        assert.match(r.all, /script\.md/, r.all);
        assert.doesNotMatch(
            r.all,
            /\.png/,
            "pass 1 is before the stills exist",
        );
        assert.equal(
            fs.existsSync(manifestPathFor(dir)),
            false,
            "a plan writes nothing",
        );
        // A plan that creates its output directory has written something while saying it did
        // not. Asserting only the manifest's absence would miss the folder.
        assert.equal(
            fs.existsSync(path.dirname(manifestPathFor(dir))),
            false,
            "nor even the folder",
        );
    });

    // A NON-EMPTY STILL SET IS NOT A COMPLETE ONE. This is the same silent zero one level in:
    // every supplied entry verifies, and the segment nobody shot is simply not mentioned.
    test("coachPack_pass2_recordMissingOneStill_refusesAndNamesTheSegmentNeverShot", (t) => {
        const dir = previewed(t);
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        rec.stills = rec.stills.filter((s) => s.file !== "big.png");
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(
            r.code,
            EXIT.FAILED,
            `two of three stills is not a pass-2 pack\n${r.all}`,
        );
        assert.match(
            r.all,
            /never shot: big/,
            `it must name WHICH segment is unseen\n${r.all}`,
        );
        assert.equal(
            fs.existsSync(manifestPathFor(dir)),
            false,
            "and publish nothing",
        );
    });

    // Confined to `preview/`, not merely to the project. `../script.md` stays inside the
    // project, so the project boundary alone would accept it and label it a still.
    test("coachPack_pass2_recordNamingAStillOutsideThePreviewFolder_refuses", (t) => {
        const dir = previewed(t);
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        rec.stills[0].file = "../script.md";
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.notEqual(r.code, EXIT.OK, r.all);
        assert.match(
            r.all,
            /recorded still ".*" is not a plain filename/,
            `refused as a name, not as a path\n${r.all}`,
        );
    });

    // The scrubber runs over the SERIALISED transcript, so a path used as a KEY is covered by
    // the same pass. A walker that visited only values would let this one through.
    test("coachPack_manifest_redactsAPathUsedAsAnAuditKeyAndAPosixTempPath", (t) => {
        const dir = previewed(t, { overflowing: [1] });
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        rec.audit.issues[0]["/tmp/buildbot/secret-key"] = "as a key";
        rec.audit.issues[0].note = "rendered from /tmp/buildbot/scene.html";
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        const raw = fs.readFileSync(manifestPathFor(dir), "utf8");
        assert.doesNotMatch(
            raw,
            /buildbot/,
            `neither key nor value may survive\n${raw}`,
        );
        assert.match(raw, /<path redacted>/, "and the removal is visible");
    });

    test("coachPack_pass2_apply_manifestNamesEveryStillAndItsAuditTranscript", (t) => {
        const dir = previewed(t);

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        const m = packed(dir);
        const files = m.files.map((f) => f.file).sort();
        assert.deepEqual(
            files,
            [
                "preview/big.png",
                "preview/endcard.png",
                "preview/ok.png",
                "script.md",
                "storyboard.html",
                "timing.json",
                "video-auto.html",
            ],
            `the pass-2 input set\n${JSON.stringify(files, null, 2)}`,
        );
        assert.equal(m.pass, 2);
        assert.ok(m.audit, "the transcript travels with the pack");
    });

    // THE REFUSAL THIS STAGE EXISTS FOR.
    test("coachPack_pass2_withNoPreviewRecord_refusesRatherThanPackingUnboundStills", (t) => {
        const dir = previewed(t);
        fs.rmSync(path.join(dir, "preview", "preview-record.json"));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.FAILED, r.all);
        assert.match(r.all, /no preview record/i, r.all);
        assert.match(
            r.all,
            /preview\.mjs --apply --replace/,
            `the remedy must be followable\n${r.all}`,
        );
        assert.equal(
            fs.existsSync(manifestPathFor(dir)),
            false,
            "a refusal publishes no manifest",
        );
    });

    // VERIFIED BY USING IT: mutate one input and prove the refusal fires.
    test("coachPack_pass2_whenAStillChangedAfterTheRecord_refusesAndNamesTheStill", (t) => {
        const dir = previewed(t);
        fs.appendFileSync(
            path.join(dir, "preview", "ok.png"),
            Buffer.from([0, 1, 2]),
        );

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.FAILED, r.all);
        assert.match(r.all, /ok\.png/, `it must name WHICH still\n${r.all}`);
        assert.match(r.all, /preview\.mjs --apply --replace/, r.all);
    });

    test("coachPack_pass2_whenTimingChangedAfterTheStills_refusesBecauseTheStillsShowTheOldTiming", (t) => {
        const dir = previewed(t);
        const timingPath = path.join(dir, "timing.json");
        const edited = JSON.parse(fs.readFileSync(timingPath, "utf8"));
        edited.project.title = "RETITLED AFTER THE SHOT";
        fs.writeFileSync(timingPath, JSON.stringify(edited, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.FAILED, r.all);
        assert.match(r.all, /timing\.json/, r.all);
    });

    // §V — a manifest the coach cites must not carry this machine's directory layout.
    // Asserted with plain string containment rather than a regex: an over-escaped regex here
    // would be an assertion that cannot fail, which is the very thing this suite hunts. The
    // positive control below proves each check can actually fire.
    test("coachPack_manifest_carriesNoAbsoluteLocalPaths", (t) => {
        const dir = previewed(t);

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        const raw = fs.readFileSync(manifestPathFor(dir), "utf8");
        const leaks = (text) => {
            const found = [];
            if (
                text.includes(dir) ||
                text.includes(JSON.stringify(dir).slice(1, -1))
            )
                found.push("project root");
            if (/[A-Za-z]:\\/.test(text) || /[A-Za-z]:\\\\/.test(text))
                found.push("windows absolute path");
            if (text.includes("/Users/") || text.includes("/home/"))
                found.push("posix home path");
            return found;
        };

        assert.deepEqual(
            leaks(raw),
            [],
            `the manifest leaks local paths:\n${raw}`,
        );
        for (const f of JSON.parse(raw).files) {
            assert.equal(
                path.isAbsolute(f.file),
                false,
                `${f.file} must be project-relative`,
            );
            assert.doesNotMatch(
                f.file,
                /\.\./,
                `${f.file} must not climb out of the project`,
            );
        }

        // POSITIVE CONTROL — the same checks against text that DOES carry each leak. Without
        // this, three passing assertions prove only that they were evaluated. The literals are
        // explicit rather than derived from `dir`, because `dir` is a POSIX path off Windows
        // and the control would then assert a host-specific outcome instead of the distinction
        // it is meant to test.
        assert.deepEqual(
            leaks('"file": "C:\\\\Users\\\\someone\\\\demo\\\\timing.json"'),
            ["windows absolute path"],
        );
        assert.deepEqual(leaks('"file": "/Users/someone/demo/timing.json"'), [
            "posix home path",
        ]);
        assert.deepEqual(
            leaks(`"file": ${JSON.stringify(dir)}`).includes("project root"),
            true,
            "the project root check fires",
        );
        assert.deepEqual(
            leaks('"file": "timing.json"'),
            [],
            "and a clean path stays clean",
        );
    });

    // §V — the transcript comes from the PAGE and lands in an artifact an agent quotes
    // elsewhere, so its own string values are scrubbed, not just the file paths beside them.
    test("coachPack_manifest_redactsAnAbsolutePathCarriedInsideTheAuditTranscript", (t) => {
        const dir = previewed(t, { overflowing: [1] });
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        rec.audit.issues[0].note =
            "rendered from C:\\Users\\someone\\secret\\scene.html";
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));
        // The record's own hash is not over itself, so editing it does not invalidate the stills.

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        const raw = fs.readFileSync(manifestPathFor(dir), "utf8");
        assert.match(
            raw,
            /<path redacted>/,
            "the path must be redacted, visibly",
        );
        assert.doesNotMatch(
            raw,
            /someone/,
            `and must not survive anywhere in the artifact\n${raw}`,
        );
    });

    // A RECORD IS UNTRUSTED INPUT. These three are the ways a record can be present and yet
    // bind nothing — each would otherwise publish a manifest that checked less than it claims.
    test("coachPack_pass2_recordBindingNoStills_refusesRatherThanVerifyingNothing", (t) => {
        const dir = previewed(t);
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        rec.stills = [];
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(
            r.code,
            EXIT.FAILED,
            `an empty still set verifies nothing\n${r.all}`,
        );
        assert.match(r.all, /binds no stills/, r.all);
    });

    test("coachPack_pass2_recordWithNoAuditTranscript_refusesRatherThanClaimingACleanAudit", (t) => {
        const dir = previewed(t);
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        delete rec.audit;
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(
            r.code,
            EXIT.FAILED,
            `an absent transcript is not a clean one\n${r.all}`,
        );
        assert.match(r.all, /no audit transcript/, r.all);
    });

    test("coachPack_pass2_recordNamingAFileOutsideTheProject_refusesInsteadOfReadingIt", (t) => {
        const dir = previewed(t);
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        rec.timing.file = "../../../../etc/hosts";
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        // Asserted on the REASON, not just on a non-zero code: a record naming a missing file
        // also refuses, so a bare `notEqual(OK)` would pass whether or not the boundary exists.
        // Measured: `error: recorded timing "../../../../etc/hosts" resolves outside the project
        // root (...) — refusing.`, exit 2 — the engine's existing code for a boundary breach.
        assert.equal(
            r.code,
            EXIT.USAGE,
            `a record must not name a file outside the project\n${r.all}`,
        );
        assert.match(r.all, /resolves outside the project root/, r.all);
        assert.doesNotMatch(r.all, /packed/, "and nothing may be published");
    });

    test("coachPack_pass2_rerunWithoutReplace_refusesToOverwriteAnExistingManifest", (t) => {
        const dir = previewed(t);
        assert.equal(
            runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir).code,
            EXIT.OK,
        );

        const again = runScript(
            "coach-pack.mjs",
            ["--pass", "2", "--apply"],
            dir,
        );

        assert.notEqual(
            again.code,
            EXIT.OK,
            `an existing pack is not silently replaced\n${again.all}`,
        );

        const replaced = runScript(
            "coach-pack.mjs",
            ["--pass", "2", "--apply", "--replace"],
            dir,
        );
        assert.equal(
            replaced.code,
            EXIT.OK,
            `and --replace is the way through\n${replaced.all}`,
        );
    });

    // THE REMEDY, FOLLOWED RATHER THAN READ. A remedy is a claim about what happens next, and
    // the only way to know it is true is to run it and watch the refusal clear. The last
    // remedy written in this engine was a referral loop — it sent the author to a stage that
    // refuses that very input — and none of its three failures was visible by reading it.
    test("coachPack_followingTheRemedyAfterAStaleStill_clearsTheRefusal", (t) => {
        const dir = previewed(t);
        fs.appendFileSync(
            path.join(dir, "preview", "ok.png"),
            Buffer.from([0, 1, 2]),
        );

        const refused = runScript(
            "coach-pack.mjs",
            ["--pass", "2", "--apply"],
            dir,
        );
        assert.equal(refused.code, EXIT.FAILED, refused.all);

        // Exactly the command the refusal printed, with nothing added.
        const remedy = runScript("preview.mjs", ["--apply", "--replace"], dir);
        assert.equal(
            remedy.code,
            EXIT.OK,
            `the remedy itself must be accepted\n${remedy.all}`,
        );

        const retried = runScript(
            "coach-pack.mjs",
            ["--pass", "2", "--apply"],
            dir,
        );
        assert.equal(
            retried.code,
            EXIT.OK,
            `and the retry must now pass\n${retried.all}`,
        );
        assert.equal(
            fs.existsSync(manifestPathFor(dir)),
            true,
            "the manifest it was refused is now published",
        );
    });

    // AN ISOLATED COPY OF THE TOOL. The boundary tests below plant directory junctions at
    // `coach/pack` and at `coach/` itself, and doing that to the real tool folder would
    // destroy a developer's existing packs and briefly replace a committed directory. The
    // stage resolves COACH_DIR from its own file location, so a copied `src/` gets a copied
    // `coach/` — the real resolution logic, none of the real files. The copy lives inside the
    // package so `node_modules` still resolves from it.
    function toolFixture(t) {
        const root = fs.mkdtempSync(path.join(SRC_DIR, "..", ".tool-fixture-"));
        t.after(() => removeFixture(root));
        fs.cpSync(SRC_DIR, path.join(root, "src"), { recursive: true });
        fs.mkdirSync(path.join(root, "coach"), { recursive: true });
        fs.writeFileSync(
            path.join(root, "coach", "rubric.md"),
            "# stub rubric\n",
        );
        return root;
    }

    const runFixtureStage = (root, args, cwd) => {
        const r = spawnSync(
            process.execPath,
            [path.join(root, "src", "coach-pack.mjs"), ...args],
            {
                cwd,
                encoding: "utf8",
                timeout: 120_000,
            },
        );
        return { code: r.status, all: (r.stdout ?? "") + (r.stderr ?? "") };
    };

    // Proves the fixture is a working engine before either refusal test relies on it. Without
    // this, a fixture that simply cannot run would make both refusals look like successes.
    test("coachPackFixture_isAWorkingCopyOfTheStage_soARefusalBelowMeansSomething", (t) => {
        const dir = previewed(t);
        const root = toolFixture(t);

        const r = runFixtureStage(root, ["--pass", "2", "--apply"], dir);

        assert.equal(
            r.code,
            EXIT.OK,
            `the isolated copy must pack normally\n${r.all}`,
        );
        assert.equal(
            fs.existsSync(
                path.join(
                    root,
                    "coach",
                    "pack",
                    packIdentity(dir),
                    "manifest.json",
                ),
            ),
            true,
        );
    });

    // THE PACK ROOT IS GUARDED, NOT JUST THE MANIFEST NAME. A link at `coach/pack` pointing
    // out of the tool would otherwise have the boundary canonicalise onto the target and
    // certify writes there.
    test("coachPack_packFolderIsALinkOutOfTheTool_refusesWithoutWritingThroughIt", (t) => {
        const dir = previewed(t);
        const root = toolFixture(t);
        const elsewhere = fs.mkdtempSync(
            path.join(os.tmpdir(), "sizzlecraft-escape-"),
        );
        t.after(() => removeFixture(elsewhere));
        try {
            fs.symlinkSync(
                elsewhere,
                path.join(root, "coach", "pack"),
                "junction",
            );
        } catch {
            return t.skip("platform refused to create a directory link");
        }

        const r = runFixtureStage(root, ["--pass", "2", "--apply"], dir);

        assert.notEqual(
            r.code,
            EXIT.OK,
            `a linked pack root must not be written through\n${r.all}`,
        );
        assert.deepEqual(
            fs.readdirSync(elsewhere),
            [],
            "and nothing may land at the link target",
        );
    });

    // AND THE BOUNDARY ROOT ITSELF. `coach/` is where the regress stops, so it is checked
    // directly with an lstat rather than trusted — the helper that resolves inside it would
    // canonicalise onto the link's target and never see the substitution.
    test("coachPack_coachFolderItselfIsALink_refusesWithoutWritingThroughIt", (t) => {
        const dir = previewed(t);
        const root = toolFixture(t);
        const elsewhere = fs.mkdtempSync(
            path.join(os.tmpdir(), "sizzlecraft-escape-"),
        );
        t.after(() => removeFixture(elsewhere));

        fs.rmSync(path.join(root, "coach"), { recursive: true, force: true });
        try {
            fs.symlinkSync(elsewhere, path.join(root, "coach"), "junction");
        } catch {
            return t.skip("platform refused to create a directory link");
        }

        const r = runFixtureStage(root, ["--pass", "2", "--apply"], dir);

        assert.notEqual(
            r.code,
            EXIT.OK,
            `a linked coach root must not be written through\n${r.all}`,
        );
        assert.match(
            r.all,
            /is a link or not a directory/,
            `refused as a link, specifically\n${r.all}`,
        );
        assert.deepEqual(
            fs.readdirSync(elsewhere),
            [],
            "and nothing may land at the link target",
        );
    });

    // THE REVIEWER CLAIMED THE UNC BRANCH STOPS AT THE SHARE NAME. Measured, it does not: the
    // alternation is followed by `[^"]*`, which consumes the remainder of the path. Pinned so
    // the claim is settled by a test rather than re-argued, and so a later edit that splits
    // that trailing match off one branch is caught.
    test("coachPack_manifest_redactsAWholeUncPathNotJustItsServerName", (t) => {
        const dir = previewed(t, { overflowing: [1] });
        const recordPath = path.join(dir, "preview", "preview-record.json");
        const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        rec.audit.issues[0].note =
            "loaded from \\\\buildserver\\share01\\secret\\key.pem";
        fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2));

        const r = runScript("coach-pack.mjs", ["--pass", "2", "--apply"], dir);

        assert.equal(r.code, EXIT.OK, r.all);
        const raw = fs.readFileSync(manifestPathFor(dir), "utf8");
        for (const leak of ["buildserver", "share01", "secret", "key.pem"]) {
            assert.doesNotMatch(
                raw,
                new RegExp(leak.replace(".", "\\.")),
                `"${leak}" must not survive\n${raw}`,
            );
        }
        // NEGATIVE CONTROL: the scrubber must not simply be eating the transcript.
        assert.match(
            raw,
            /overflow-after-fit/,
            "the finding itself still has to be there",
        );
    });

    // THE GITIGNORE TRAP, pinned. An unanchored `coach/` rule would leave the rubric tracked
    // while silently dropping every future file in that folder out of `git status`.
    test("coachPackIgnore_ignoresTheGeneratedPackWhileTheRubricStaysTracked", () => {
        const check = (p) => {
            const r = spawnSync("git", ["check-ignore", "-q", p], {
                cwd: SRC_DIR,
            });
            return r.status === 0;
        };

        assert.equal(
            check(path.join(COACH, "rubric.md")),
            false,
            "the rubric is a reviewed artifact and MUST stay tracked",
        );
        assert.equal(
            check(path.join(COACH, "pack", "demo", "manifest.json")),
            true,
            "the generated pack must be ignored",
        );
        assert.equal(
            spawnSync(
                "git",
                ["ls-files", "--error-unmatch", path.join(COACH, "rubric.md")],
                { cwd: SRC_DIR },
            ).status,
            0,
            "and git must actually be tracking it today",
        );
    });
});
