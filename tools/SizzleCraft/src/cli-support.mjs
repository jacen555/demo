/*
 * Shared CLI support for the SizzleCraft engine scripts.
 *
 * Every script here is judged against one property:
 *
 *   it must not do something irreversible without being asked,
 *   and it must not claim to have done something it did not.
 *
 * Both halves are load-bearing and neither implies the other. A script that
 * overwrites your storyboard on a bare invocation and then reports the failure
 * accurately has still overwritten your storyboard.
 *
 * This module owns the primitives that enforce both:
 *
 *   EXIT / CliError / runCli   the exit-code contract (README "Exit codes")
 *   parseCli                   argument parsing where --help cannot reach I/O
 *   createBoundary             path confinement that survives links
 *   parseBoundedNumber         numeric input that cannot reach a filter graph
 *
 * It is the only module here with no side effects on import, so it is directly
 * unit-testable; the CLI scripts themselves are exercised as subprocesses.
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const IS_WINDOWS = process.platform === 'win32';

/** Links followed before a path is declared unresolvable. */
const MAX_LINK_DEPTH = 40;

/**
 * Exit-code contract. Every script in this engine uses these and nothing else.
 * Documented in README.md — callers check them, so they are a public API.
 */
export const EXIT = Object.freeze({
  /** The work was asked for and completed — or a plan was produced successfully. */
  OK: 0,
  /** The work ran and the result is bad: a check failed, a hash mismatched, output is wrong. */
  FAILED: 1,
  /** The caller's fault: bad arguments, a path outside the project root, a missing prerequisite. */
  USAGE: 2,
  /** The work deliberately did NOT happen (another process holds the lock). Never report this as success. */
  SKIPPED: 3,
});

/** An error that knows which exit code it should produce. */
export class CliError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * Thrown by parseCli when --help is present.
 *
 * Help is an exception rather than a return value on purpose. A script that forgets to
 * check a returned `help` flag carries on into its work — and in this engine "its work"
 * has included appending to the user's voiceover. Unwinding the stack makes it
 * structurally impossible for --help to reach any I/O.
 */
export class HelpRequested extends Error {
  constructor(usage) {
    super('help requested');
    this.name = 'HelpRequested';
    this.usage = usage;
  }
}

/** Strips a trailing separator so `C:\a\` and `C:\a` compare equal, keeping filesystem roots intact. */
function trimTrailingSep(p) {
  if (p.length > 1 && p.endsWith(path.sep) && path.parse(p).root !== p) {
    return p.slice(0, -1);
  }
  return p;
}

/** Case-insensitive on Windows, exact elsewhere — matching how the filesystem compares. */
function samePath(a, b) {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Reports whether an already-absolute path lies at or beneath `root`.
 *
 * Compared with a trailing separator appended, because a bare prefix test accepts a
 * sibling whose name merely starts the same way — `C:\proj-backup` is not inside `C:\proj`.
 */
function contains(root, candidate) {
  const r = trimTrailingSep(root);
  const c = trimTrailingSep(candidate);
  if (samePath(r, c)) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return IS_WINDOWS ? c.toLowerCase().startsWith(prefix.toLowerCase()) : c.startsWith(prefix);
}

/**
 * Resolves `absPath` to what the filesystem will actually read from, applying the
 * boundary to every link target along the way.
 *
 * Three rules, ported from libs/EvalEngine's PathBoundary, none of them redundant:
 *
 *   1. Containment is checked on the TEXT before any I/O (by the caller, below), and
 *      again on the RESOLVED path afterwards. A lexical check answers "does this string
 *      start with the root", which a junction sitting inside the root satisfies while
 *      pointing anywhere on the volume. `../../x` is caught only by the first check; an
 *      in-root junction pointing out is caught only by the second.
 *   2. The boundary is applied per segment, to a link target while it is still text —
 *      before anything inspects it. Following an in-root link that names a UNC target
 *      would reach DNS and SMB; reading the link's own metadata and stopping does not.
 *   3. Inspection failure fails closed, and "unreadable" is not "absent". A segment
 *      confirmed absent cannot be a link, so the remainder is kept as written and an
 *      ordinary not-found follows. A segment that could not be inspected proves nothing.
 */
function realPathWithinBoundary(root, absPath, label) {
  let current = root;
  let segments = path.relative(root, absPath).split(path.sep).filter((s) => s && s !== '.');
  let depth = 0;
  let i = 0;

  while (i < segments.length) {
    const next = path.join(current, segments[i]);

    let st;
    try {
      // Rule 3: `throwIfNoEntry: false` distinguishes a confirmed-absent entry (undefined)
      // from one that exists but could not be inspected (throws). On Windows these are
      // otherwise easy to conflate, and conflating them is what lets an unverified
      // segment through.
      st = fs.lstatSync(next, { throwIfNoEntry: false });
    } catch (err) {
      throw new CliError(
        `${label}: could not inspect "${next}" (${err.code ?? err.message}) — refusing rather than assuming it stays inside the project root`,
      );
    }

    if (st === undefined) {
      // Confirmed absent: nothing further along can be a link.
      return path.join(next, ...segments.slice(i + 1));
    }

    if (st.isSymbolicLink()) {
      if (++depth > MAX_LINK_DEPTH) {
        throw new CliError(`${label}: "${absPath}" exceeds the maximum link depth (${MAX_LINK_DEPTH})`);
      }
      const targetAbs = trimTrailingSep(path.resolve(path.dirname(next), fs.readlinkSync(next)));

      // Rule 2: judge the target as text, before inspecting it.
      if (!contains(root, targetAbs)) {
        throw new CliError(
          `${label}: "${absPath}" passes through a link at "${next}" pointing outside the project root — refusing`,
        );
      }

      const rest = segments.slice(i + 1);
      segments = path.relative(root, targetAbs).split(path.sep).filter((s) => s && s !== '.').concat(rest);
      current = root;
      i = 0;
      continue;
    }

    current = next;
    i++;
  }
  return current;
}

/**
 * Creates a boundary confined to `rootDirectory`.
 *
 * The root is canonicalized once, without a boundary of its own — it is the path this
 * process chose, not one it was handed.
 */
export function createBoundary(rootDirectory) {
  const lexicalRoot = trimTrailingSep(path.resolve(rootDirectory));

  let entry;
  try {
    entry = fs.lstatSync(lexicalRoot, { throwIfNoEntry: false });
  } catch (err) {
    throw new CliError(
      `project root "${lexicalRoot}" could not be inspected (${err.code ?? err.message}) — refusing rather than assuming a boundary`,
    );
  }

  // An absent root is permitted: nothing can be inside it yet, so lexical containment is
  // the whole truth. Anything else must be established, not assumed — rule 3 applies to
  // the root as much as to the paths measured against it.
  if (entry === undefined) {
    return { root: lexicalRoot, resolve: (c, l = 'path') => resolveAgainst(lexicalRoot, c, l) };
  }

  let root;
  try {
    root = trimTrailingSep(fs.realpathSync.native(lexicalRoot));
  } catch (err) {
    throw new CliError(
      `project root "${lexicalRoot}" exists but could not be resolved (${err.code ?? err.message}) — ` +
        `refusing to fall back to a lexical boundary, which would not be containment`,
    );
  }

  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (err) {
    throw new CliError(`project root "${root}" could not be inspected (${err.code ?? err.message}) — refusing`);
  }
  if (!rootStat.isDirectory()) {
    throw new CliError(`project root "${lexicalRoot}" is not a directory — refusing`);
  }

  return {
    root,
    resolve: (candidate, label = 'path') => resolveAgainst(root, candidate, label),
  };
}

/**
 * Resolves a path that must be the real entry at that name — no link anywhere in the
 * chain, and nothing redirecting it.
 *
 * Containment answers "does this stay inside the project". It deliberately permits an
 * in-root link, which is correct for a user-supplied output. It is NOT correct for a
 * path the engine writes on its own initiative (its own metadata) or destroys
 * recursively: following an in-root link there clobbers whatever it points at, which the
 * caller never named.
 */
function resolveUnlinkedPath(boundary, candidate, label) {
  const lexical = trimTrailingSep(path.resolve(boundary.root, candidate));
  if (!contains(boundary.root, lexical)) {
    throw new CliError(`${label} "${candidate}" resolves outside the project root (${boundary.root}) — refusing`);
  }

  let st;
  try {
    st = fs.lstatSync(lexical, { throwIfNoEntry: false });
  } catch (err) {
    throw new CliError(`${label}: could not inspect "${lexical}" (${err.code ?? err.message}) — refusing`);
  }
  if (st?.isSymbolicLink()) {
    throw new CliError(
      `${label} "${candidate}" is a link (${lexical}) — refusing to write through it. ` +
        `Being inside the project root is not the same as being the file that was named.`,
    );
  }

  const resolved = boundary.resolve(candidate, label);
  if (!samePath(resolved, lexical)) {
    throw new CliError(`${label} "${candidate}" resolves to ${resolved} rather than ${lexical} — refusing to write through a link`);
  }
  return { lexical, stat: st };
}

/**
 * Resolves a path the engine writes on its own initiative — its own metadata, not a
 * destination the user named. Refuses links outright.
 */
export function resolveInternalArtifact(root, candidate, label = 'engine metadata') {
  return resolveUnlinkedPath(createBoundary(root), candidate, label).lexical;
}

/**
 * Resolves a directory that is about to be deleted RECURSIVELY.
 *
 * Containment is not enough here. The boundary correctly permits an in-root link, but
 * "inside the project root" and "safe to delete" are different questions, and they only
 * diverged once the rule started guarding a recursive wipe: a `frames` junction pointing
 * at the project root is perfectly contained, and deleting through it destroys everything.
 */
export function resolveWipeTarget(root, name, label = 'directory') {
  const boundary = createBoundary(root);
  const lexical = trimTrailingSep(path.resolve(boundary.root, name));

  if (samePath(lexical, boundary.root)) {
    throw new CliError(
      `${label} "${name}" must be a directory strictly below the project root (${boundary.root}) — refusing`,
    );
  }

  const { lexical: resolved, stat } = resolveUnlinkedPath(boundary, name, label);
  if (stat !== undefined && !stat.isDirectory()) {
    throw new CliError(`${label} "${name}" exists and is not a directory (${resolved}) — refusing`);
  }
  return resolved;
}

function resolveAgainst(root, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new CliError(`${label} must be a non-empty path`);
  }
  if (candidate.includes('\u0000')) {
    throw new CliError(`${label} contains a NUL byte — refusing`);
  }

  // Rule 1, first half: on the text, before the filesystem hears about this at all.
  const lexical = trimTrailingSep(path.resolve(root, candidate));
  if (!contains(root, lexical)) {
    throw new CliError(
      `${label} "${candidate}" resolves outside the project root (${root}) — refusing. ` +
        `Pass a path inside the project, or point --project at the directory you meant.`,
    );
  }

  const resolved = realPathWithinBoundary(root, lexical, label);

  // Rule 1, second half: the lexical check cannot see a link that stayed inside the root
  // as text while pointing out of it.
  if (!contains(root, resolved)) {
    throw new CliError(
      `${label} "${candidate}" resolves outside the project root (${root}) once links are followed — refusing`,
    );
  }
  return resolved;
}

/**
 * Resolves `candidate` against `root` and refuses anything that escapes it.
 * Convenience wrapper around createBoundary for a one-off resolution.
 */
export function resolveWithinRoot(root, candidate, label = 'path') {
  return createBoundary(root).resolve(candidate, label);
}

/**
 * Rejects a filename component that is not a plain name — used where a name comes from
 * argv or from timing.json and is interpolated into an output path.
 */
export function requireSafeFilename(name, label = 'name') {
  const text = String(name ?? '');
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text === '.' || text === '..') {
    throw new CliError(
      `${label} "${text}" is not a plain filename — only letters, digits, dot, underscore and hyphen are accepted`,
    );
  }
  return text;
}

/**
 * Parses a plain decimal number within an inclusive range.
 *
 * Deliberately stricter than Number(): the accepted grammar is digits with at most one
 * decimal point and nothing else. These values are interpolated into ffmpeg filter
 * graphs (`volume=${gain}`), where a comma, semicolon or bracket does not error — it
 * appends another filter. Exponent notation, hex, whitespace padding and Infinity are
 * all refused too, because none of them is a level.
 */
export function parseBoundedNumber(raw, { name, min, max }) {
  const text = String(raw ?? '');
  if (!/^(?:\d+|\d*\.\d+)$/.test(text)) {
    throw new CliError(
      `${name} must be a plain decimal number such as 1.14 — got "${text}". ` +
        `Levels are interpolated into an ffmpeg filter graph, so nothing else is accepted.`,
    );
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new CliError(`${name} must be a finite number — got "${text}"`);
  }
  if (value < min || value > max) {
    throw new CliError(`${name} must be between ${min} and ${max} — got ${value}`);
  }
  return value;
}

/**
 * Validates a capture/render parameter that must be a finite positive number.
 *
 * Used for fps, width, height and the derived frame count. An unvalidated fps makes
 * `totalFrames` NaN or non-positive, which produces a run that wipes the frame
 * directory, iterates zero ranges, prints a completion line and exits 0.
 */
export function requirePositiveNumber(raw, { name, max = Number.MAX_SAFE_INTEGER, integer = false }) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`${name} must be a finite positive number — got ${JSON.stringify(raw)}`);
  }
  if (integer && !Number.isSafeInteger(value)) {
    throw new CliError(`${name} must be a whole number — got ${value}`);
  }
  if (value > max) {
    throw new CliError(`${name} must be at most ${max} — got ${value}`);
  }
  return value;
}

/**
 * Validates a value that a guard's decision depends on.
 *
 * The reason this exists: `drift > Math.max(Number('oops'), 1500)` is `drift > NaN`,
 * which is always false — the comparison is not wrong, it simply never fires. A threshold
 * that arrives as NaN disables the check that reads it, silently, and the script reports
 * success. Every calibration value, tolerance and budget input goes through here.
 */
export function requireFiniteNumber(raw, { name, min = -Infinity, max = Infinity }) {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new CliError(`${name} must be a number — got ${JSON.stringify(raw)}`);
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new CliError(`${name} must be a number — got an empty string`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError(`${name} must be a finite number — got ${JSON.stringify(raw)}`);
  }
  if (value < min || value > max) {
    throw new CliError(`${name} must be between ${min} and ${max} — got ${value}`);
  }
  return value;
}

/**
 * Refuses a set of write destinations that collapse onto the same file.
 *
 * Two valid inputs producing one path is not caught by any per-path check: each is
 * individually contained, individually well-named, and the second silently replaces the
 * first without `--replace` ever being consulted.
 *
 * @param {Array<{key: string, path: string}>} destinations
 */
export function assertDistinctDestinations(destinations, label = 'output') {
  const seen = new Map();
  for (const { key, path: dest } of destinations) {
    const normalised = IS_WINDOWS ? dest.toLowerCase() : dest;
    if (seen.has(normalised)) {
      throw new CliError(
        `${label}: "${key}" and "${seen.get(normalised)}" both resolve to ${dest} — ` +
          `refusing, because one would silently overwrite the other`,
      );
    }
    seen.set(normalised, key);
  }
}

/**
 * Reports whether a path exists, distinguishing "absent" from "could not be inspected".
 *
 * `fs.existsSync` answers false for both, so a guard built on it treats an unreadable
 * file as a free slot — the same rule-3 conflation the boundary exists to avoid, reached
 * through the value the guard reads rather than the path it protects.
 */
export function pathExists(abs, label = 'path') {
  try {
    return fs.statSync(abs, { throwIfNoEntry: false }) !== undefined;
  } catch (err) {
    throw new CliError(`${label}: could not inspect ${abs} (${err.code ?? err.message}) — refusing`);
  }
}

/**
 * Reads the owner PID out of a single-writer lock file.
 *
 * Two separate things had to be right here and only one was.
 *
 * The WRITE side is safe by flag: `wx` refuses to create through an existing entry, so a
 * planted link cannot be written through. The READ side was not. On EEXIST this followed
 * the same link, read whatever it pointed at, and put the contents into a diagnostic the
 * caller prints — so a `frames.lock` symlinked at a file outside the project disclosed
 * that file. Verifying the write path and stopping is how that survived.
 *
 * So: the lock is inspected before it is opened, a link or non-regular entry is refused
 * without being read, and contents never reach a message. The exit code is the same
 * either way, which is why the covering tests assert on a sentinel's absence rather than
 * on the code.
 *
 * @returns {{state: 'vanished'} | {state: 'unreadable', detail: string} | {state: 'owned', pid: number}}
 */
export function readLockOwner(lockPath) {
  let st;
  try {
    st = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  } catch (err) {
    return { state: 'unreadable', detail: `could not be inspected (${err.code ?? err.message})` };
  }
  if (st === undefined) return { state: 'vanished' };
  if (st.isSymbolicLink()) {
    // Never opened. Reading a path the caller redirected is an action taken on their
    // behalf, and this one has no legitimate reason to be a link.
    return { state: 'unreadable', detail: 'is a link rather than a lock file — refusing to read through it' };
  }
  if (!st.isFile()) {
    return { state: 'unreadable', detail: 'is not a regular file' };
  }

  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'vanished' };
    return { state: 'unreadable', detail: `could not be read (${err.code ?? err.message})` };
  }

  const text = raw.trim();
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    // Length only. The contents are untrusted and must not be echoed.
    return { state: 'unreadable', detail: `contents are not a PID (${text.length} bytes)` };
  }
  return { state: 'owned', pid };
}

/** Resolves and verifies an input file that must already exist, inside the project root. */
export function requireExistingFile(root, candidate, label) {
  const abs = resolveWithinRoot(root, candidate, label);
  if (!pathExists(abs, label)) {
    throw new CliError(`${label} not found: ${abs}`);
  }
  return abs;
}

/**
 * Resolves an output path, enforcing the replace guard ONLY when the caller is actually
 * going to write.
 *
 * A plan must be able to describe replacing an existing file — refusing during a plan
 * would mean the safe default fails precisely when there is something to protect, which
 * teaches people to skip straight to --apply --replace.
 *
 * @param {string} root
 * @param {string} candidate
 * @param {{apply: boolean, replace: boolean, label?: string}} opts
 */
/** Shared write guards, applied after the path has been resolved by the right policy. */
function applyWriteGuards(abs, candidate, { apply, replace, label }) {
  let st;
  try {
    st = fs.statSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    throw new CliError(`${label}: could not inspect ${abs} (${err.code ?? err.message})`);
  }
  if (st?.isDirectory()) {
    throw new CliError(`${label} "${candidate}" is a directory (${abs}) — refusing to write over it`);
  }
  if (apply && st && !replace) {
    throw new CliError(
      `${label} already exists: ${abs}. Pass --replace to overwrite it, or choose another path.`,
    );
  }
  return abs;
}

/**
 * Resolves an output path the CALLER named, enforcing the replace guard only when the
 * caller is actually going to write.
 *
 * A plan must be able to describe replacing an existing file — refusing during a plan
 * would mean the safe default fails precisely when there is something to protect.
 *
 * An in-root link is permitted here: the caller named this path, so following their own
 * link inside their own project is what they asked for.
 */
export function resolveOutput(root, candidate, { apply, replace, label = 'output' }) {
  return applyWriteGuards(resolveWithinRoot(root, candidate, label), candidate, { apply, replace, label });
}

/**
 * Resolves an output path the ENGINE chose — a fixed artifact name the caller never
 * named, such as `voiceover.mp3` or `sync-mapping.md`.
 *
 * Identical to resolveOutput except that a link is refused rather than followed. The
 * distinction is the whole point: following a link the caller planted is honouring their
 * instruction when they named the path, and writing to a file nobody asked for when they
 * did not.
 */
export function resolveEngineOutput(root, candidate, { apply, replace, label = 'output' }) {
  return applyWriteGuards(resolveInternalArtifact(root, candidate, label), candidate, { apply, replace, label });
}

/**
 * Guards a write. Returns the absolute destination, or throws if the destination
 * already exists and the caller did not explicitly ask to replace it.
 */
export function resolveWriteTarget(root, candidate, { replace, label = 'output' }) {
  return resolveOutput(root, candidate, { apply: true, replace, label });
}

/**
 * Describes what a write would do, for a plan line.
 * @returns {string} e.g. "would CREATE" / "would REPLACE (needs --replace)"
 */
export function describeWrite(absPath, replace) {
  if (!pathExists(absPath, 'output')) return 'would CREATE';
  return replace ? 'would REPLACE (existing content lost)' : 'EXISTS — would need --replace';
}

/**
 * Standard argument parsing for every entry point in this engine.
 *
 * Handles --help by throwing HelpRequested BEFORE returning, so a caller physically
 * cannot fall through into its own I/O with help requested. Every script gets
 * --project, --apply, --replace and --help; pass `options` for the rest.
 */
export function parseCli({ usage, options = {}, allowPositionals = false }) {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        project: { type: 'string' },
        apply: { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        ...options,
      },
      allowPositionals,
      strict: true,
    });
  } catch (err) {
    throw new CliError(`${err.message}\n\n${usage}`);
  }

  // Before anything else. Nothing may be reordered above this line.
  if (parsed.values.help) throw new HelpRequested(usage);

  const projectDir = path.resolve(parsed.values.project ?? process.cwd());
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new CliError(`--project "${projectDir}" is not an existing directory`);
  }

  return {
    values: parsed.values,
    positionals: parsed.positionals ?? [],
    projectDir,
    boundary: createBoundary(projectDir),
    apply: parsed.values.apply === true,
    replace: parsed.values.replace === true,
  };
}

/**
 * Runs a synchronous block, mapping HelpRequested and CliError onto process exit codes.
 *
 * For the scripts that do their work at module scope and so cannot be wrapped in runCli.
 * Without this a guard that fires correctly still escapes as an uncaught throw with a
 * stack trace and the wrong exit code — the guard works and the script still lies about
 * what happened.
 */
export function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HelpRequested) {
      console.log(err.usage);
      process.exit(EXIT.OK);
    }
    if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

/** The standard "nothing happened" footer, so every script says it the same way. */
export function planFooter(verb = 'apply') {
  console.log(`\nnothing was written or deleted. Re-run with --${verb} to proceed.`);
}

/**
 * Entry-point wrapper. Runs `main`, maps its result (or a thrown CliError /
 * HelpRequested) onto process.exitCode, and prints diagnostics to stderr.
 *
 * Sets process.exitCode rather than calling process.exit() so buffered stdout is
 * flushed before the process ends.
 */
export async function runCli(main) {
  try {
    const code = await main();
    process.exitCode = code ?? EXIT.OK;
  } catch (err) {
    if (err instanceof HelpRequested) {
      console.log(err.usage);
      process.exitCode = EXIT.OK;
    } else if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      process.exitCode = err.exitCode;
    } else {
      console.error(err?.stack ?? String(err));
      process.exitCode = EXIT.FAILED;
    }
  }
}
