// --------------------------------------------------------------------------------------
// EVERY CLI MUST HANDLE --help BEFORE IT DOES ANY WORK.
//
// The README claimed "--help is handled before any file is touched, on every script". It
// was not. Four files died with an unhandled exception instead — and `silence-scan.mjs`
// LAUNCHED A HEADLESS CHROMIUM at module scope before it read anything, so asking it for
// help cost a browser launch and then a stack trace. A fifth, `probe-render-capability`,
// read `ffmpeg-path.txt` and ran its probes while ignoring the flag entirely.
//
// THE GAP THAT HID IT: `--help` was asserted only on the WRITING STAGES, by name. Every
// file nobody thought to list was unguarded. Adding five more named assertions would have
// rebuilt the same gap one size larger, so this file does not name any script. It
// ENUMERATES `src/` at run time and applies a rule to whatever it finds, which means a
// script added next year is covered without anyone remembering this file exists.
//
// THE CLASSIFIER IS A DECLARED EXEMPTION SET, AND THE DIRECTION MATTERS. Eight files in
// `src/` are side-effect-free modules — imported, never invoked — and giving them a CLI
// would manufacture uniformity over a real distinction. They are named in
// SIDE_EFFECT_FREE_MODULES below, and everything NOT named is an entry point.
//
// That direction is the whole point. The defect came from listing the SUBJECTS, so every
// file nobody listed went unguarded. Listing the EXEMPTIONS inverts the default: a script
// added later is covered whether or not anyone remembers this file, and removing one from
// coverage takes a deliberate, reviewable edit here.
//
// Inferring the split from behaviour was tried and abandoned. Running a file with a flag
// no script accepts separates "did nothing" from "reacted" for every file in `src/` today
// — but a CLI that silently does its work looks identical to a module, and requiring an
// export does not save it, since a file can both export something and run work on import.
// There is no observation of the guarded behaviour that establishes membership
// independently of it. So membership is DECLARED, and then re-checked: every exempted
// file must still exist, still do nothing when run, and still export something, or its
// exemption fails. No textual rule works either — a shebang, a `process.argv` reference
// and a `parseCli` import were each measured against the real split and each
// misclassifies (`cli-support.mjs` itself uses `parseCli`; `check-levels.mjs` and
// `frame-capture.mjs` reference neither).
//
// A SWEEP THAT FINDS NOTHING LOOKS EXACTLY LIKE A SWEEP WHERE EVERYTHING PASSES, so the
// counts are asserted before the rule is: if enumeration breaks, or every file ends up
// exempted, that fails here rather than quietly reporting green.
// --------------------------------------------------------------------------------------
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT } from '../src/cli-support.mjs';
import { silentMp3 } from '../src/silent-segment.mjs';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A flag no script in this engine accepts, used to ask "do you parse arguments at all?". */
const UNKNOWN_FLAG = '--sizzlecraft-no-such-flag';

/**
 * THE EXEMPTION SET, ENUMERATED ON PURPOSE — and this is the opposite of the mistake
 * that caused the defect.
 *
 * What went wrong before was a list of SUBJECTS: `--help` was asserted on the writing
 * stages by name, so every file nobody thought to list was unguarded, and five of them
 * were broken for as long as the list existed.
 *
 * Listing the EXEMPTIONS inverts that default. Anything not named here is covered, so a
 * script added next year is checked whether or not anyone remembers this file. Adding a
 * CLI cannot quietly escape; removing one from coverage takes a deliberate edit here,
 * which is reviewable.
 *
 * It also closes a hole a behavioural classifier cannot. Inferring "not a CLI" from
 * "did nothing when run" means a CLI that silently does its work looks exempt — and
 * requiring an export does not save it, because a file can both export something and run
 * work on import. There is no observation of the guarded behaviour that establishes
 * membership independently of it, so membership is declared and then checked.
 *
 * These eight are side-effect-free modules: imported, never invoked. Giving them a CLI
 * would manufacture uniformity over a real distinction.
 */
const SIDE_EFFECT_FREE_MODULES = new Set([
  'astats-levels.mjs',
  'cli-support.mjs',
  'end-card.mjs',
  'envelope-ducking.mjs',
  'gain-pin.mjs',
  'mix-parameters.mjs',
  'remux-verify.mjs',
  'silent-segment.mjs',
]);

/**
 * The enumeration floor exists so a broken sweep fails loudly rather than passing
 * vacuously. It is deliberately well below the real figure (34 files when this was
 * written) so adding or removing a script does not fail this file for no reason — it
 * catches collapse, not drift.
 */
const MIN_FILES = 25;

function runIn(file, args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-help-'));
  try {
    const r = spawnSync(process.execPath, [path.join(SRC_DIR, file), ...args], {
      cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env },
    });
    return {
      code: r.status,
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
      created: fs.readdirSync(dir),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** How many bindings a file exports, counted in a child so any side effect stays there. */
function exportCount(file) {
  const url = pathToFileURL(path.join(SRC_DIR, file)).href;
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e',
     `import(${JSON.stringify(url)}).then((m) => console.log(Object.keys(m).length))`],
    { cwd: os.tmpdir(), encoding: 'utf8', timeout: 120000 },
  );
  return Number.parseInt(`${r.stdout ?? ''}`.trim(), 10);
}

const sourceFiles = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.mjs')).sort();
const entryPoints = sourceFiles.filter((f) => !SIDE_EFFECT_FREE_MODULES.has(f));

describe('every CLI handles --help before it does any work', () => {
  // THE CONTROL FOR EVERY ZERO BELOW. Asserted first and separately: a rule applied to an
  // empty list passes vacuously, and would read as "all scripts comply".
  test('cliHelpSweep_enumeratesSrcAtRunTime_ratherThanAssertingOverAHardCodedList', () => {
    assert.ok(
      sourceFiles.length >= MIN_FILES,
      `the sweep found only ${sourceFiles.length} file(s) under ${SRC_DIR} — enumeration is ` +
      'broken, and a rule applied to nothing passes without testing anything',
    );
    assert.ok(
      entryPoints.length > 0,
      'every file was exempted, so the rule below is applied to nothing',
    );
  });

  // THE EXEMPTION LIST IS ITSELF CHECKED, so it cannot rot into a way of hiding a CLI.
  // A name here must still be a real module: silent when run, and exporting something.
  // Turn one into an entry point and this fails rather than silently dropping it from
  // coverage — which is the failure mode a declared list would otherwise introduce.
  test('cliHelpSweep_everyExemptedFile_isStillASideEffectFreeModule', () => {
    const stale = [...SIDE_EFFECT_FREE_MODULES].filter((f) => !sourceFiles.includes(f));
    assert.deepEqual(stale, [], `exempted files that no longer exist: ${stale.join(', ')}`);

    const notModules = [...SIDE_EFFECT_FREE_MODULES].map((file) => {
      const probe = runIn(file, [UNKNOWN_FLAG]);
      return {
        file,
        ranWork: !(probe.code === EXIT.OK && probe.out === '' && probe.created.length === 0),
        exports: exportCount(file),
      };
    }).filter((e) => e.ranWork || !(e.exports > 0));

    assert.deepEqual(
      notModules, [],
      'these are exempted from the --help rule as side-effect-free modules, but they ' +
      'either did work when run or export nothing — an exemption must keep earning ' +
      `itself: ${JSON.stringify(notModules)}`,
    );
  });

  for (const file of entryPoints) {
    const stem = file.replace(/\.mjs$/, '');

    // An entry point that does not parse its arguments cannot refuse a bad one, and a
    // script that cannot refuse `--sizzlecraft-no-such-flag` did not read `--help` either.
    test(`${stem}_givenAFlagItDoesNotAccept_refusesAsUsageRatherThanWorking`, () => {
      const r = runIn(file, [UNKNOWN_FLAG]);
      assert.equal(
        r.code, EXIT.USAGE,
        `${file} must reject an unknown flag with EXIT.USAGE, got ${r.code}:\n${r.out}`,
      );
    });

    test(`${stem}_givenHelp_printsItsOwnUsageAndWritesNothing`, () => {
      const r = runIn(file, ['--help']);
      assert.equal(r.code, EXIT.OK, `${file} --help must exit OK, got ${r.code}:\n${r.out}`);
      // Naming itself is what separates a usage block from a script that ignored the flag
      // and printed the output of its actual work — which is how probe-render-capability
      // passed an exit-code-only check while never looking at argv.
      assert.ok(
        r.out.includes(stem),
        `${file} --help must print usage naming the script, got:\n${r.out.slice(0, 400)}`,
      );
      assert.deepEqual(
        r.created, [],
        `${file} --help must not create files, created: ${r.created.join(', ')}`,
      );
    });
  }

  // WHAT THE SWEEP ABOVE CANNOT SEE.
  //
  // It observes an exit code, the output, and files created in one directory. A script
  // that LAUNCHED A BROWSER and then printed usage would satisfy every one of those —
  // and a browser launch before help is the most expensive form of this defect, and the
  // one silence-scan actually had. Exit codes cannot detect it; timing could, but a
  // shared box makes a stopwatch a coin toss.
  //
  // So the launch is made to fail instead. With PLAYWRIGHT_BROWSERS_PATH pointing at a
  // directory that does not exist, chromium.launch() cannot succeed — so if `--help`
  // still exits OK with usage, no launch was attempted. The control is the same script
  // doing real work under the same environment: it MUST fail, or the variable proves
  // nothing and the zero above is an artefact.
  describe('silence-scan asks for no browser before it has read its arguments', () => {
    const NO_BROWSERS = { PLAYWRIGHT_BROWSERS_PATH: path.join(os.tmpdir(), 'sizzlecraft-no-browsers-here') };

    test('silenceScan_helpWithTheBrowserMadeUnavailable_stillPrintsUsage', () => {
      const r = runIn('silence-scan.mjs', ['--help'], NO_BROWSERS);
      assert.equal(
        r.code, EXIT.OK,
        `--help must not need a browser, got ${r.code}:\n${r.out.slice(0, 500)}`,
      );
      assert.ok(r.out.includes('silence-scan'), `expected usage, got:\n${r.out.slice(0, 400)}`);
    });

    // THE POSITIVE CONTROL. Without it the test above passes just as well on a machine
    // where the variable is ignored, which would make it a check of nothing.
    //
    // It uses VALID audio, generated by this engine, and asserts the launch diagnostic
    // specifically. An earlier version wrote 288 zero bytes and asserted only a non-zero
    // exit — which a successful launch followed by a decode failure satisfies just as
    // well, so it would have reported the variable as biting whether or not it did.
    test('silenceScan_realWorkWithTheBrowserMadeUnavailable_failsAtTheLaunch_provingTheProbeBites', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-help-ctl-'));
      try {
        fs.writeFileSync(path.join(dir, 'voiceover.mp3'), silentMp3(1000));
        const r = spawnSync(process.execPath, [path.join(SRC_DIR, 'silence-scan.mjs')], {
          cwd: dir, encoding: 'utf8', timeout: 120000,
          env: { ...process.env, ...NO_BROWSERS },
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert.notEqual(r.status, EXIT.OK, `a real scan must fail here, got ${r.status}:\n${out}`);
        assert.match(
          out, /browserType\.launch|Executable doesn't exist/,
          'the control must fail AT THE LAUNCH. Any other failure would mean the browser ' +
          'started and PLAYWRIGHT_BROWSERS_PATH proved nothing, leaving the --help result ' +
          `above unsupported. Got:\n${out.slice(0, 500)}`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ------------------------------------------------------------------------------------
  // WHICH PROJECT SUPPLIES ffmpeg-path.txt — the contract the sweep above cannot see.
  //
  // The sweep checks that this CLI answers --help and refuses an unknown flag. It says
  // nothing about WHERE the tool looks for its config, and that moved: `ffmpeg-path.txt`
  // used to be read from the process cwd while --help advertised --project, so the option
  // could name one root while the tool probed a binary chosen by another.
  //
  // Both directories are populated and the run happens from the DECOY as cwd, so "it
  // picked the right one" cannot be satisfied by accident — a cwd-relative read would
  // select the decoy, which shows up as a different reported path.
  // ------------------------------------------------------------------------------------
  describe('probe-render-capability reads ffmpeg-path.txt from --project, not the cwd', () => {
    /** The selected executable and where it came from, read apart so each is assertable. */
    function reportedFfmpeg({ chosenBody, decoyBody, args = [] }) {
      const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-chosen-'));
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-decoy-'));
      try {
        fs.writeFileSync(path.join(chosen, 'ffmpeg-path.txt'), chosenBody);
        fs.writeFileSync(path.join(decoy, 'ffmpeg-path.txt'), decoyBody);
        const r = spawnSync(
          process.execPath,
          [path.join(SRC_DIR, 'probe-render-capability.mjs'), '--project', chosen, ...args],
          { cwd: decoy, encoding: 'utf8', timeout: 180000 },
        );
        const line = `${r.stdout ?? ''}${r.stderr ?? ''}`
          .split('\n').map((l) => l.trim()).find((l) => l.startsWith('ffmpeg:')) ?? '';
        // The source annotation names the config file, whose path contains the temp
        // directory name — so asserting on the whole line would match the ROOT where the
        // question is about the VALUE. They are split apart here for that reason.
        const m = /^ffmpeg:\s*(.*?)\s*\(from\s*(.*)\)$/.exec(line);
        return { line, value: m?.[1] ?? '', source: m?.[2] ?? '' };
      } finally {
        for (const d of [chosen, decoy]) fs.rmSync(d, { recursive: true, force: true });
      }
    }

    test('probeRenderCapability_withTwoProjectsHoldingDifferentPaths_readsTheOneNamedByProject', () => {
      const { value, line } = reportedFfmpeg({
        chosenBody: 'C:\\chosen-root\\ffmpeg.exe',
        decoyBody: 'C:\\decoy-cwd\\ffmpeg.exe',
      });
      assert.match(value, /chosen-root/, `expected the --project copy, got: ${line}`);
      assert.doesNotMatch(value, /decoy-cwd/, `it read the cwd copy instead: ${line}`);
    });

    // A RECORDED RELATIVE PATH MUST FOLLOW THE PROJECT TOO. Moving only the file read
    // would leave the same cwd dependency one level down, in the path the file contains.
    test('probeRenderCapability_whereTheRecordedPathIsRelative_resolvesItAgainstTheProjectRoot', () => {
      const { value, line } = reportedFfmpeg({
        chosenBody: '.\\vendor\\ffmpeg.exe',
        decoyBody: 'C:\\decoy-cwd\\ffmpeg.exe',
      });
      assert.match(value, /probe-chosen-/, `expected it under the project root, got: ${line}`);
      assert.match(value, /vendor/, `expected the recorded path, got: ${line}`);
      assert.doesNotMatch(value, /probe-decoy-/, `resolved against the cwd: ${line}`);
    });

    // A BARE COMMAND NAME IS NOT A PATH and must stay a PATH lookup — resolving it
    // against the project root would turn "use the ffmpeg on PATH" into a demand for a
    // file that is not there.
    test('probeRenderCapability_whereTheRecordedValueIsABareCommand_leavesItForPathLookup', () => {
      const { value, line } = reportedFfmpeg({ chosenBody: 'ffmpeg', decoyBody: 'ffmpeg' });
      assert.equal(value, 'ffmpeg', `expected an unresolved bare command, got: ${line}`);
    });

    test('probeRenderCapability_givenTheFfmpegFlag_prefersItOverEitherProjectFile', () => {
      const { value, source, line } = reportedFfmpeg({
        chosenBody: 'C:\\chosen-root\\ffmpeg.exe',
        decoyBody: 'C:\\decoy-cwd\\ffmpeg.exe',
        args: ['--ffmpeg', 'C:\\explicit\\ffmpeg.exe'],
      });
      assert.match(value, /explicit/, `expected the flag to win, got: ${line}`);
      assert.equal(source, '--ffmpeg', `the source must say where it came from: ${line}`);
    });

    // ----------------------------------------------------------------------------------
    // A BINARY THAT NEVER RAN IS NOT A CAPABILITY RESULT.
    //
    // Every encoder verdict is produced by executing ffmpeg. If it cannot be executed at
    // all, all four probes fail identically and the tool used to print "No hardware
    // encode" and exit 0 — a confident statement about a binary it never launched, from
    // a script whose stated rule is that capability is measured and nothing is inferred.
    // ----------------------------------------------------------------------------------
    function probeWith(recorded, args = []) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-run-'));
      try {
        if (recorded !== null) fs.writeFileSync(path.join(dir, 'ffmpeg-path.txt'), recorded);
        const r = spawnSync(
          process.execPath,
          [path.join(SRC_DIR, 'probe-render-capability.mjs'), '--project', dir, ...args],
          { cwd: dir, encoding: 'utf8', timeout: 180000 },
        );
        return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    test('probeRenderCapability_whereTheSelectedFfmpegCannotRun_refusesInsteadOfReportingNoHardwareEncode', () => {
      const r = probeWith('C:\\definitely-not-here\\ffmpeg.exe');
      assert.equal(r.code, EXIT.USAGE, `expected a refused prerequisite, got ${r.code}`);
      assert.match(r.out, /cannot run ffmpeg/, `expected it to say so, got:\n${r.out.slice(-600)}`);
      assert.doesNotMatch(
        r.out, /No hardware encode/,
        'it must not reach a verdict about a binary that never ran',
      );
    });

    test('probeRenderCapability_whereTheRecordedPathIsDriveRelative_refusesRatherThanGuessing', () => {
      const r = probeWith('C:ffmpeg.exe');
      assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}`);
      assert.match(r.out, /drive-relative/, `expected the reason, got:\n${r.out.slice(-600)}`);
    });

    // `path.isAbsolute` reports TRUE for this on Windows despite it naming no drive, so
    // without an explicit branch it is used as written and follows the process's current
    // drive — the cwd dependency this resolution exists to remove, wearing a disguise.
    test('probeRenderCapability_whereTheRecordedPathIsRootRelative_refusesRatherThanFollowingTheCurrentDrive', () => {
      const r = probeWith('\\vendor\\ffmpeg.exe');
      assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}`);
      assert.match(r.out, /root-relative/, `expected the reason, got:\n${r.out.slice(-600)}`);
    });

    // An omitted option and an empty one are different things. Treating "" as absent
    // would quietly run the config's binary, or PATH's, and report success for it.
    test('probeRenderCapability_givenAnEmptyFfmpegValue_refusesRatherThanFallingBack', () => {
      const r = probeWith('ffmpeg', ['--ffmpeg', '']);
      assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}`);
      assert.match(r.out, /empty value/, `expected the reason, got:\n${r.out.slice(-600)}`);
    });

    // THE POSITIVE CONTROL for both refusals above. Without it they pass on any failure
    // at all, including one that would also break a correct setup — so a real, launchable
    // ffmpeg must still produce a report and exit OK.
    test('probeRenderCapability_withARealLaunchableFfmpeg_reportsAndExitsOk', (t) => {
      const real = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
      const exe = `${real.stdout ?? ''}`.split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (!exe) return t.skip('no ffmpeg on PATH to use as the positive control');

      const r = probeWith(exe);
      assert.equal(r.code, EXIT.OK, `a launchable ffmpeg must succeed, got ${r.code}:\n${r.out.slice(-600)}`);
      assert.match(r.out, /Hardware encoders/, 'it must actually report');
      assert.doesNotMatch(r.out, /cannot run ffmpeg/, 'it must not claim the binary is unrunnable');
    });
  });
});
