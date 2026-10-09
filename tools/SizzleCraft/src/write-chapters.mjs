/**
 * S11 — MP4 chapter metadata, one chapter per segment.
 *
 * Chapters come from the MEASURED timeline: each segment's `startMs` after the S4 reflow,
 * and its authored `visual.title` (falling back to `title`, then `id`). No estimates.
 *
 * ⚠️ SUPPORT IS UNEVEN AND THIS IS NOT A UNIVERSAL WIN — see the note printed at the end.
 * Chapter markers are honoured by VLC, QuickTime and several desktop players, and are
 * commonly IGNORED by HTML5 <video> and by corporate streaming portals. If the likely
 * destination ignores them, a visible chapter list in the video description is the only
 * thing that actually works. `--list` prints one ready to paste.
 *
 * PLAN BY DEFAULT, like every other writing stage in this engine. A bare run used to write
 * chapters.ffmeta — before it had even checked that the input existed — and then hand
 * ffmpeg `-y` over the chaptered MP4, with none of its paths confined to the project. Now
 * every path is resolved and every refusal made before anything is written, and ffmpeg is
 * told `-n` unless --replace was given: the overwrite decision is made here, not by it.
 *
 * THE TIMELINE IS VALIDATED BEFORE ANYTHING IS PLANNED. The metadata is derived arithmetic,
 * and arithmetic on a missing duration or an unordered timeline does not fail — it writes
 * `END=undefined`, or a chapter that ends where it starts, and leaves ffmpeg to be the only
 * thing that notices, after chapters.ffmeta has already been replaced.
 *
 * Usage: see USAGE below, or run with --help.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
    EXIT,
    CliError,
    runCli,
    parseCli,
    resolveWithinRoot,
    resolveInternalArtifact,
    resolveOutput,
    resolveEngineOutput,
    assertDistinctDestinations,
    describeWrite,
    planFooter,
    isMs,
    timelineSegmentLabel as segmentLabel,
    describeValue,
    summarise,
    readEngineFile,
    requireRegularFile,
    resolveFfmpegPointer as resolveFfmpeg,
} from "./cli-support.mjs";
import {
    isSilentSegment,
    durationShortfallRemedy,
    durationMeasureRemedy,
    silentWindowFieldProblem,
    narratedWindowFieldRemedy,
} from "./silent-segment.mjs";

const USAGE = `
write-chapters — add MP4 chapter markers, one per segment, taken from the measured
timeline in timing.json (pipeline stage S11). Streams are copied, never re-encoded.

  node write-chapters.mjs                      plan only (default)
  node write-chapters.mjs --apply              write chapters.ffmeta and the chaptered MP4
  node write-chapters.mjs --apply --replace    overwrite either one if it already exists
  node write-chapters.mjs --list               print a chapter list to paste into a video
                                               description; writes nothing

Options
  --input <file>    video to add chapters to (default: <project>-with-music.mp4, from S9)
  --output <file>   chaptered copy to write (default: <project>-with-music-chaptered.mp4)
  --list            print the chapter list and exit. Needs no video and no ffmpeg, and
                    cannot be combined with --apply.
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing chapters.ffmeta or --output
  --help            show this message

ffmpeg is read from ffmpeg-path.txt in the project root.

Exit codes: 0 success/plan/list · 1 unusable timeline or ffmpeg failed · 2 bad usage,
a missing or refused path, or a refused overwrite
`.trimStart();

const safeFileBase = (name, fallback) => {
    const base = path
        .basename(String(name ?? ""))
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "");
    return base || fallback;
};

// The first of visual.title, title and id that is set. readTimeline refuses a segment for
// which that is not a string, so titleOf never meets one.
const rawTitleOf = (s) => s.visual?.title || s.title || s.id;
const titleOf = (s) => rawTitleOf(s).replace(/\s+/g, " ").trim();
const clock = (ms) => {
    const h = Math.floor(ms / 3600000),
        m = Math.floor((ms % 3600000) / 60000),
        sec = Math.floor((ms % 60000) / 1000);
    return h
        ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
        : `${m}:${String(sec).padStart(2, "0")}`;
};

await runCli(() => {
    const { values, projectDir, apply, replace } = parseCli({
        usage: USAGE,
        options: {
            input: { type: "string" },
            output: { type: "string" },
            list: { type: "boolean", default: false },
        },
    });
    if (values.list && apply) {
        throw new CliError(
            "--list prints a chapter list and writes nothing, so it cannot be combined with --apply. Run them separately.",
        );
    }

    const timing = readTimeline(projectDir);
    const projectName = safeFileBase(
        timing.project?.name,
        safeFileBase(path.basename(projectDir), "video"),
    );
    const segs = timing.segments;

    // A chapter runs from its segment's start to the NEXT segment's start, so the inter-segment
    // gap belongs to the chapter it follows rather than falling into a hole. The first chapter
    // starts at 0 so the lead-in is inside chapter 1, not before it.
    const chapters = segs.map((s, i) => ({
        startMs: i === 0 ? 0 : s.startMs,
        endMs: i === segs.length - 1 ? timing.durationMs : segs[i + 1].startMs,
        title: titleOf(s),
    }));

    // --list needs no video and no ffmpeg, so it returns before either is looked for.
    if (values.list) {
        console.log(
            "Chapter list — paste into the video description where players ignore embedded markers:\n",
        );
        for (const c of chapters)
            console.log(`${clock(c.startMs)}  ${c.title}`);
        return EXIT.OK;
    }

    // Every path resolved, and every refusal made, BEFORE the first write. The metadata used
    // to be written first, so a run that then failed on a missing input had still replaced it.
    const input = resolveWithinRoot(
        projectDir,
        values.input ?? `${projectName}-with-music.mp4`,
        "input video",
    );
    requireRegularFile(
        input,
        "input video",
        "run S9 (remux-music) first, or name one with --input",
    );
    // chapters.ffmeta, and the chaptered MP4 unless --output names one, are names the ENGINE
    // chose, so a link at either is refused outright: following it would write a file the
    // caller never named. --output is the caller's own, so it follows the boundary rule.
    const metaPath = resolveEngineOutput(projectDir, "chapters.ffmeta", {
        apply,
        replace,
        label: "chapter metadata",
    });
    const outPath =
        values.output === undefined
            ? resolveEngineOutput(
                  projectDir,
                  `${projectName}-with-music-chaptered.mp4`,
                  { apply, replace, label: "output video" },
              )
            : resolveOutput(projectDir, values.output, {
                  apply,
                  replace,
                  label: "output video",
              });
    // Remuxing onto the input in place would destroy it, and --output chapters.ffmeta would
    // overwrite the metadata ffmpeg is reading.
    assertDistinctDestinations(
        [
            { key: "--input", path: input },
            { key: "chapters.ffmeta", path: metaPath },
            { key: "--output", path: outPath },
        ],
        "write-chapters",
    );
    const ff = resolveFfmpeg(projectDir);

    const meta =
        ";FFMETADATA1\n" +
        chapters
            .map(
                (c) =>
                    `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${c.startMs}\nEND=${c.endMs}\ntitle=${c.title.replace(/[=;#\\\n]/g, " ")}\n`,
            )
            .join("");
    const ffArgs = [
        replace ? "-y" : "-n",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input,
        "-i",
        metaPath,
        "-map_metadata",
        "1",
        "-map_chapters",
        "1",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outPath,
    ];

    if (!apply) {
        console.log(
            `plan: ${chapters.length} chapter markers, streams copied untouched`,
        );
        for (const c of chapters)
            console.log(`  ${clock(c.startMs)}  ${c.title}`);
        console.log(`  input    ${input}`);
        console.log(
            `  metadata ${metaPath} — ${describeWrite(metaPath, replace)}`,
        );
        console.log(
            `  output   ${outPath} — ${describeWrite(outPath, replace)}`,
        );
        console.log(`\nwould run:\n  ${ff} ${ffArgs.join(" ")}`);
        printSupportNote();
        planFooter();
        return EXIT.OK;
    }

    fs.writeFileSync(metaPath, meta);
    try {
        execFileSync(ff, ffArgs, { stdio: "inherit" });
    } catch (err) {
        throw new CliError(
            `ffmpeg failed while adding chapters (${err.message}) — ${outPath} may be missing or incomplete`,
            EXIT.FAILED,
        );
    }

    console.log(
        `wrote ${outPath} — ${chapters.length} chapters, streams copied untouched`,
    );
    for (const c of chapters) console.log(`  ${clock(c.startMs)}  ${c.title}`);
    printSupportNote();
    return EXIT.OK;
});

/**
 * Reads timing.json and refuses a timeline chapters cannot be cut from — before --list
 * prints it, and before anything is planned or written.
 *
 * READ, NOT FOLLOWED. A link at timing.json was followed, so an in-root link made the run
 * describe (and, with --apply, publish) a timeline nobody named, and a JSON parse error
 * quoted the opening bytes of whatever the link led to. The file is now reported by its
 * size when it does not parse, never by its contents.
 */
function readTimeline(projectDir) {
    const { file, text } = readEngineFile(
        projectDir,
        "timing.json",
        "timing file",
    );
    if (text === null) throw new CliError(`timing file not found: ${file}`);
    let timing;
    try {
        timing = JSON.parse(text);
    } catch {
        throw new CliError(
            `${file} is not valid JSON (${text.length} characters) — refusing to cut chapters from it`,
            EXIT.FAILED,
        );
    }
    if (
        timing === null ||
        typeof timing !== "object" ||
        Array.isArray(timing)
    ) {
        throw new CliError(
            `timing.json holds ${describeValue(timing)}, not a timeline object`,
            EXIT.FAILED,
        );
    }
    const problems = timelineProblems(timing, projectDir);
    if (problems.length) throw new CliError(summarise(problems), EXIT.FAILED);
    return timing;
}

/**
 * Everything that would make the chapter markers wrong, as human-readable lines.
 *
 * Each marker is arithmetic on these fields, and arithmetic on a missing or unordered
 * value does not fail: it produces END=undefined, or a chapter that ends where it starts.
 * So every chapter window is proven positive here — a segment window that is positive and
 * follows the previous one makes each start strictly later than the last, and a duration
 * no shorter than the last segment closes the final chapter after it opens.
 *
 * A stage named as a remedy is asked first whether it would run on this project (see
 * silent-segment.mjs), which is why the project directory is passed.
 */
function timelineProblems(timing, projectDir) {
    const segs = timing.segments;
    if (!Array.isArray(segs) || !segs.length) {
        const what = Array.isArray(segs) ? "empty" : describeValue(segs);
        return [
            `timing.segments is ${what} — there is nothing to cut chapters from`,
        ];
    }
    const problems = [];
    let prev = null;
    let lastEndMs = null;
    let lastIndex = null; // the segment that ends last: what it holds decides which stage re-measures the duration
    segs.forEach((s, i) => {
        const where = segmentLabel(s, i);
        if (s === null || typeof s !== "object" || Array.isArray(s)) {
            problems.push(
                `${where} is ${describeValue(s)}, not a segment object`,
            );
            return;
        }
        const raw = rawTitleOf(s);
        if (typeof raw !== "string") {
            problems.push(
                raw
                    ? `${where}: its chapter title is ${describeValue(raw)}, not text`
                    : `${where} has no visual.title, title or id to name its chapter`,
            );
        }
        const unmeasured = ["startMs", "endMs"].filter((k) => !isMs(s[k]));
        for (const k of unmeasured) {
            // A declared silent window is authored, not measured: it is corrected by hand, and
            // re-voicing is never its repair.
            problems.push(
                isSilentSegment(s)
                    ? silentWindowFieldProblem({
                          dir: projectDir,
                          timing,
                          index: i,
                          field: k,
                          fields: unmeasured,
                          shown: describeValue(s[k]),
                          labelOf: segmentLabel,
                      })
                    : `${where}: ${k} is ${describeValue(s[k])} — it must be a finite number of milliseconds, >= 0. ` +
                          narratedWindowFieldRemedy(
                              projectDir,
                              timing,
                              segmentLabel,
                          ),
            );
        }
        if (unmeasured.length) return;
        if (s.endMs <= s.startMs) {
            problems.push(
                `${where}: window is ${s.endMs - s.startMs}ms (${s.startMs} -> ${s.endMs}) — it must be positive`,
            );
            return;
        }
        if (prev && s.startMs < prev.endMs) {
            problems.push(
                `${where} starts at ${s.startMs} ms, before ${prev.where} ends at ${prev.endMs} ms — ` +
                    "segments must be in time order and must not overlap",
            );
        }
        prev = { where, endMs: s.endMs };
        if (lastEndMs === null || s.endMs >= lastEndMs) lastIndex = i;
        lastEndMs = Math.max(lastEndMs ?? 0, s.endMs);
    });

    const d = timing.durationMs;
    if (!isMs(d) || (lastEndMs !== null && d < lastEndMs)) {
        const floor =
            lastEndMs === null
                ? ""
                : `, no shorter than the last segment (which ends at ${lastEndMs} ms)`;
        // A measured duration short of the last window means some window changed after the
        // audio was measured. silent-segment.mjs decides which stage re-measures it — remix
        // for a silence edit, voice otherwise, each only where it would run — for
        // write-subtitles too, so the two agree.
        const remedy = !isMs(d)
            ? durationMeasureRemedy(
                  "It closes the last chapter",
                  projectDir,
                  timing,
                  segmentLabel,
              )
            : durationShortfallRemedy(
                  "It closes the last chapter",
                  projectDir,
                  timing,
                  lastIndex,
                  segmentLabel,
              );
        problems.push(
            `timing.durationMs is ${describeValue(d)} — it must be a finite number of milliseconds${floor}. ${remedy}`,
        );
    }
    return problems;
}

function printSupportNote() {
    console.log("");
    console.log(
        "  ⚠️  Chapter support is uneven. VLC, QuickTime and some desktop players honour",
    );
    console.log(
        "      these markers; HTML5 <video> and many corporate streaming portals IGNORE",
    );
    console.log(
        "      them entirely. If the destination is one of the latter, this file is",
    );
    console.log(
        "      identical to the input in every way the viewer can see.",
    );
    console.log(
        "      Run with --list for a chapter list to paste into the description, which",
    );
    console.log("      is the only form that works everywhere.");
}
