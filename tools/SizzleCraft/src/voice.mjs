// Voice stage v2 — ffmpeg-free, with PERCEIVED-gap control.
//
// The audible gap between two segments is not just the silence we insert: it is
//     tail_silence(segment N) + inserted_silence + head_silence(segment N+1)
// Every TTS clip carries its own leading/trailing silence (~0.2-0.3s each), so this stage
// measures that from the word-boundary metadata and solves each inserted gap so the
// PERCEIVED gap hits its target exactly.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseFile } from "music-metadata";
import { normalizeEndCardFields } from "./end-card.mjs";
import {
    EXIT,
    guard,
    parseCli,
    requireExistingFile,
    resolveEngineOutput,
    resolveInternalArtifact,
    openExclusiveEngineFile,
    describeWrite,
    planFooter,
    requireFiniteNumber,
    assertDistinctDestinations,
    timingSeal,
    mp3AudioStart as audioStart,
} from "./cli-support.mjs";
import {
    isSilentSegment,
    silentDurationMs,
    silentMp3,
    silenceAssetBytes,
    buildCalibration,
    voiceWriteSet,
    voiceTimelineBlocker,
    renderBlocker,
    segmentClipName,
    gapAssetName,
} from "./silent-segment.mjs";

const USAGE = `
voice — synthesise narration per segment and concatenate it (pipeline stage S3).

  node voice.mjs                       plan only (default)
  node voice.mjs --apply --replace     synthesise and rewrite voiceover.mp3 + timing.json

Options
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually synthesise and write. Without it nothing is written.
  --replace         permit overwriting the segment clips, the lead-in, gap and outro
                    silences, voiceover.mp3 and timing.json
  --help            show this message

This stage calls a network TTS service and rewrites the approved timeline, so it does
nothing without an explicit opt-in.

--apply is NOT a verification step. It re-synthesises every clip and overwrites
voiceover.mp3. The new audio is length-deterministic but NOT byte-deterministic — same
durations to the millisecond, same byte lengths, different samples — so a re-run does not
reproduce a shipped deliverable. If you need both the re-measurement and the shipped
audio, keep this run's timing.json + calibration-observed.json and restore the previous
audio files: the narration fingerprint is over the TEXT, so the two are separable.

Exit codes: 0 success/plan · 1 synthesis failed · 2 bad usage, a refused timeline or a refused overwrite
`.trimStart();

const cli = (() => {
    try {
        return parseCli({ usage: USAGE });
    } catch (err) {
        if (err.name === "HelpRequested") {
            console.log(err.usage);
            process.exit(EXIT.OK);
        }
        console.error(`error: ${err.message}`);
        process.exit(err.exitCode ?? EXIT.FAILED);
    }
})();

const dir = cli.projectDir;
const timingPath = guard(() =>
    requireExistingFile(dir, "timing.json", "timing file"),
);
const timing = JSON.parse(fs.readFileSync(timingPath, "utf8"));
const stable = timing.intake || {};
for (const k of ["voice", "speed", "silenceMs", "toleranceMs"]) {
    if (stable[k] === undefined || stable[k] === null) {
        console.error(
            `error: pre-approval stable timing input missing: intake.${k}`,
        );
        process.exit(EXIT.USAGE);
    }
}
if (!timing.endCard || typeof timing.endCard.enabled !== "boolean") {
    console.error(
        "error: pre-approval endCard decision missing (timing.endCard.enabled must be a boolean)",
    );
    process.exit(EXIT.USAGE);
}

const voice = stable.voice;
// Validated, not coerced. `Number('oops')` is NaN, and `drift > Math.max(NaN, 1500)`
// is `drift > NaN` — always false. The C-6 drift check below would still be written,
// still be reached, and never fire. A threshold that cannot be compared does not relax
// the check, it deletes it.
const speed = guard(() =>
    requireFiniteNumber(stable.speed, {
        name: "intake.speed",
        min: 0.5,
        max: 2,
    }),
);
const toleranceMs = guard(() =>
    requireFiniteNumber(stable.toleranceMs, {
        name: "intake.toleranceMs",
        min: 0,
        max: 600_000,
    }),
);
const perSegToleranceMs = guard(() =>
    requireFiniteNumber(stable.perSegmentToleranceMs ?? 150, {
        name: "intake.perSegmentToleranceMs",
        min: 0,
        max: 600_000,
    }),
);

// --- PERCEIVED pacing targets (ms) ----------------------------------------------------------
const LEAD_IN_MS = guard(() =>
    requireFiniteNumber(stable.leadInMs ?? 2000, {
        name: "intake.leadInMs",
        min: 0,
        max: 600_000,
    }),
);
const GAP_DEFAULT_MS = guard(() =>
    requireFiniteNumber(stable.perceivedGapMs ?? 2000, {
        name: "intake.perceivedGapMs",
        min: 0,
        max: 600_000,
    }),
);
const GAP_OVERRIDES = stable.perceivedGapOverrides || {}; // { "<afterSegmentId>": ms }
const FRAME_MS = 24; // one MPEG-2 L3 frame @ 24 kHz
const alignUp = (ms) => Math.max(0, Math.round(ms / FRAME_MS) * FRAME_MS);

// --- C-11: voice must be on the brand allow-list ---------------------------------------------
// REPORTED, NOT THROWN. Every refusal below ends the run the way this file's own USAGE
// header already says it does: "2 bad usage, a refused timeline or a refused overwrite"
// for a prerequisite that is missing or unusable, "1 synthesis failed" for work that ran
// and came back wrong. An uncaught throw also exits 1, but only because that is Node's
// default for an uncaught exception — it is not a chosen code, and it arrives as a source
// excerpt, a caret and a stack frame, which reads as a bug in the engine rather than a
// refusal of the input. This stage calls a network service and rewrites the approved
// timeline, so the difference is not cosmetic: two of these fire after irreversible writes.
const refuse = (message, code = EXIT.FAILED) => {
    console.error(`error: ${message}`);
    process.exit(code);
};

// The allow-list is a PREREQUISITE this stage reports for itself. voiceTimelineBlocker
// deliberately does not model it — silent-segment.mjs says so at its gates: the blockers
// "do not model the intake, the brand tokens, the TTS service or the replace guard, which
// each stage reports for itself when it runs."
//
// Resolved through the boundary, not joined. brand/tokens.json is ENGINE-CHOSEN — the
// caller never names it — so a link there was planted rather than requested, and
// resolveInternalArtifact refuses it outright instead of reading a file nobody asked for.
// The original `path.join(dir, 'brand', 'tokens.json')` had no boundary at all.
const tokensPath = guard(() =>
    resolveInternalArtifact(
        dir,
        "brand/tokens.json",
        "brand voice allow-list",
        "read",
    ),
);
let tokensText;
try {
    tokensText = fs.readFileSync(tokensPath, "utf8");
} catch (err) {
    // READING and PARSING fail for different reasons and need different remedies. Collapsing
    // a permission error or a directory-in-the-way into "it is not valid JSON" hands the
    // author a fix for a problem they do not have. The raw error is not echoed: it carries
    // an absolute path that tells them nothing they can act on.
    refuse(
        `C-11: cannot read the brand voice allow-list at brand/tokens.json — ${err.code === "ENOENT" ? "it is not there" : `it could not be opened (${err.code ?? "unknown error"})`}`,
        EXIT.USAGE,
    );
}
let allowVoices;
try {
    allowVoices = JSON.parse(tokensText)?.audio?.ttsVoices;
} catch {
    refuse(
        "C-11: cannot read the brand voice allow-list at brand/tokens.json — it is not valid JSON",
        EXIT.USAGE,
    );
}
if (!Array.isArray(allowVoices) || !allowVoices.length) {
    refuse(
        "C-11: brand/tokens.json declares no audio.ttsVoices allow-list, so no voice can be approved",
        EXIT.USAGE,
    );
}
if (!allowVoices.includes(voice)) {
    refuse(
        `C-11: voice "${voice}" is not on the brand/tokens.json allow-list [${allowVoices.join(", ")}]`,
        EXIT.USAGE,
    );
}

const probeMs = async (f) =>
    Math.round(
        ((await parseFile(f, { duration: true })).format.duration ?? 0) * 1000,
    );
const ratePct = (speed >= 1 ? "+" : "") + Math.round((speed - 1) * 100) + "%";

// ---- the timeline ---------------------------------------------------------------------------
// Checked before the write set is built, in the plan and under --apply alike: the segments'
// shape, every silence declaration, the narration text, and that some segment is narrated.
// A timeline that fails one is refused here, so the plan does not promise a run that --apply
// would refuse for it, and the refused run writes nothing and calls no TTS service. The
// checks are voiceTimelineBlocker's, in silent-segment.mjs; the gate other stages ask before
// naming this stage makes them too, so the two agree. A malformed declaration is reported in
// its own words, as remix reports one.
const timelineRefusal = voiceTimelineBlocker(timing);
if (timelineRefusal) {
    console.error(
        timelineRefusal.declaration
            ? `error: ${timelineRefusal.fact}`
            : `error: ${renderBlocker(timelineRefusal)}.`,
    );
    process.exit(EXIT.USAGE);
}

// ---- the write set --------------------------------------------------------------------------
// Declared once and used for three things: the plan, the distinctness check, and the
// actual writes. Every entry is an ENGINE-chosen artifact — the caller names none of
// these — so each resolves with links refused, not followed.
//
// That includes the pause assets. lead.mp3, gap_NN.mp3 and outro.mp3 were written by a
// silence-gen child through the resolver that FOLLOWS an in-root link, and were missing
// from this list — so the plan never named them and a planted link was written through.
// Only the ones this run CAN write are listed: a seam touching a declared silent segment
// never gets a pause, and a silent first segment never gets a lead-in, whatever the solve.
// The list is built in silent-segment.mjs, where the gate other stages ask before naming
// this one as a remedy builds it too.
const WRITE_SET = voiceWriteSet(timing);
// Resolved without the replace guard first, so the plan can describe replacing a file
// rather than refusing to talk about it.
const writeSet = WRITE_SET.map((o) => ({
    ...o,
    path: guard(() =>
        resolveEngineOutput(dir, o.key, {
            apply: false,
            replace: cli.replace,
            label: o.label,
        }),
    ),
}));
guard(() =>
    assertDistinctDestinations(
        writeSet.map(({ key, path: p }) => ({ key, path: p })),
        "output",
    ),
);

// ---- the safe default -----------------------------------------------------------------------
// Prerequisites and the write set are established first, so the plan reports the truth
// about every file --apply touches, pause assets included. Nothing has been written; a
// bare run stops here rather than calling the TTS service and rewriting the timeline.
if (!cli.apply) {
    console.log(
        `plan: synthesise ${timing.segments?.length ?? 0} segment(s) with voice "${voice}" at ${ratePct}`,
    );
    for (const o of writeSet) {
        const status = o.append
            ? "would APPEND on a synthesis retry"
            : describeWrite(o.path, cli.replace);
        console.log(
            `  ${o.key.padEnd(26)} ${status}${o.solved ? ` (written only if the solve inserts ${o.solved})` : ""}`,
        );
    }
    if (writeSet.some((o) => o.solved)) {
        console.log(
            "  note: a lead-in or pause solved to 0ms writes nothing and leaves any existing file of that",
        );
        console.log(
            "  name as it is. Each is still held to --replace, because the solve is known only after synthesis.",
        );
    }
    planFooter();
    process.exit(EXIT.OK);
}
// Now that we are writing, enforce the replace guard across the whole set.
for (const o of writeSet) {
    if (!o.append)
        guard(() =>
            resolveEngineOutput(dir, o.key, {
                apply: true,
                replace: cli.replace,
                label: o.label,
            }),
        );
}

const pathFor = (key) => writeSet.find((o) => o.key === key).path;
// Only the heal log keeps a resolved destination of its own now: everything else is
// written to a staging file and renamed by the publish loop, which takes each destination
// from pathFor at stage() time.
const healLogPath = pathFor("heal-log.txt");

// ---- staging ---------------------------------------------------------------------------------
// MEASURED BEFORE THIS EXISTED: a C-10 failure and an end-card failure each left new audio
// on disk beside a timeline still describing the old. remix.mjs already solved exactly this
// — its own test says "A C-6 failure used to exit with a stack trace after the silent clips,
// the pauses and the voice track had already been overwritten, leaving new audio beside a
// timeline that described the old." This stage simply never got the same treatment, and it
// is the most expensive one in the engine to fail late.
//
// So every output is written to an exclusive `.part-` file beside its destination and
// renamed into place only once the whole run has succeeded. The staging files are real
// files, which is what makes this work here: probeMs and the concatenation read a staged
// path exactly as they read a final one.
//
// heal-log.txt is DELIBERATELY NOT STAGED. It records the retry attempts, so it is written
// DURING a failure and has to survive it — a log of what went wrong is worthless if it is
// rolled back with everything else. That is why this stage cannot borrow remix's phrase
// "nothing was written": here one thing was, on purpose, and the refusals below say so.
const staged = [];
const stage = (key, bytes) => {
    let handle;
    try {
        handle = openExclusiveEngineFile(
            dir,
            `${key}.part-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
            `${key} staging file`,
        );
    } catch (err) {
        // `abandon`, not `refuse`: a staging failure on the fifth file must not strand the four
        // before it. The entry for THIS file is not in `staged` yet — openExclusiveEngineFile
        // only returns a handle when it created the file — so there is nothing of its own to
        // remove, but everything already staged has to go.
        abandon(
            `could not stage ${key}: ${err.message} No audio or timeline output was published.`,
            EXIT.FAILED,
        );
    }
    const entry = {
        key,
        dest: pathFor(key),
        path: handle.path,
        handle,
        published: false,
    };
    staged.push(entry);
    try {
        fs.writeFileSync(handle.fd, bytes);
        fs.closeSync(handle.fd);
    } catch (err) {
        // Pushed before the write, so this file's own handle is in `staged` and `abandon`
        // cleans it up along with the rest.
        abandon(
            `could not write the ${key} staging file (${err.code ?? err.message}). No audio or timeline output was published.`,
            EXIT.FAILED,
        );
    }
    return entry.path;
};

/** Removes staging files, newest first, and reports any it could not remove. */
const discardFrom = (mark = 0) => {
    const leftovers = [];
    for (const e of staged.splice(mark).filter((x) => !x.published)) {
        const outcome = e.handle.cleanup();
        if (outcome) leftovers.push(outcome.message);
    }
    return leftovers;
};

/**
 * Ends the run without publishing anything.
 *
 * Every refusal after synthesis begins goes through here, so there is one place that knows
 * the staging files must go first. Reporting a clean abort while leaving `.part-` files
 * behind would claim a guarantee that was not honoured, so what could not be removed is
 * named rather than swallowed.
 */
const abandon = (message, code = EXIT.FAILED) => {
    for (const left of discardFrom(0)) console.error(`warning: ${left}`);
    refuse(message, code);
};

// Loaded only on the --apply path: a plan must not need the TTS client.
const { MsEdgeTTS } = await import("msedge-tts");

async function synthOnce(text, stageBytes) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, "audio-24khz-96kbitrate-mono-mp3", {
        wordBoundaryEnabled: true,
    });
    const { audioStream, metadataStream } = tts.toStream(text, {
        rate: ratePct,
    });
    const chunks = [],
        words = [];
    metadataStream.on("data", (buf) => {
        try {
            const p = JSON.parse(Buffer.from(buf).toString("utf8"));
            for (const m of p.Metadata || [])
                if (m.Type === "WordBoundary")
                    words.push({
                        word: m.Data.text.Text,
                        localStartMs: Math.round(m.Data.Offset / 10000),
                        localEndMs: Math.round(
                            (m.Data.Offset + m.Data.Duration) / 10000,
                        ),
                    });
        } catch {}
    });
    audioStream.on("data", (c) => chunks.push(c));
    await new Promise((r, j) => {
        audioStream.on("end", r);
        audioStream.on("error", j);
    });
    await new Promise((r) => setTimeout(r, 400));
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error("empty TTS stream");
    // Staged, not written to the destination. The clip still has to exist as a real file for
    // probeMs to measure it — a staging file is one, so nothing about the measurement changes.
    const file = stageBytes(buf);
    const durationMs = await probeMs(file);
    if (!durationMs) throw new Error("zero-duration TTS output");
    if (!words.length) throw new Error("no word boundaries returned");
    const computedMs = words[words.length - 1].localEndMs;
    const scale = computedMs > 0 ? durationMs / computedMs : 1;
    // head/tail silence, in the REAL (scaled) timebase
    const headMs = Math.max(0, Math.round(words[0].localStartMs * scale));
    const tailMs = Math.max(
        0,
        durationMs - Math.round(words[words.length - 1].localEndMs * scale),
    );
    return { file, durationMs, words, scale, headMs, tailMs };
}

async function synth(text, key, id) {
    // C-14 bounded self-heal
    for (let attempt = 1; attempt <= 4; attempt++) {
        // Each attempt stages its own file, and a failed one discards only what IT staged.
        // Without the mark, a retry would leave the previous attempt's staging file behind and
        // publish the first of several clips claiming the same destination.
        const mark = staged.length;
        try {
            return await synthOnce(text, (bytes) => stage(key, bytes));
        } catch (e) {
            for (const left of discardFrom(mark))
                console.error(`warning: ${left}`);
            // Written straight to its destination, not staged: see the staging block above.
            fs.appendFileSync(
                healLogPath,
                `[voice] ${id} attempt ${attempt}: ${e.message}\n`,
            );
            console.log(
                `[voice] ${id} attempt ${attempt} failed: ${e.message}`,
            );
            if (attempt === 4) throw e;
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
}

// ---- 1. synthesize -------------------------------------------------------------------------
// EVERYTHING FROM HERE TO THE PUBLISH LOOP RUNS INSIDE ONE HANDLER. Staging only protects
// the failures it can see: the refusals below route through `abandon`, but a rejected
// probeMs, a corrupt clip or any other unexpected throw would otherwise escape at module
// scope and leave `.part-` files behind — a run that reports nothing was published while
// littering the project with staged audio. remix.mjs wraps its staged region the same way.
try {
    // A DECLARED SILENT SEGMENT IS NEVER SENT TO TTS. Synthesising "" returns an empty stream
    // with no word boundaries, which synthOnce correctly rejects ('zero-duration TTS output' /
    // 'no word boundaries returned') — four times, with backoff, before failing the run. Its
    // clip is instead GENERATED at the authored window length, so the segment occupies exactly
    // the time it was authored to occupy and every later segment keeps its place.
    console.log(`voice=${voice} rate=${ratePct} (speed ${speed})\n`);
    const results = [];
    for (let i = 0; i < timing.segments.length; i++) {
        const seg = timing.segments[i];
        if (isSilentSegment(seg)) {
            const authoredMs = silentDurationMs(seg);
            const file = stage(segmentClipName(i), silentMp3(authoredMs));
            // Probed, not assumed: silence is frame-quantised to 24ms, so the clip that exists can
            // differ from the one that was asked for by up to 12ms. The timeline must describe the
            // audio on disk, not the request.
            const durationMs = await probeMs(file);
            // headMs/tailMs are 0 because there is no speech for silence to lead or trail. The
            // gap solve below does not consult them for a silent segment anyway — it skips the
            // seam entirely, because the authored silence already IS the pause.
            // `name` is the FINAL clip name, never the staging one: the timeline records where the
            // audio will live, not where it is being assembled.
            results.push({
                file,
                name: segmentClipName(i),
                durationMs,
                words: [],
                scale: 1,
                headMs: 0,
                tailMs: 0,
                silent: true,
            });
            console.log(
                `silent ${seg.id.padEnd(11)} ${String(durationMs).padStart(6)}ms  (authored ${authoredMs}ms, generated — not synthesised)`,
            );
            continue;
        }
        // C-14's retries are exhausted by the time this rethrows, so there is nothing left to
        // try. Reported as a synthesis failure — "the work ran and the result is bad" — rather
        // than escaping as the raw service error, which named no segment.
        let r;
        try {
            r = await synth(seg.voiceoverText, segmentClipName(i), seg.id);
        } catch (err) {
            abandon(
                `C-14: segment "${seg.id}" could not be synthesised after 4 attempts — ${err.message} No audio or timeline output was published; heal-log.txt records the attempts.`,
                EXIT.FAILED,
            );
        }
        r.name = segmentClipName(i);
        results.push(r);
        console.log(
            `synth ${seg.id.padEnd(11)} ${String(r.durationMs).padStart(6)}ms  head ${String(r.headMs).padStart(4)}ms  tail ${String(r.tailMs).padStart(4)}ms`,
        );
    }

    // ---- 2. per-segment fit gate (C-10) --------------------------------------------------------
    // Silent segments are exempt: their clip is generated FROM the window, so comparing the
    // two is comparing a value to itself and can only fail on the 24ms quantisation.
    const overruns = timing.segments
        .map((s, i) => ({
            id: s.id,
            over: results[i].durationMs - (s.endMs - s.startMs),
            silent: results[i].silent,
        }))
        .filter((f) => !f.silent && f.over > perSegToleranceMs);
    // MEASURED: by the time this fires, every clip has been synthesised. Before staging it
    // also meant they were already at their destinations, so the run left new audio beside a
    // timeline describing the old. Now nothing is published and the report says so.
    if (overruns.length)
        abandon(
            `C-10 per-segment fit failed: ${overruns.map((o) => `${o.id} (+${o.over}ms)`).join(", ")}. No audio or timeline output was published: each is as it was.`,
            EXIT.FAILED,
        );

    // ---- 3. solve inserted silences so PERCEIVED pacing hits its targets ------------------------
    // No lead-in before a segment that is itself silence — the author already said how long
    // the opening beat is.
    const leadInsertedMs = results[0].silent
        ? 0
        : alignUp(Math.max(0, LEAD_IN_MS - results[0].headMs));
    const gaps = []; // gaps[i] = silence inserted AFTER segment i
    console.log("\nperceived-gap solve:");
    console.log(
        `  lead-in       target ${String(LEAD_IN_MS).padStart(5)}ms  - head ${String(results[0].headMs).padStart(4)}ms  -> insert ${leadInsertedMs}ms${results[0].silent ? "  (suppressed: segment 1 is declared silent)" : ""}`,
    );
    for (let i = 0; i < timing.segments.length - 1; i++) {
        const after = timing.segments[i].id;
        // A seam touching a declared silent segment gets no inserted gap: the authored silence
        // is the pause, and padding it would make the audio longer than the timeline says.
        if (results[i].silent || results[i + 1].silent) {
            gaps.push(0);
            console.log(
                `  after ${after.padEnd(10)} no gap inserted — a declared silent segment adjoins this seam`,
            );
            continue;
        }
        const target = Number(GAP_OVERRIDES[after] ?? GAP_DEFAULT_MS);
        const tail = results[i].tailMs,
            head = results[i + 1].headMs;
        const inserted = alignUp(Math.max(0, target - tail - head));
        gaps.push(inserted);
        console.log(
            `  after ${after.padEnd(10)} target ${String(target).padStart(5)}ms  - tail ${String(tail).padStart(4)} - head ${String(head).padStart(4)}  -> insert ${String(inserted).padStart(5)}ms  (perceived ~${tail + inserted + head}ms)`,
        );
    }

    // ---- materialise the pause assets the solve needs --------------------------------------------
    // Written in-process, to the paths resolved and guarded with the rest of the write set
    // before anything was synthesised: each name is engine-chosen, so a link there was refused
    // up front rather than followed now. The bytes are silence-gen's (see silenceAssetBytes),
    // and every one is computed before any is written, so a pause silence-gen would have
    // refused fails the run without leaving half of them behind. A pause solved to 0ms writes
    // nothing, as before.
    const pauseAsset = (ms, name) => {
        if (ms <= 0) return null;
        // NOT `guard()`. guard() calls process.exit() itself, which would walk straight past the
        // outer handler and strand every clip already staged — a refusal that leaves the mess it
        // exists to prevent. silenceAssetBytes refuses a pause outside its limits, and by this
        // point every clip is staged, so the refusal has to go through `abandon`. Its own exit
        // code is preserved: this is still the caller's bad input, not a failed run.
        let bytes;
        try {
            bytes = silenceAssetBytes(ms, name);
        } catch (err) {
            abandon(
                `${err.message} No audio or timeline output was published: each is as it was.`,
                err.exitCode ?? EXIT.USAGE,
            );
        }
        return { name, bytes };
    };
    const leadAsset = pauseAsset(leadInsertedMs, "lead.mp3");
    const gapAssets = gaps.map((ms, i) => pauseAsset(ms, gapAssetName(i)));
    const outroTargetMs = timing.endCard.enabled ? Number(timing.outroMs) : 0;
    const outroAsset =
        outroTargetMs > 0 ? pauseAsset(outroTargetMs, "outro.mp3") : null;
    const stagedPause = (a) => (a ? stage(a.name, a.bytes) : null);
    const leadFile = stagedPause(leadAsset);
    const gapFiles = gapAssets.map(stagedPause);
    const outroFile = stagedPause(outroAsset);

    const leadRealMs = leadFile ? await probeMs(leadFile) : 0;
    const gapRealMs = [];
    for (const f of gapFiles) gapRealMs.push(f ? await probeMs(f) : 0);
    const outroRealMs = outroFile ? await probeMs(outroFile) : 0;

    // ---- 4. reflow the timeline onto measured audio + solved gaps -------------------------------
    let cursor = leadRealMs;
    for (let i = 0; i < timing.segments.length; i++) {
        const seg = timing.segments[i],
            r = results[i];
        const authoredWindowMs = seg.endMs - seg.startMs;
        const priorMeasuredMs = Number(seg.audio?.durationMs);
        const stillReflowed =
            Number.isFinite(seg.plannedDurationMs) &&
            Number.isFinite(priorMeasuredMs) &&
            authoredWindowMs === priorMeasuredMs;
        seg.plannedDurationMs = stillReflowed
            ? seg.plannedDurationMs
            : authoredWindowMs;
        seg.startMs = cursor;
        seg.endMs = cursor + r.durationMs;
        seg.audio = {
            // The FINAL clip name, not the staging path it is being assembled at. Recording
            // path.basename(r.file) here would have written `segment_01.mp3.part-1234-ab…` into
            // the published timeline, naming a file that is renamed away moments later.
            file: r.name,
            durationMs: r.durationMs,
            headMs: r.headMs,
            tailMs: r.tailMs,
            words: r.words.map((w) => ({
                word: w.word,
                startMs: cursor + Math.round(w.localStartMs * r.scale),
                endMs: cursor + Math.round(w.localEndMs * r.scale),
            })),
        };
        cursor =
            seg.endMs + (i < timing.segments.length - 1 ? gapRealMs[i] : 0);
    }
    const contentMs = timing.segments[timing.segments.length - 1].endMs;

    // ---- 5. concatenate ------------------------------------------------------------------------
    const parts = [];
    if (leadFile) parts.push(leadFile);
    for (let i = 0; i < results.length; i++) {
        parts.push(results[i].file);
        if (i < results.length - 1 && gapFiles[i]) parts.push(gapFiles[i]);
    }
    if (outroFile) parts.push(outroFile);
    const voiceStagedPath = stage(
        "voiceover.mp3",
        Buffer.concat(
            parts.map((p, i) => {
                const b = fs.readFileSync(p);
                return i === 0 ? b : b.subarray(audioStart(b));
            }),
        ),
    );

    // ---- 6. end-card fields + drift gate (C-6) --------------------------------------------------
    const bvOk =
        typeof timing.builderVersion === "string" &&
        timing.builderVersion.trim() !== "" &&
        !["undefined", "null"].includes(
            timing.builderVersion.trim().toLowerCase(),
        );
    // NOW A CLEAN REFUSAL, AND NOW HARMLESS. Measured before staging, this fired after
    // voiceover.mp3 had already been overwritten, leaving new audio beside the old timeline —
    // it was the last site in this stage still ending in an uncaught throw. Nothing is
    // published until every check below has passed.
    if (timing.endCard.enabled && !bvOk) {
        abandon(
            "approved enabled endCard requires a valid builderVersion. No audio or timeline output was published: each is as it was.",
            EXIT.FAILED,
        );
    }
    // A disabled end card must leave NONE of its three fields behind. This stripped contentMs
    // and outroMs and kept builderVersion, which was invisible until the schema enforced the
    // rule — at which point no run could have produced a schema-valid disabled-end-card
    // timeline. The rule lives in end-card.mjs so it can be tested without synthesising speech.
    normalizeEndCardFields(timing, { contentMs, outroMs: outroRealMs });
    timing.leadInMs = leadRealMs;

    const voiceMs = await probeMs(voiceStagedPath);
    const driftMs = Math.abs(voiceMs - timing.durationMs);
    console.log(
        `\nvoiceover ${voiceMs}ms | timeline ${timing.durationMs}ms | drift ${driftMs}ms`,
    );
    // LEFT AS A THROW, DELIBERATELY. Every other crash site in this stage was converted and
    // pinned by a test; this one could not be. normalizeEndCardFields above ALWAYS rewrites
    // timing.durationMs from this run's own reflow, immediately before this comparison, so an
    // authored value cannot reach it and no input constructed for this change makes it fire.
    // Converting it would have been an unverifiable behaviour change to a published stage —
    // a diff that looks like progress and proves nothing. It stays until it can be triggered,
    // and the reason is recorded here so the next reader does not take it for an oversight.
    if (driftMs > Math.max(toleranceMs, 1500))
        throw new Error(`C-6 voice drift ${driftMs}ms exceeds tolerance`);

    // ---- 7. calibration evidence + timing hash --------------------------------------------------
    // Silent segments are excluded from the word-rate maths and kept in the record. See
    // buildCalibration: a rate over zero words is NaN, JSON.stringify writes NaN as `null`,
    // and validate-timing then reports a failure that is true about the wrong cause.
    const roundedSpeed = 1 + Math.round((speed - 1) * 100) / 100;
    const calibration = buildCalibration(timing.segments, results, {
        voiceId: voice,
        roundedSpeed,
    });
    const obsEff = calibration.aggregate.observedEffWps;
    stage("calibration-observed.json", JSON.stringify(calibration, null, 2));

    // Staged BEFORE timing.json, so the timeline stays last in publish order. Staged after it,
    // a failed rename of the mapping happened once the timeline was already published — while
    // the error below still said "timing.json was not updated", which was then false.
    stage(
        "sync-mapping.md",
        `# Sync Mapping\n\nvoice=${voice}\nrate=${ratePct}\nvoiceoverMs=${voiceMs}\ntimingMs=${timing.durationMs}\n` +
            `contentMs=${contentMs}\nleadInMs=${leadRealMs}\noutroMs=${outroRealMs}\n` +
            `perceivedGapTargetMs=${GAP_DEFAULT_MS}\ninsertedGapsMs=${gapRealMs.join(",")}\ndriftMs=${driftMs}\n` +
            `observedEffWps=${obsEff.toFixed(3)}\nstatus=pass\n`,
    );

    delete timing.timingHash;
    timing.timingHash = timingSeal(timing);
    // LAST. Every other artifact is in place before the timeline that describes them.
    stage("timing.json", JSON.stringify(timing, null, 2));

    // ---- 8. publish ------------------------------------------------------------------------------
    // Renamed in the order staged — clips, pauses, the voice track, the mapping, then
    // timing.json last — so the timeline is never updated to describe audio that is not yet in
    // place. Nothing is rolled back: a rename that fails leaves those before it published, so
    // the report names exactly which were and which were not rather than guessing.
    for (const e of staged) {
        try {
            fs.renameSync(e.path, e.dest);
            e.published = true;
        } catch (err) {
            const published = staged
                .filter((x) => x.published)
                .map((x) => x.key);
            const unpublished = staged
                .filter((x) => !x.published)
                .map((x) => x.key);
            // `timing.json` is staged LAST, so it is never among the published when this handler
            // runs — if its own rename is the one that failed, it is in `unpublished` like any
            // other. The statement below is therefore unconditional and true.
            //
            // An earlier version made it conditional on `published.includes('timing.json')`. That
            // branch cannot be reached, which makes it exactly the dead defence this stage removed
            // from C-6: a line that looks like rigour and can never run. The ordering is what makes
            // the claim safe, so the ordering is what is documented.
            for (const left of discardFrom(0))
                console.error(`warning: ${left}`);
            refuse(
                `could not publish ${e.key} (${err.code ?? err.message}). ` +
                    `Published: ${published.length ? published.join(", ") : "nothing"}. Not published: ${unpublished.join(", ")}. ` +
                    "timing.json was not updated, so it still describes the audio from before this run" +
                    (published.length
                        ? ", while the files published above hold this run's"
                        : "") +
                    ". Fix the cause and re-run voice.mjs --apply --replace.",
                EXIT.FAILED,
            );
        }
    }

    const mm = (ms) =>
        `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;
    console.log(
        `\nwrote voiceover.mp3 — final length ${mm(timing.durationMs)} (${timing.durationMs}ms)`,
    );
    console.log(`speech-only rate ${obsEff.toFixed(2)} words/sec at ${speed}x`);
} catch (err) {
    // The backstop for anything the refusals above do not model: a rejected probe, a clip
    // music-metadata cannot read, a bug here. Staging files go first, so the project is left
    // as it was found whichever way the run ended, and an unexpected error is still reported
    // as unexpected rather than dressed up as a refusal.
    for (const left of discardFrom(0)) console.error(`warning: ${left}`);
    console.error(
        `error: voice.mjs failed after synthesis began — ${err?.message ?? String(err)}. No audio or timeline output was published: each is as it was.`,
    );
    process.exit(EXIT.FAILED);
}
