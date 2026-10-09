import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  CliError,
  runCli,
  parseCli,
  requireExistingFile,
  requireSafeFilename,
  resolveWithinRoot,
  resolveEngineOutput,
  planFooter,
  fingerprintBuffer,
} from "./cli-support.mjs";

const USAGE = `
coach-pack — collect the exact input set the video coach may read, and bind it with a hash
manifest the coach cites in its report.

  node coach-pack.mjs --pass 1            plan the pass-1 set (script only)
  node coach-pack.mjs --pass 2 --apply    write the pass-2 manifest (script, timing,
                                          storyboard, stills, audit transcript)

  --pass <1|2>      which review pass. Pass 1 is before TTS; pass 2 is before frame capture.
  --apply           actually write the manifest. Without it nothing is written.
  --replace         permit overwriting an existing manifest for this project.

Pass 2 REFUSES unless every still still matches the record preview.mjs wrote. A missing
record is a refusal too: "no record" must never be read as "nothing wrong".

Exit codes: 0 success/plan · 1 the input set could not be bound · 2 bad usage

  Chosen deliberately. A stale or absent record is a bad RESULT of a run that worked, not a
  caller's mistake, so it is 1 — with write-subtitles, validate-timing and write-chapters.
  remix's 2 is the outlier in this engine and is not a precedent for a new stage.
`;

// Written beside the rubric the coach reads, not into the project, because the coach is
// dispatched with a path under the tool. tools/SizzleCraft/.gitignore ignores exactly the
// pack subfolder and nothing else.
//
// THE BOUNDARY IS THE COACH FOLDER, NOT THE PACK FOLDER. Rooting it at `coach/pack` would
// guard the manifest's NAME while taking the pack root itself on trust: if `coach/pack`
// were a link out of the tool, the boundary would realpath onto the target and happily
// certify writes there. `coach/` is committed and holds the rubric, so it is the lowest
// point that is actually known-good.
const COACH_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "coach",
);
const REMEDY =
  "Re-run `node src/preview.mjs --apply --replace` in the project to take fresh stills and rebind them.";

// WHERE THE REGRESS STOPS, AND WHY. Every boundary root can itself be a link — `coach/`,
// then `tools/SizzleCraft/`, then the checkout — so "root it one level higher" never
// terminates. It stops here because `coach/` is a committed directory holding a tracked
// file (rubric.md): anyone who can replace it with a link in this working tree can equally
// replace src/coach-pack.mjs, at which point guarding the output path protects nothing,
// because the attacker owns the code doing the guarding.
//
// So the boundary root is checked directly rather than trusted, and the check is a cheap
// lstat that does not follow what it is inspecting. That closes the named gap without
// pretending to defend a tree whose own source is already untrusted.
function assertCoachDirIsReal() {
  let st;
  try {
    st = fs.lstatSync(COACH_DIR);
  } catch (err) {
    throw new CliError(
      `the coach folder ${COACH_DIR} could not be inspected (${err.code ?? err.message}) — refusing rather than assuming a boundary`,
    );
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new CliError(
      `the coach folder ${COACH_DIR} is a link or not a directory — refusing to publish a manifest through it`,
    );
  }
}

// §V — the manifest is quoted by an agent in a report read elsewhere, so nothing in it may
// carry this machine's layout. Redacts rather than refuses: a slide can legitimately
// display a path, and refusing the whole pack over rendered content would be hostile.
// Redaction is visible in the artifact, so a reader can tell something was removed.
//
// Applied to the SERIALISED transcript rather than walked value by value, so object KEYS
// are covered by the same pass — a path can be a key as easily as a value, and a walker
// that visits only values lets that one straight through.
//
// In JSON text a backslash arrives doubled, so both forms are matched. This is a
// best-effort redaction of the path shapes this tool can actually emit — drive letters,
// UNC shares, and the usual posix roots. It is NOT a general secret scanner and does not
// claim to be; the manifest's own file list is safe by construction, not by this.
const PATH_SHAPES =
  /(?:[A-Za-z]:(?:\\\\|[\\/])|\\\\\\\\[^\\/"]+|\/(?:home|Users|tmp|var|mnt|root)\/)[^"]*/g;
const scrubText = (text) => text.replace(PATH_SHAPES, "<path redacted>");

// Two projects can share a basename — `demo/` under two parents is ordinary — and the
// basename alone would quietly point both packs at ONE destination, so the second would
// overwrite the first and the coach would cite a manifest for the wrong video. The digest
// of the absolute path makes the identity collision-resistant; it is a hash, so the path
// it is derived from is not recoverable from the folder name.
function packIdentity(projectDir) {
  const safe =
    path.basename(projectDir).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const digest = crypto
    .createHash("sha256")
    .update(path.resolve(projectDir))
    .digest("hex")
    .slice(0, 12);
  return `${safe}-${digest}`;
}

await runCli(async () => {
  const { values, projectDir, apply, replace } = parseCli({
    usage: USAGE,
    options: { pass: { type: "string" } },
  });

  // The pass decides the input set, so an unreadable one cannot be defaulted — guessing
  // pass 1 would hand the coach a smaller set than asked for and look like success.
  if (values.pass !== "1" && values.pass !== "2") {
    throw new CliError(
      `--pass must be 1 or 2, not ${JSON.stringify(values.pass ?? null)}.`,
    );
  }
  const pass = Number(values.pass);

  const rel = (p) => path.relative(projectDir, p).split(path.sep).join("/");
  const collect = (name, label) => {
    const p = requireExistingFile(projectDir, name, label);
    return {
      ...fingerprintBuffer(fs.readFileSync(p), rel(p)),
      role: label,
    };
  };

  const files = [collect("script.md", "script")];
  let audit = null;

  if (pass === 2) {
    const recordPath = resolveWithinRoot(
      projectDir,
      "preview/preview-record.json",
      "preview record",
    );
    if (!fs.existsSync(recordPath)) {
      // ABSENCE IS A REFUSAL. Packing unbound stills would produce a manifest that is
      // cryptographically sound and semantically empty — it would prove the coach read some
      // bytes, while proving nothing about what those bytes show.
      console.error(
        `\nFAILED: no preview record at ${rel(recordPath)}, so the stills cannot be bound to the timing and scene they show.`,
      );
      console.error(`  ${REMEDY}`);
      return EXIT.FAILED;
    }
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));

    // THE RECORD IS A FILE ON DISK, SO IT IS UNTRUSTED INPUT (§V). Its filenames are
    // interpolated into read paths, and a record carrying `../../..` would read outside the
    // project. Every name it supplies is resolved through the project boundary before it
    // becomes a path.
    const named = (name, label) => {
      if (typeof name !== "string" || !name) {
        throw new CliError(
          `the preview record has no ${label} filename; it is malformed. ${REMEDY}`,
        );
      }
      return resolveWithinRoot(projectDir, name, `recorded ${label}`);
    };

    // AN EMPTY STILL SET WOULD SATISFY THE LOOP BELOW AND PUBLISH A PACK THAT CHECKED
    // NOTHING — the same "absence reads as success" this stage exists to refuse, one level
    // further in. A record that binds no stills is malformed, not clean.
    if (!Array.isArray(record.stills) || record.stills.length === 0) {
      console.error(
        `\nFAILED: the preview record at ${rel(recordPath)} binds no stills, so there is nothing to verify.`,
      );
      console.error(`  ${REMEDY}`);
      return EXIT.FAILED;
    }
    // Likewise an absent transcript. Defaulting it to "no issues" would publish a manifest
    // asserting a clean audit that was never performed.
    if (!record.audit || !Array.isArray(record.audit.issues)) {
      console.error(
        `\nFAILED: the preview record at ${rel(recordPath)} carries no audit transcript, so a clean audit cannot be claimed.`,
      );
      console.error(`  ${REMEDY}`);
      return EXIT.FAILED;
    }

    const bound = [
      {
        entry: record.timing,
        path: named(record.timing?.file, "timing"),
        label: "timing",
      },
      {
        entry: record.scene,
        path: named(record.scene?.file, "scene"),
        label: "scene",
      },
      // A STILL NAME IS A PLAIN FILENAME, NOT A PATH. Resolving `preview/${file}` against the
      // PROJECT root confines it to the project but not to `preview/`: `../script.md` stays
      // inside the project and would be accepted and labelled a still. The engine already has
      // the rule for a name that becomes a path component.
      ...record.stills.map((s) => ({
        entry: s,
        path: named(
          `preview/${requireSafeFilename(s?.file, "recorded still")}`,
          "still",
        ),
        label: "still",
      })),
    ];

    const stale = [];
    for (const { entry, path: p, label } of bound) {
      const name = rel(p);
      if (!fs.existsSync(p)) {
        stale.push(`${name} — named by the record but missing`);
        continue;
      }
      const now = fingerprintBuffer(fs.readFileSync(p), name);
      if (now.sha256 !== entry.sha256)
        stale.push(`${name} — changed since the stills were taken`);
      else files.push({ ...now, role: label });
    }

    if (stale.length) {
      console.error(
        `\nFAILED: ${stale.length} input(s) no longer match the preview record:`,
      );
      for (const s of stale) console.error(`  ${s}`);
      console.error(`  ${REMEDY}`);
      return EXIT.FAILED;
    }

    files.push(collect("storyboard.html", "storyboard"));

    // A NON-EMPTY STILL SET IS NOT A COMPLETE ONE. Every entry the record supplies is
    // verified, so a record listing two of three stills passes the loop above and publishes
    // a pass-2 manifest with a segment the coach never sees — and the coach then reports
    // nothing wrong about it, which is the silent zero this whole stage exists to refuse.
    // Completeness is a property of the SET, so no per-entry check can see it.
    //
    // preview --id can legitimately shoot a subset; that subset is fine for a preview and
    // NOT fine for a pass-2 pack. The remedy already prints the command that takes the full
    // set, because it passes no --id.
    const shot = new Set(
      record.stills.map((s) => path.basename(String(s.file), ".png")),
    );
    const verifiedTiming = JSON.parse(
      fs.readFileSync(path.join(projectDir, record.timing.file), "utf8"),
    );
    const expected = [...verifiedTiming.segments.map((s) => s.id), "endcard"];
    const unseen = expected.filter((id) => !shot.has(id));
    if (unseen.length) {
      console.error(
        `\nFAILED: the preview record covers ${shot.size} of ${expected.length} required stills.`,
      );
      console.error(`  never shot: ${unseen.join(", ")}`);
      console.error(
        `  A coach cannot report on a segment it was not shown. ${REMEDY}`,
      );
      return EXIT.FAILED;
    }

    // The transcript travels WITH the pack. A still bound to an audit that describes a
    // different slide is the worst artifact available: its hash would prove the wrong thing
    // was checked.
    //
    // It comes from the PAGE, so it is untrusted too, and it lands in an artifact an agent
    // quotes in a report read elsewhere. Its file paths are safe by construction; its own
    // keys and values are not, so they are scrubbed here (§V).
    audit = {
      issues: JSON.parse(scrubText(JSON.stringify(record.audit.issues))),
    };
  }

  // Nobody names the manifest, so a link planted at it is REFUSED rather than written
  // through, and an existing pack is not silently replaced — the same rule preview.mjs
  // applies to its record. Rooted at COACH_DIR, so a link at `pack/` is caught too.
  // Resolved BEFORE the plan branch so a plan reports the path an apply would really use.
  const packRelative = path.join(
    "pack",
    packIdentity(projectDir),
    "manifest.json",
  );
  assertCoachDirIsReal();
  const manifestPath = resolveEngineOutput(COACH_DIR, packRelative, {
    apply,
    replace,
    label: "coach manifest",
  });
  const shownPath = path
    .relative(process.cwd(), manifestPath)
    .split(path.sep)
    .join("/");

  if (!apply) {
    console.log(`plan: pack ${files.length} file(s) for coach pass ${pass}`);
    for (const f of files) console.log(`    ${f.file}`);
    console.log(`  manifest ${shownPath}`);
    planFooter();
    return EXIT.OK;
  }

  // §V — THE MANIFEST CARRIES NO LOCAL PATHS. The coach quotes it in a report that is read
  // elsewhere, so every path in it is project-relative. The project's own directory name is
  // the one thing that must not leak, and it is never written.
  const manifest = {
    pass,
    rubric: "tools/SizzleCraft/coach/rubric.md",
    files: files.map(({ file, bytes, sha256, role }) => ({
      file,
      bytes,
      sha256,
      role,
    })),
    ...(audit ? { audit } : {}),
  };

  // Only now. A plan that creates its output directory has written something while saying
  // it wrote nothing, and leaves a folder behind on a run the user asked to be a no-op.
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`packed ${files.length} file(s) for coach pass ${pass}`);
  console.log(`manifest ${shownPath}`);
  return EXIT.OK;
});
