// Path confinement.
//
// Round one resolved the root through the filesystem and then trusted a lexical prefix
// check on the candidate. That is not containment: a junction sitting INSIDE the root
// satisfies the string test while pointing anywhere on the volume, so
// `silence-gen --out link/out.mp3 --apply` wrote outside the project.
//
// libs/EvalEngine's PathBoundary exists because this repo has been here before. These
// tests pin the three rules it encodes: refuse on the text before any I/O, apply the
// boundary to every link target while it is still text, and fail closed when a segment
// cannot be inspected.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createBoundary,
  resolveWithinRoot,
  resolveOutput,
  resolveEngineOutput,
  resolveInternalArtifact,
  openExclusiveEngineFile,
  requireSafeFilename,
  CliError,
  EXIT,
} from "../src/cli-support.mjs";
import {
  makeProject,
  makeOutsideDir,
  runScript,
  tryMakeDirLink,
  tryMakeFileLink,
  assertCleanExit,
  MISSING_FFMPEG,
  timingFixture,
  wordedSegments,
  pcmWav,
} from "./_helpers.mjs";

const SENTINEL = "SENTINEL — MUST SURVIVE AN ENGINE-CHOSEN WRITE";

describe("path boundary", () => {
  test("resolve_nestedRelativePath_returnsAbsolutePathInsideRoot", (t) => {
    const root = makeProject(t);
    assert.equal(
      resolveWithinRoot(root, "frames/out.png"),
      path.join(fs.realpathSync.native(root), "frames", "out.png"),
    );
  });

  test("resolve_parentTraversal_refusedOnTextBeforeAnyIo", (t) => {
    const root = makeProject(t);
    assert.throws(
      () => resolveWithinRoot(root, "../evil.mp3"),
      (e) => e instanceof CliError && e.exitCode === EXIT.USAGE,
    );
  });

  test("resolve_siblingSharingRootPrefix_isRefused", (t) => {
    // `<root>-backup` starts with the root as a string but is not inside it.
    const root = makeProject(t);
    const sibling = `${path.basename(root)}-backup`;
    assert.throws(
      () => resolveWithinRoot(root, path.join("..", sibling, "x.mp3")),
      CliError,
    );
  });

  test("resolve_absolutePathOutsideRoot_isRefused", (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t);
    assert.throws(
      () => resolveWithinRoot(root, path.join(outside, "x.mp3")),
      CliError,
    );
  });

  test("resolve_rootItself_returnsRootMatchingPathBoundarySemantics", (t) => {
    // The boundary's job is containment, and the root is contained in itself. Refusing a
    // write TO the root belongs to resolveOutput, which is asserted below — keeping the
    // two concerns apart is what lets `resolveWithinRoot(root, 'frames')` work.
    const root = makeProject(t);
    assert.equal(resolveWithinRoot(root, "."), fs.realpathSync.native(root));
  });

  test("resolveOutput_targetIsAnExistingDirectory_isRefused", (t) => {
    const root = makeProject(t, { "frames/x.png": "f" });
    assert.throws(
      () =>
        resolveOutput(root, "frames", {
          apply: true,
          replace: true,
          label: "output",
        }),
      (e) => e instanceof CliError && /is a directory/.test(e.message),
    );
  });

  test("resolveOutput_planOverExistingFile_doesNotRefuse", (t) => {
    // A plan must be able to describe replacing an existing file; refusing during a plan
    // would make the safe default fail exactly when there is something to protect.
    const root = makeProject(t, { "out.mp3": "existing" });
    assert.doesNotThrow(() =>
      resolveOutput(root, "out.mp3", {
        apply: false,
        replace: false,
        label: "output",
      }),
    );
    assert.throws(
      () =>
        resolveOutput(root, "out.mp3", {
          apply: true,
          replace: false,
          label: "output",
        }),
      CliError,
    );
  });

  test("resolve_absentSegment_isKeptAsWrittenRatherThanRefused", (t) => {
    // A segment confirmed absent cannot be a link, so a not-yet-created output path
    // must resolve normally — otherwise nothing could ever be written.
    const root = makeProject(t);
    const resolved = resolveWithinRoot(root, "does/not/exist/yet.mp3");
    assert.ok(resolved.startsWith(fs.realpathSync.native(root)));
  });

  test("resolve_linkInsideRootPointingOutside_isRefused", (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { "victim.txt": "ORIGINAL" });
    const link = path.join(root, "escape");
    if (!tryMakeDirLink(link, outside))
      return t.skip("platform refused to create a directory link");

    assert.throws(
      () => resolveWithinRoot(root, "escape/victim.txt"),
      (e) =>
        e instanceof CliError && /outside the project root/i.test(e.message),
      "a junction inside the root that points out must not pass the lexical check",
    );
  });

  test("resolve_linkInsideRootPointingInside_isAllowed", (t) => {
    const root = makeProject(t, { "real/keep.txt": "ok" });
    const link = path.join(root, "alias");
    if (!tryMakeDirLink(link, path.join(root, "real")))
      return t.skip("platform refused to create a directory link");

    const resolved = resolveWithinRoot(root, "alias/keep.txt");
    assert.ok(resolved.startsWith(fs.realpathSync.native(root)));
  });

  test("resolve_danglingFinalLinkPointingOutside_isRefused", (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t);
    const missingTarget = path.join(outside, "not-created-yet");
    const link = path.join(root, "dangling");
    if (!tryMakeDirLink(link, missingTarget))
      return t.skip("platform refused to create a directory link");

    // The target does not exist, so inspecting it proves nothing. The target is judged
    // as text, which is enough to refuse it.
    assert.throws(() => resolveWithinRoot(root, "dangling/out.mp3"), CliError);
  });

  test("createBoundary_exposesCanonicalRoot", (t) => {
    const root = makeProject(t);
    assert.equal(createBoundary(root).root, fs.realpathSync.native(root));
  });
});

describe("filename validation", () => {
  test("requireSafeFilename_plainName_isAccepted", () => {
    assert.equal(
      requireSafeFilename("segment_001.mp3", "name"),
      "segment_001.mp3",
    );
  });

  test("requireSafeFilename_pathSeparatorOrTraversal_throws", () => {
    for (const hostile of [
      "../escape",
      "a/b",
      "a\\b",
      "..",
      ".",
      "",
      "x\u0000y",
    ]) {
      assert.throws(
        () => requireSafeFilename(hostile, "segment id"),
        CliError,
        `"${hostile}" must be refused`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Engine-chosen destinations.
//
// resolveOutput deliberately FOLLOWS an in-root link: the caller named that path, so
// following their own link inside their own project is what they asked for. None of the
// destinations below were named by the caller — the engine picked them — so a link at
// one of them redirects a write nobody requested. Same containment, different question,
// different answer.
// ---------------------------------------------------------------------------
describe("engine-chosen writes refuse links rather than following them", () => {
  test("resolveEngineOutput_inRootLink_isRefusedWhereResolveOutputFollowsIt", (t) => {
    // Pins the distinction itself, and the divergence that made the publish guard only
    // accidentally correct: resolveOutput returns the link's TARGET, while the rename it
    // guards replaces the link ENTRY. Guard and action were describing different files.
    const root = makeProject(t, { "real.mp4": "original" });
    const linkEntry = path.join(root, "demo.mp4");
    if (!tryMakeFileLink(linkEntry, path.join(root, "real.mp4")))
      return t.skip("platform refused to create a file link");

    const followed = resolveOutput(root, "demo.mp4", {
      apply: true,
      replace: true,
      label: "output",
    });
    assert.equal(
      followed,
      path.join(fs.realpathSync.native(root), "real.mp4"),
      "resolveOutput resolves the canonical target, not the entry a rename would replace",
    );

    assert.throws(
      () =>
        resolveEngineOutput(root, "demo.mp4", {
          apply: true,
          replace: true,
          label: "output MP4",
        }),
      (e) => e instanceof CliError && /link/i.test(e.message),
      "an engine-chosen output must refuse the link outright, so guard and action cannot diverge",
    );
  });

  test("resolveEngineOutput_returnsTheEntryTheActionWillReplace", (t) => {
    // The positive half: what the guard hands back is exactly the lexical entry the
    // rename operates on, so "guarded" and "written" are the same path by construction.
    const root = makeProject(t);
    assert.equal(
      resolveEngineOutput(root, "demo.mp4", {
        apply: true,
        replace: true,
        label: "output MP4",
      }),
      path.join(fs.realpathSync.native(root), "demo.mp4"),
    );
  });

  test("resolveEngineOutput_encoderPageIsLinkToOutsideVictim_refusesWithoutClobberingIt", (t) => {
    // copyFileSync FOLLOWS a destination link and overwrites what it points at, so the
    // refusal has to happen before the copy — there is no post-hoc recovery.
    const root = makeProject(t, { "encoder/placeholder.txt": "x" });
    const outside = makeOutsideDir(t, { "victim.html": SENTINEL });
    const victim = path.join(outside, "victim.html");
    if (
      !tryMakeFileLink(path.join(root, "encoder", "encoder-page.html"), victim)
    ) {
      return t.skip("platform refused to create a file link");
    }

    assert.throws(
      () =>
        resolveEngineOutput(root, path.join("encoder", "encoder-page.html"), {
          apply: true,
          replace: true,
          label: "encoder page",
        }),
      (e) => e instanceof CliError && /link/i.test(e.message),
    );
    assert.equal(
      fs.readFileSync(victim, "utf8"),
      SENTINEL,
      "the victim must not be clobbered through the link",
    );
  });

  test("resolveEngineOutput_muxerDestinationIsLinkToOutsideVictim_refusesWithoutClobberingIt", (t) => {
    const root = makeProject(t, { "encoder/placeholder.txt": "x" });
    const outside = makeOutsideDir(t, { "victim.js": SENTINEL });
    const victim = path.join(outside, "victim.js");
    if (!tryMakeFileLink(path.join(root, "encoder", "mp4-muxer.js"), victim)) {
      return t.skip("platform refused to create a file link");
    }

    assert.throws(
      () =>
        resolveEngineOutput(root, path.join("encoder", "mp4-muxer.js"), {
          apply: true,
          replace: true,
          label: "encoder muxer",
        }),
      (e) => e instanceof CliError && /link/i.test(e.message),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), SENTINEL);
  });

  test("resolveInternalArtifact_encoderDirIsJunctionOutsideRoot_isRefused", (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { "victim.txt": SENTINEL });
    if (!tryMakeDirLink(path.join(root, "encoder"), outside))
      return t.skip("platform refused to create a directory link");

    assert.throws(
      () => resolveInternalArtifact(root, "encoder", "encoder directory"),
      CliError,
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.txt"), "utf8"),
      SENTINEL,
    );
  });

  test("resolveEngineOutput_destinationUnderAnEscapingJunction_isRefused", (t) => {
    // The directory guard and the file guard are not redundant: with the directory guard
    // removed, every file installed into it still has to be refused on its own.
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { "victim.html": SENTINEL });
    if (!tryMakeDirLink(path.join(root, "encoder"), outside))
      return t.skip("platform refused to create a directory link");

    assert.throws(
      () =>
        resolveEngineOutput(root, path.join("encoder", "victim.html"), {
          apply: true,
          replace: true,
          label: "encoder page",
        }),
      (e) =>
        e instanceof CliError && /outside the project root/i.test(e.message),
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.html"), "utf8"),
      SENTINEL,
    );
  });
});

// ---------------------------------------------------------------------------
// The encode temp file.
//
// Resolving the path and THEN opening it with 'w+' leaves the decision and the action
// in two places: 'w+' follows a link and truncates whatever it points at, so anything
// planted between the check and the open wins. 'wx+' makes the refusal the open itself.
// ---------------------------------------------------------------------------
describe("engine temp files are created exclusively", () => {
  test("openExclusiveEngineFile_destinationAbsent_createsAndReturnsTheEntryItOpened", (t) => {
    const root = makeProject(t);
    const { fd, path: opened } = openExclusiveEngineFile(
      root,
      "demo.mp4.part-1",
      "encode temp file",
    );
    fs.closeSync(fd);

    assert.equal(
      opened,
      path.join(fs.realpathSync.native(root), "demo.mp4.part-1"),
    );
    assert.equal(
      fs.existsSync(opened),
      true,
      "the temp file must actually be created",
    );
  });

  test("openExclusiveEngineFile_destinationIsLinkToOutsideVictim_refusesWithoutTruncatingIt", (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { "victim.bin": SENTINEL });
    const victim = path.join(outside, "victim.bin");
    if (!tryMakeFileLink(path.join(root, "demo.mp4.part-1"), victim))
      return t.skip("platform refused to create a file link");

    assert.throws(
      () =>
        openExclusiveEngineFile(root, "demo.mp4.part-1", "encode temp file"),
      CliError,
    );
    assert.equal(
      fs.readFileSync(victim, "utf8"),
      SENTINEL,
      "'w+' would have truncated this to zero bytes",
    );
  });

  test("openExclusiveEngineFile_destinationAlreadyExists_refusesRatherThanTruncating", (t) => {
    const root = makeProject(t, { "demo.mp4.part-1": SENTINEL });

    assert.throws(
      () =>
        openExclusiveEngineFile(root, "demo.mp4.part-1", "encode temp file"),
      (e) => e instanceof CliError && /already exists/i.test(e.message),
    );
    assert.equal(
      fs.readFileSync(path.join(root, "demo.mp4.part-1"), "utf8"),
      SENTINEL,
    );
  });

  test("openExclusiveEngineFile_pathEscapingRoot_isRefused", (t) => {
    const root = makeProject(t);
    assert.throws(
      () => openExclusiveEngineFile(root, "../escape.part", "encode temp file"),
      CliError,
    );
  });

  test("cleanup_successfulRemoval_reportsNoFailure", (t) => {
    const root = makeProject(t);
    const handle = openExclusiveEngineFile(
      root,
      "demo.mp4.part-1",
      "encode temp file",
    );

    assert.equal(
      handle.cleanup(),
      null,
      "a removal that worked has nothing to report",
    );
    assert.equal(fs.existsSync(handle.path), false);
  });

  test("cleanup_calledTwice_isIdempotentAndStillReportsNothing", (t) => {
    const root = makeProject(t);
    const handle = openExclusiveEngineFile(
      root,
      "demo.mp4.part-1",
      "encode temp file",
    );

    assert.equal(handle.cleanup(), null);
    assert.equal(
      handle.cleanup(),
      null,
      "the second call must not invent a failure",
    );
  });

  test("cleanup_removalFails_reportsTheLeftoverInsteadOfSwallowingIt", (t) => {
    // The guarantee "no partial is left behind" was reported as honoured whether or not the
    // removal succeeded, so a failed encode could leave an unreported .part-* artifact.
    // A non-empty directory at the path makes rmSync fail deterministically.
    const root = makeProject(t);
    const handle = openExclusiveEngineFile(
      root,
      "demo.mp4.part-1",
      "encode temp file",
    );
    fs.closeSync(handle.fd);
    fs.rmSync(handle.path);
    fs.mkdirSync(handle.path);
    fs.writeFileSync(path.join(handle.path, "blocker"), "x");

    const failure = handle.cleanup();

    assert.notEqual(
      failure,
      null,
      "a removal that failed must be reported, not swallowed",
    );
    assert.equal(
      failure.path,
      handle.path,
      "and must name the artifact left behind",
    );
    assert.match(
      failure.message,
      /demo\.mp4\.part-1/,
      "the message must be printable as-is",
    );
    assert.match(
      failure.message,
      /by hand|manually|remove/i,
      "and must say what the operator has to do",
    );
  });
});

describe("path confinement reaches the CLI", () => {
  test("silenceGen_outThroughLinkEscapingRoot_writesNothingOutside", (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t);
    const link = path.join(root, "escape");
    if (!tryMakeDirLink(link, outside))
      return t.skip("platform refused to create a directory link");

    const r = runScript(
      "silence-gen.mjs",
      ["--out", "escape/out.mp3", "--ms", "480", "--apply", "--replace"],
      root,
    );

    assert.equal(
      r.code,
      EXIT.USAGE,
      `expected a refusal, got ${r.code}\n${r.all}`,
    );
    assert.equal(
      fs.existsSync(path.join(outside, "out.mp3")),
      false,
      "must never write outside the project root",
    );
  });

  // remux-music's gain lock is ENGINE-CHOSEN: the caller names --music and --out, never
  // `music-gain.lock.json`. The engine picks that name on its own initiative, so an
  // in-root link at it redirects a write the caller never asked for — which is exactly
  // the distinction resolveInternalArtifact draws and resolveOutput deliberately does not.
  //
  // The bed is decodable because --apply probes it before it reaches the pin: whether it
  // loops decides whether the crossfade is in the pinned mix.
  const remuxProject = (t, files = {}) =>
    makeProject(t, {
      "ffmpeg-path.txt": MISSING_FFMPEG,
      "in.mp4": "video bytes",
      "voiceover.mp3": "voice bytes",
      "music.wav": pcmWav(10),
      ...files,
    });

  const runRemux = (dir, extra = []) =>
    runScript(
      "remux-music.mjs",
      [
        "--video",
        "in.mp4",
        "--voice",
        "voiceover.mp3",
        "--music",
        "music.wav",
        "--out",
        "out.mp4",
        ...extra,
      ],
      dir,
    );

  test("remuxMusic_gainLockIsLinkToOutsideVictim_refusesWithoutClobberingIt", (t) => {
    // A timeline, so the apply run can size the mix and reach the pin.
    const root = remuxProject(t, {
      "timing.json": JSON.stringify({
        project: { fps: 30 },
        durationMs: 4000,
      }),
    });
    const outside = makeOutsideDir(t, { "victim.json": "ORIGINAL VICTIM" });
    const link = path.join(root, "music-gain.lock.json");
    if (!tryMakeFileLink(link, path.join(outside, "victim.json"))) {
      return t.skip("platform refused to create a file link");
    }

    const r = runRemux(root, ["--apply", "--confirm-gain"]);

    assert.equal(
      r.code,
      EXIT.USAGE,
      `expected a refusal, got ${r.code}\n${r.all}`,
    );
    assert.match(r.all, /link/i, "the refusal must say the pin path is a link");
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.json"), "utf8"),
      "ORIGINAL VICTIM",
      "a link at an engine-chosen path must never be written through",
    );
  });

  // timing.json is read on the engine's own initiative too. An unconfined read through a
  // link put the first bytes of whatever it pointed at into the JSON parser's error,
  // which the PLAN then printed while exiting 0 — a read primitive with a report channel.
  test("remuxMusic_timingIsLinkToOutsideSecret_refusesWithoutDisclosingItsContents", (t) => {
    const root = remuxProject(t);
    const outside = makeOutsideDir(t, {
      "secret.txt": "SQUIRRELTOKEN-do-not-disclose",
    });
    const link = path.join(root, "timing.json");
    if (!tryMakeFileLink(link, path.join(outside, "secret.txt"))) {
      return t.skip("platform refused to create a file link");
    }

    const r = runRemux(root);

    assert.doesNotMatch(
      r.all,
      /SQUIRRELTOKEN/,
      "the contents of a refused read must never reach the output",
    );
    assert.equal(
      r.code,
      EXIT.USAGE,
      `a planted link must be refused, not planned around, got ${r.code}\n${r.all}`,
    );
    assert.match(r.all, /link/i, "and the refusal must say why");
  });
});

// ---------------------------------------------------------------------------
// S10 / S11. write-subtitles joined its sidecar names onto the project directory and wrote
// them with writeFileSync, which follows a link wherever it points: `--apply --replace`
// over a demo.vtt linked outside the project overwrote the link's target. write-chapters
// confined nothing at all — not --output, not --input, not its own chapters.ffmeta.
//
// The sidecars, the embed output and chapters.ffmeta are ENGINE-CHOSEN names, so a link at
// any of them is refused outright, in-root or not. --output is CALLER-named, so it gets the
// boundary rule instead: following the caller's own in-root link is what they asked for,
// and an escaping one is refused.
// ---------------------------------------------------------------------------
describe("write-subtitles and write-chapters confine every path they touch", () => {
  const VICTIM = "ORIGINAL VICTIM";
  // The distinctive part leads, because a JSON parse error quotes only the first 10 bytes.
  const SECRET = "SQUIRRELTOKEN-do-not-disclose";
  const worded = timingFixture(wordedSegments);
  const subtitleProject = (t, files = {}) =>
    makeProject(t, { "timing.json": worded, ...files });
  const chaptersProject = (t, files = {}) =>
    makeProject(t, {
      "timing.json": worded,
      "demo-with-music.mp4": "video bytes",
      "ffmpeg-path.txt": MISSING_FFMPEG,
      ...files,
    });

  for (const [kind, sidecar, other] of [
    ["vtt", "demo.vtt", "demo.srt"],
    ["srt", "demo.srt", "demo.vtt"],
  ]) {
    test(`writeSubtitles_${kind}SidecarIsLinkToOutsideVictim_refusesWithoutClobberingIt`, (t) => {
      const root = subtitleProject(t);
      const outside = makeOutsideDir(t, { victim: VICTIM });
      if (
        !tryMakeFileLink(path.join(root, sidecar), path.join(outside, "victim"))
      ) {
        return t.skip("platform refused to create a file link");
      }

      const r = runScript(
        "write-subtitles.mjs",
        ["--apply", "--replace"],
        root,
      );

      assert.equal(
        r.code,
        EXIT.USAGE,
        `a planted link must be refused, got ${r.code}\n${r.all}`,
      );
      assert.match(
        r.all,
        /link/i,
        "the refusal must say the sidecar is a link",
      );
      assert.equal(
        fs.readFileSync(path.join(outside, "victim"), "utf8"),
        VICTIM,
        "a sidecar link must never be written through",
      );
      assert.equal(
        fs.existsSync(path.join(root, other)),
        false,
        "the refusal must come before either sidecar is written",
      );
    });
  }

  test("writeSubtitles_sidecarIsInRootLink_isRefusedBecauseTheEngineChoseTheName", (t) => {
    const root = subtitleProject(t, { "approved.srt": VICTIM });
    if (
      !tryMakeFileLink(
        path.join(root, "demo.srt"),
        path.join(root, "approved.srt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-subtitles.mjs", ["--apply", "--replace"], root);

    assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
    assert.match(r.all, /link/i);
    assert.equal(
      fs.readFileSync(path.join(root, "approved.srt"), "utf8"),
      VICTIM,
      "the caller never named approved.srt",
    );
  });

  test("writeSubtitles_embedOutputIsLinkToOutsideVictim_refusesBeforeWritingAnything", (t) => {
    const root = subtitleProject(t, {
      "demo-with-music.mp4": "video bytes",
      "ffmpeg-path.txt": MISSING_FFMPEG,
    });
    const outside = makeOutsideDir(t, { "victim.mp4": VICTIM });
    if (
      !tryMakeFileLink(
        path.join(root, "demo-with-music-subtitled.mp4"),
        path.join(outside, "victim.mp4"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript(
      "write-subtitles.mjs",
      ["--embed", "--apply", "--replace"],
      root,
    );

    // ffmpeg is missing here, so the victim would survive even an unguarded run. What
    // carries the weight is the refusal itself, and that nothing was written before it.
    assert.equal(
      r.code,
      EXIT.USAGE,
      `the embed output must be refused, not handed to ffmpeg -y, got ${r.code}\n${r.all}`,
    );
    assert.match(r.all, /link/i);
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.mp4"), "utf8"),
      VICTIM,
    );
    assert.equal(
      fs.existsSync(path.join(root, "demo.vtt")),
      false,
      "the refusal must come before the sidecars are written",
    );
  });

  test("writeSubtitles_embedSourceIsLinkEscapingRoot_isRefused", (t) => {
    const root = subtitleProject(t, { "ffmpeg-path.txt": MISSING_FFMPEG });
    const outside = makeOutsideDir(t, { "private.mp4": "outside video" });
    if (
      !tryMakeFileLink(
        path.join(root, "demo-with-music.mp4"),
        path.join(outside, "private.mp4"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-subtitles.mjs", ["--embed"], root);

    assert.equal(
      r.code,
      EXIT.USAGE,
      `a source outside the project must be refused, got ${r.code}\n${r.all}`,
    );
    assert.match(r.all, /outside the project root/i);
  });

  test("writeSubtitles_embedSourceAliasesTheEmbedOutput_isRefused", (t) => {
    // ffmpeg reading and writing one file destroys it. An in-root link is a legal source,
    // so the collision is only visible once both ends are resolved.
    const root = subtitleProject(t, {
      "ffmpeg-path.txt": MISSING_FFMPEG,
      "demo-with-music-subtitled.mp4": VICTIM,
    });
    if (
      !tryMakeFileLink(
        path.join(root, "demo-with-music.mp4"),
        path.join(root, "demo-with-music-subtitled.mp4"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript(
      "write-subtitles.mjs",
      ["--embed", "--apply", "--replace"],
      root,
    );

    assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
    assert.match(r.all, /both resolve to/);
    assert.equal(
      fs.readFileSync(path.join(root, "demo-with-music-subtitled.mp4"), "utf8"),
      VICTIM,
    );
    assert.equal(fs.existsSync(path.join(root, "demo.vtt")), false);
  });

  test("writeChapters_outputOutsideRoot_isRefusedBeforeAnyWrite", (t) => {
    const root = chaptersProject(t);
    const outside = makeOutsideDir(t);

    const r = runScript(
      "write-chapters.mjs",
      ["--output", path.join(outside, "out.mp4"), "--apply", "--replace"],
      root,
    );

    assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
    assert.match(r.all, /outside the project root/i);
    assert.equal(
      fs.existsSync(path.join(root, "chapters.ffmeta")),
      false,
      "nothing may be written before the refusal",
    );
  });

  test("writeChapters_outputThroughLinkEscapingRoot_writesNothingAnywhere", (t) => {
    const root = chaptersProject(t);
    const outside = makeOutsideDir(t);
    if (!tryMakeDirLink(path.join(root, "escape"), outside))
      return t.skip("platform refused to create a directory link");

    const r = runScript(
      "write-chapters.mjs",
      ["--output", "escape/out.mp4", "--apply", "--replace"],
      root,
    );

    assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
    assert.match(r.all, /outside the project root/i);
    assert.deepEqual(
      fs.readdirSync(outside),
      [],
      "must never write outside the project root",
    );
    assert.equal(
      fs.existsSync(path.join(root, "chapters.ffmeta")),
      false,
      "nothing may be written before the refusal",
    );
  });

  test("writeChapters_outputSameAsInput_isRefusedRatherThanRemuxedInPlace", (t) => {
    const root = chaptersProject(t);

    const r = runScript(
      "write-chapters.mjs",
      ["--output", "demo-with-music.mp4", "--apply", "--replace"],
      root,
    );

    assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
    assert.match(r.all, /both resolve to/);
    assert.equal(
      fs.readFileSync(path.join(root, "demo-with-music.mp4"), "utf8"),
      "video bytes",
    );
    assert.equal(fs.existsSync(path.join(root, "chapters.ffmeta")), false);
  });

  test("writeChapters_metadataIsLinkToOutsideVictim_refusesWithoutClobberingIt", (t) => {
    const root = chaptersProject(t);
    const outside = makeOutsideDir(t, { victim: VICTIM });
    if (
      !tryMakeFileLink(
        path.join(root, "chapters.ffmeta"),
        path.join(outside, "victim"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-chapters.mjs", ["--apply", "--replace"], root);

    assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
    assert.match(r.all, /link/i);
    assert.equal(
      fs.readFileSync(path.join(outside, "victim"), "utf8"),
      VICTIM,
      "the metadata link must never be written through",
    );
  });

  test("writeChapters_metadataIsInRootLink_isRefusedBecauseTheEngineChoseTheName", (t) => {
    const root = chaptersProject(t, { "notes.txt": VICTIM });
    if (
      !tryMakeFileLink(
        path.join(root, "chapters.ffmeta"),
        path.join(root, "notes.txt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-chapters.mjs", ["--apply", "--replace"], root);

    assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(root, "notes.txt"), "utf8"),
      VICTIM,
      "the caller never named notes.txt",
    );
  });

  test("writeChapters_inputOutsideRoot_isRefused", (t) => {
    const root = chaptersProject(t);
    const outside = makeOutsideDir(t, { "private.mp4": "outside video" });
    const input = path.relative(root, path.join(outside, "private.mp4"));

    const r = runScript("write-chapters.mjs", ["--input", input], root);

    assert.equal(
      r.code,
      EXIT.USAGE,
      `an input outside the project must be refused, got ${r.code}\n${r.all}`,
    );
    assert.match(r.all, /outside the project root/i);
    assert.equal(fs.existsSync(path.join(root, "chapters.ffmeta")), false);
  });

  // timing.json and ffmpeg-path.txt are read on the engine's own initiative, and each has a
  // report channel: a JSON parse error quotes the bytes it choked on, and the plan prints
  // the pointer in its "would run" line.
  for (const [method, script, args] of [
    ["writeChapters", "write-chapters.mjs", []],
    ["writeSubtitles", "write-subtitles.mjs", ["--embed"]],
  ]) {
    test(`${method}_timingIsLinkToOutsideSecret_refusesWithoutDisclosingIt`, (t) => {
      const root = makeProject(t, {
        "demo-with-music.mp4": "video bytes",
        "ffmpeg-path.txt": MISSING_FFMPEG,
      });
      const outside = makeOutsideDir(t, { "secret.txt": SECRET });
      if (
        !tryMakeFileLink(
          path.join(root, "timing.json"),
          path.join(outside, "secret.txt"),
        )
      ) {
        return t.skip("platform refused to create a file link");
      }

      const r = runScript(script, args, root);

      assert.doesNotMatch(
        r.all,
        /SQUIRREL/,
        "the contents of a refused read must never reach the output",
      );
      assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
      // Refused for being a link at all, not for where it leads: see the in-root cases below.
      assert.match(r.all, /timing file "timing\.json" is a link/);
    });

    test(`${method}_ffmpegPointerIsLinkToOutsideSecret_refusesWithoutDisclosingIt`, (t) => {
      const root = makeProject(t, {
        "timing.json": worded,
        "demo-with-music.mp4": "video bytes",
      });
      const outside = makeOutsideDir(t, { "secret.txt": SECRET });
      if (
        !tryMakeFileLink(
          path.join(root, "ffmpeg-path.txt"),
          path.join(outside, "secret.txt"),
        )
      ) {
        return t.skip("platform refused to create a file link");
      }

      const r = runScript(script, args, root);

      assert.doesNotMatch(
        r.all,
        /SQUIRREL/,
        "the contents of a refused read must never reach the output",
      );
      assert.equal(r.code, EXIT.USAGE, `got ${r.code}\n${r.all}`);
      assert.match(r.all, /ffmpeg pointer "ffmpeg-path\.txt" is a link/);
    });

    // An IN-ROOT link is the case the boundary rule cannot see: it is contained, so it was
    // followed. Neither name was chosen by the caller, so a link at either is not an
    // instruction to read something else — it is refused outright, wherever it points.
    test(`${method}_ffmpegPointerIsInRootLinkToSentinel_planRefusesWithoutPrintingIt`, (t) => {
      const root = makeProject(t, {
        "timing.json": worded,
        "demo-with-music.mp4": "video bytes",
        "notes.txt": SECRET,
      });
      if (
        !tryMakeFileLink(
          path.join(root, "ffmpeg-path.txt"),
          path.join(root, "notes.txt"),
        )
      ) {
        return t.skip("platform refused to create a file link");
      }

      const r = runScript(script, args, root);

      assert.doesNotMatch(
        r.all,
        /SQUIRREL/,
        `a plan must never print the file a pointer link leads to\n${r.all}`,
      );
      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, /ffmpeg pointer "ffmpeg-path\.txt" is a link/);
    });

    test(`${method}_timingIsInRootLinkToSentinel_refusesWithoutDisclosingIt`, (t) => {
      const root = makeProject(t, {
        "demo-with-music.mp4": "video bytes",
        "ffmpeg-path.txt": MISSING_FFMPEG,
        "notes.txt": SECRET,
      });
      if (
        !tryMakeFileLink(
          path.join(root, "timing.json"),
          path.join(root, "notes.txt"),
        )
      ) {
        return t.skip("platform refused to create a file link");
      }

      const r = runScript(script, args, root);

      assert.doesNotMatch(
        r.all,
        /SQUIRREL/,
        `the file a timing link leads to must never reach the output\n${r.all}`,
      );
      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, /timing file "timing\.json" is a link/);
    });

    test(`${method}_timingIsInRootLinkToAnotherTimeline_isRefusedRatherThanFollowed`, (t) => {
      // The target parses cleanly, so no parse error gives it away: followed, the run
      // simply describes a project nobody pointed it at.
      const other = timingFixture(wordedSegments, {
        project: { name: "SQUIRRELTOKEN" },
      });
      const root = makeProject(t, {
        "other.json": other,
        "demo-with-music.mp4": "video bytes",
        "SQUIRRELTOKEN-with-music.mp4": "video bytes",
        "ffmpeg-path.txt": MISSING_FFMPEG,
      });
      if (
        !tryMakeFileLink(
          path.join(root, "timing.json"),
          path.join(root, "other.json"),
        )
      ) {
        return t.skip("platform refused to create a file link");
      }

      const r = runScript(script, args, root);

      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, /timing file "timing\.json" is a link/);
      assert.doesNotMatch(
        r.all,
        /SQUIRREL/,
        `the linked timeline must not have been read\n${r.all}`,
      );
    });

    test(`${method}_timingIsNotJson_refusesWithoutEchoingIt`, (t) => {
      // A JSON parse error quotes the bytes it choked on. The file here is the project's
      // own, but the message is the same code path that would print any file's opening.
      const root = makeProject(t, {
        "timing.json": SECRET,
        "demo-with-music.mp4": "video bytes",
        "ffmpeg-path.txt": MISSING_FFMPEG,
      });

      const r = runScript(script, args, root);

      assert.doesNotMatch(
        r.all,
        /SQUIRREL/,
        `a parse error must describe the file, not quote it\n${r.all}`,
      );
      assertCleanExit(r, EXIT.FAILED);
      assert.match(r.all, /timing\.json is not valid JSON \(\d+ characters\)/);
    });

    for (const [artifact, name] of [
      ["timing", "timing.json"],
      ["ffmpegPointer", "ffmpeg-path.txt"],
    ]) {
      test(`${method}_${artifact}IsDirectory_isRefusedCleanly`, (t) => {
        const files = {
          "timing.json": worded,
          "demo-with-music.mp4": "video bytes",
          "ffmpeg-path.txt": MISSING_FFMPEG,
        };
        delete files[name];
        const root = makeProject(t, files);
        fs.mkdirSync(path.join(root, name));

        const r = runScript(script, args, root);

        assertCleanExit(
          r,
          EXIT.USAGE,
          `a directory at ${name} must be refused, not read: `,
        );
        assert.match(
          r.all,
          new RegExp(`${name.replace(".", "\\.")} is not a regular file`),
        );
      });
    }
  }

  test("writeChapters_defaultOutputIsInRootLink_isRefusedBeforeMetadataIsWritten", (t) => {
    // The caller never named demo-with-music-chaptered.mp4 — the engine did — so a link
    // there is not an instruction to follow. Followed, --apply --replace rewrote
    // chapters.ffmeta and then handed ffmpeg -y the file the link pointed at.
    const root = chaptersProject(t, {
      "approved.mp4": VICTIM,
      "chapters.ffmeta": SENTINEL,
    });
    if (
      !tryMakeFileLink(
        path.join(root, "demo-with-music-chaptered.mp4"),
        path.join(root, "approved.mp4"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-chapters.mjs", ["--apply", "--replace"], root);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(
      r.all,
      /output video "demo-with-music-chaptered\.mp4" is a link/,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "approved.mp4"), "utf8"),
      VICTIM,
      "the caller never named approved.mp4",
    );
    assert.equal(
      fs.readFileSync(path.join(root, "chapters.ffmeta"), "utf8"),
      SENTINEL,
      "the refusal must come before the metadata is written",
    );
  });

  test("writeChapters_explicitOutputIsInRootLink_isFollowedBecauseTheCallerNamedIt", (t) => {
    // REGRESSION GUARD (passed before this change too) for the test above: the refusal is
    // for the name the engine chose. A caller's own --output keeps the boundary rule.
    const root = chaptersProject(t, { "approved.mp4": VICTIM });
    if (
      !tryMakeFileLink(
        path.join(root, "mine.mp4"),
        path.join(root, "approved.mp4"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-chapters.mjs", ["--output", "mine.mp4"], root);

    assertCleanExit(
      r,
      EXIT.OK,
      "a caller-named in-root link is theirs to follow: ",
    );
    assert.match(
      r.all,
      /output\s+\S*approved\.mp4/,
      `the plan must show where the caller's link leads\n${r.all}`,
    );
  });
});
