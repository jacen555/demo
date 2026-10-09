#!/usr/bin/env node
/**
 * probe-render-capability.mjs — what can THIS machine do, and which levers are worth pulling?
 *
 * Run before committing to a render target. Capability is measured or runtime-tested;
 * nothing is inferred from a capability list, because ffmpeg advertises encoders that were
 * compiled in regardless of whether the hardware exists.
 *
 * WHAT THIS IS NOT: a benchmark. It reports what the machine *is* and ranks the levers
 * worth pulling. The per-lever speedups quoted are REFERENCE measurements from another
 * machine and are labelled as such — they indicate which lever to reach for first, not
 * what it will be worth here. Measure the lever you pick.
 *
 * Usage:  node probe-render-capability.mjs [--ffmpeg <path>]
 */

import { execFileSync, execSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliError,
  guard,
  parseCli,
  pathExists,
  resolveWithinRoot,
} from "./cli-support.mjs";

const REFERENCE =
  "Azure VM · Xeon Platinum 8370C · 8 physical / 16 logical · 64 GB · no GPU";

const USAGE = `
probe-render-capability — report what this machine can do, and which levers are worth pulling.

  node probe-render-capability.mjs                      probe this machine
  node probe-render-capability.mjs --ffmpeg <path>      probe using a named ffmpeg

Options
  --ffmpeg <path>   ffmpeg to probe (default: ffmpeg-path.txt, else "ffmpeg" on PATH)
  --project <dir>   project root (default: current directory)
  --help            show this message

Capability is measured or runtime-tested; nothing is inferred from a capability list.
This is NOT a benchmark — the per-lever speedups quoted are reference measurements from
another machine, labelled as such.

Exit codes: 0 success · 2 bad usage`.trim();

// Argument parsing comes first. This used to scan argv with indexOf, which silently
// accepts any flag — so `--help` fell straight through, ffmpeg-path.txt was read, and the
// probes ran. An unknown flag was equally invisible.
//
// WHICH FFMPEG RUNS IS PART OF THE ANSWER, so selection is explicit and reported.
// `ffmpeg-path.txt` is read from the project root through the domain's path boundary
// rather than from the process cwd: the usage offers --project, and reading the config
// from somewhere else would probe a different binary from the one the caller selected.
// A path RECORDED IN THAT FILE is resolved against the project root too — moving the
// read without resolving its contents would leave the same cwd dependency one level
// down. A bare command name (no separator) stays a PATH lookup, which is what naming a
// command rather than a path means.
const { values, projectDir } = guard(() =>
  parseCli({ usage: USAGE, options: { ffmpeg: { type: "string" } } }),
);

// Typed on the command line, so taken as typed — a path you type is relative to where
// you typed it. Only the recorded config path follows the project root.
//
// An EMPTY --ffmpeg is refused rather than treated as absent: falling through to the
// config or to PATH would run a different binary than the caller asked for and then
// report success for it, which is the same lie as a verdict about a binary that never ran.
let FFMPEG = guard(() => {
  if (values.ffmpeg === undefined) return null;
  if (values.ffmpeg.trim() === "") {
    throw new CliError(
      "--ffmpeg was given an empty value; name an executable or omit the flag",
    );
  }
  return values.ffmpeg;
});
let ffmpegSource = FFMPEG ? "--ffmpeg" : null;

if (!FFMPEG) {
  const ffmpegPathFile = guard(() =>
    resolveWithinRoot(projectDir, "ffmpeg-path.txt", "ffmpeg-path.txt"),
  );
  // pathExists, not existsSync: a file that cannot be INSPECTED is not a file that is
  // absent, and treating the two alike would fall back to PATH without saying why.
  if (guard(() => pathExists(ffmpegPathFile, "ffmpeg-path.txt"))) {
    const recorded = fs.readFileSync(ffmpegPathFile, "utf8").trim();
    if (recorded) {
      FFMPEG = guard(() => resolveRecordedFfmpeg(recorded, projectDir));
      ffmpegSource = ffmpegPathFile;
    }
  }
}
FFMPEG ||= "ffmpeg";
ffmpegSource ??= "PATH";

/**
 * Turns the value recorded in `ffmpeg-path.txt` into the thing to execute.
 *
 *   absolute (incl. UNC)  used as written
 *   has a separator       resolved against the PROJECT ROOT, not the cwd
 *   bare command name     left alone for a PATH lookup — naming a command rather than a
 *                         path is deliberate, and resolving it would turn "use the ffmpeg
 *                         on PATH" into a demand for a file that is not there
 *
 * TWO PARTLY-QUALIFIED WINDOWS FORMS ARE REFUSED rather than guessed at, because each
 * resolves against state this tool does not control — the exact dependency that reading
 * the config from the project root exists to remove:
 *
 *   C:ffmpeg.exe        drive-relative: "in the current directory OF DRIVE C". Not
 *                       absolute, and carries no separator, so a three-branch rule files
 *                       it under "bare command" and hands a path to PATH lookup.
 *   \vendor\ffmpeg.exe  root-relative: `path.isAbsolute` reports TRUE for this on Windows
 *                       even though it names no drive, so it would be used as written and
 *                       silently follow the process's current drive.
 *
 * There is no honest value to resolve either to, so each is named and refused.
 */
function resolveRecordedFfmpeg(recorded, root) {
  const driveRelative = /^[A-Za-z]:(?![\\/])/.test(recorded);
  const rootRelative = /^[\\/](?![\\/])/.test(recorded);
  if (driveRelative || rootRelative) {
    throw new CliError(
      `ffmpeg-path.txt records "${recorded}", which is ` +
        `${driveRelative ? "drive-relative" : "root-relative"}: it resolves against the ` +
        `current ${driveRelative ? "directory of that drive" : "drive of this process"}, ` +
        "so it names no fixed file. Write a fully qualified path, a path relative to the " +
        "project root, or a bare command name.",
    );
  }
  if (path.isAbsolute(recorded) || !/[\\/]/.test(recorded)) return recorded;
  return path.resolve(root, recorded);
}

const ok = (s) => `  \u2713 ${s}`;
const no = (s) => `  \u2717 ${s}`;
const bullet = (s) => `    ${s}`;
const heading = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

// The heavy-frame worker cap is a constant in frame-capture.mjs. Read it rather than
// duplicating it — a second copy would silently lie the moment that file changed.
function readHeavyCap() {
  try {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "frame-capture.mjs",
      ),
      "utf8",
    );
    const m = /heavyFrames\s*\?\s*(\d+)\s*:/.exec(src);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ---- CPU / memory -------------------------------------------------------------------
heading("CPU and memory");
const cpus = os.cpus();
const logical = os.availableParallelism?.() ?? cpus.length;
const totalGB = +(os.totalmem() / 1024 ** 3).toFixed(1);
let physical = null;
try {
  physical =
    Number(
      execSync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"',
        { encoding: "utf8" },
      ).trim(),
    ) || null;
} catch {
  /* non-Windows or blocked — logical count still reported */
}

console.log(bullet(cpus[0]?.model?.trim() ?? "unknown CPU"));
console.log(
  bullet(
    `${physical ?? "?"} physical / ${logical} logical cores · ${totalGB} GB RAM`,
  ),
);

// ---- GPU presence -------------------------------------------------------------------
heading("Display adapters");
let adapters = [];
try {
  adapters = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  /* ignore */
}

const virtualOnly =
  adapters.length > 0 &&
  adapters.every((a) =>
    /hyper-v|remote display|basic display|virtual|vmware|virtualbox/i.test(a),
  );
adapters.forEach((a) => console.log(bullet(a)));
if (virtualOnly)
  console.log(no("All adapters are virtual — no GPU passthrough."));

// ---- Hardware encoders: TEST, do not trust the list ---------------------------------
heading("Hardware encoders (runtime-tested, not listed)");
// WHICH BINARY WAS PROBED IS PART OF THE REPORT. Every verdict below is a property of
// this executable, not of the machine in the abstract, and the selection has three
// possible sources — so naming it keeps the report honest and makes the --project
// contract observable rather than something a reader has to take on trust.
console.log(bullet(`ffmpeg: ${FFMPEG}   (from ${ffmpegSource})`));

// AN UNLAUNCHABLE BINARY IS NOT A CAPABILITY RESULT. Every encoder below is judged by
// running it, so if ffmpeg cannot be executed at all, all four probes fail the same way
// and the tool used to conclude "No hardware encode" and exit 0 — a verdict about a
// binary it never ran, which is precisely the inference this script exists to refuse
// ("capability is measured or runtime-tested; nothing is inferred").
//
// So the launch is established FIRST, and separately. A failure here is a missing
// prerequisite (exit 2), not a finding about the machine.
guard(() => {
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-version"], { stdio: "pipe" });
  } catch (err) {
    throw new CliError(
      `cannot run ffmpeg at "${FFMPEG}" (selected from ${ffmpegSource}): ` +
        `${err.code ?? err.message}. Every encoder verdict below would be a statement ` +
        "about a binary that never ran, so nothing is reported. Fix the path in " +
        "ffmpeg-path.txt, pass --ffmpeg, or put ffmpeg on PATH.",
    );
  }
});

const working = [];
for (const enc of ["h264_nvenc", "h264_qsv", "h264_amf", "h264_vaapi"]) {
  try {
    execFileSync(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=30:duration=1",
        "-c:v",
        enc,
        "-f",
        "null",
        "-",
      ],
      { stdio: "pipe" },
    );
    working.push(enc);
    console.log(ok(`${enc} — WORKS`));
  } catch (e) {
    const msg =
      String(e.stderr ?? e.message)
        .split(/\r?\n/)
        .find((l) => l.includes("[" + enc)) ?? "";
    console.log(
      no(
        `${enc} — unavailable${msg ? ": " + msg.replace(/\[.*?\]\s*/, "").trim() : ""}`,
      ),
    );
  }
}
console.log("");
if (!working.length) {
  console.log(
    bullet(
      "No hardware encode. S7 is CPU-bound — x264 preset and thread count",
    ),
  );
  console.log(bullet("are the only encode levers on this machine."));
} else {
  console.log(bullet(`Hardware encode available: ${working.join(", ")}`));
  console.log(
    bullet(
      "Expect a large S7 win, but verify quality at 1:1 before adopting —",
    ),
  );
  console.log(
    bullet("hardware encoders trade quality for speed at a given bitrate."),
  );
}

// ---- Recommendations ----------------------------------------------------------------
heading("Recommended levers, highest value first");
console.log(
  bullet(`(speedups below are REFERENCE figures from: ${REFERENCE})`),
);

const heavyCap = readHeavyCap();
const recs = [
  [
    "frameFormat: jpeg (q88)",
    "Reference: 13x faster than PNG at 4K (13.05 vs 1.00 fps) and ~1/13th the disk, with no " +
      "visible quality cost at 1:1. At high resolution this outranks resolution itself; below " +
      "1080p resolution still dominates.",
  ],
];

if (heavyCap && logical > heavyCap + 2) {
  recs.push([
    `the heavy-frame worker cap (frame-capture.mjs, currently ${heavyCap})`,
    `Workers are capped at ${heavyCap} above 1080p but use cores-1 below it; this machine has ` +
      `${logical} logical cores. On the reference machine 4K peaked at only 2.2-2.3 GB, far from OOM — ` +
      `BUT raising it there measured FLAT (9.77 / 9.87 / 9.53 fps at 6 / 10 / 14 workers), so something ` +
      `saturates before the core count does. Measure before changing it; do not assume headroom means speed.`,
  ]);
}

if (totalGB >= 32) {
  recs.push([
    "RAM disk for the frame store",
    `${totalGB} GB available. A 4K JPEG frame set ran ~1.25 GB for a 4-minute video on the reference ` +
      "machine, so it fits in memory with room to spare and removes disk I/O from capture and encode. " +
      "UNMEASURED — proposed, not verified. Only worth it with real headroom.",
  ]);
}

if (!working.length) {
  recs.push([
    "x264 preset / thread count",
    "Encode is CPU-bound here. -preset faster/veryfast trades file size for wall-clock, and x264 " +
      "threads scale well across cores. UNMEASURED on this pipeline.",
  ]);
}

recs.push([
  "draft renders at render.preview",
  "Reference: ~8x cheaper (5.5 min vs 42.4 min for S5-S7 at half scale / half fps) — NOT the 2x that " +
    '"halving resolution halves render time" implies. On the reference project the draft caught three ' +
    "authoring defects that would each have cost a full cycle.",
]);

recs.forEach(([t, why], i) => {
  console.log(`\n  ${i + 1}. ${t}`);
  console.log(`     ${why}`);
});

// ---- Things that do NOT help --------------------------------------------------------
heading("Known non-levers");
console.log(
  bullet(
    "Dedup, on animated content. ~0% hold in the body of an animated render — a live",
  ),
);
console.log(
  bullet(
    "CSS background animation trips the motion guard, so body frames never hold.",
  ),
);
console.log(bullet(""));
console.log(
  bullet(
    "Byte-identical frames are NOT deduped frames. A deterministic renderer produces",
  ),
);
console.log(
  bullet(
    "identical bytes at FULL cost. The only true measure is the NTFS hardlink count:",
  ),
);
console.log(
  bullet("`fsutil hardlink list <frame>` — >1 path means genuinely held."),
);
if (virtualOnly) {
  console.log(bullet(""));
  console.log(
    bullet(
      "Headless-Chrome GPU flags. Without a GPU, Chrome is on SwiftShader —",
    ),
  );
  console.log(
    bullet(
      "software rasterisation on the same CPU cores. The flags change nothing.",
    ),
  );
}
console.log("");
