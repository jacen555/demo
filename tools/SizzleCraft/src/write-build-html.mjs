import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXIT, guard, parseCli, resolveOutput, requireExistingFile, readOptionalEngineJson, describeWrite, planFooter, resolveWithinRoot, CliError, noGoPatternsProblem } from './cli-support.mjs';
import { BRAND_PALETTE } from './brand-palette.mjs';

const USAGE = `
write-build-html — build the renderable scene video-auto.html from timing.json (stage S5).

  node write-build-html.mjs                      plan only (default)
  node write-build-html.mjs --apply              write video-auto.html
  node write-build-html.mjs --apply --replace    overwrite an existing video-auto.html

Options
  --out <file>      output path (default: video-auto.html)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing --out
  --help            show this message

Exit codes: 0 success/plan · 1 build failed · 2 bad usage or refused overwrite
`.trimStart();

// Parsed before any read, so --help cannot reach the filesystem.
//
// THROUGH THE SHARED guard(), which this file already imports and uses at sixteen other
// sites, the first of them fourteen lines below. What stood here was a private re-
// implementation of it that duck-typed `err.name === 'HelpRequested'` and caught EVERY
// error, where guard matches on `instanceof` and rethrows anything that is neither
// CliError nor HelpRequested.
//
// Those are equivalent only if nothing else can escape parseCli, so that was measured
// rather than assumed: 22 adversarial inputs — unknown flags, a value on a boolean, a
// stray positional, and a --project that is missing, a file, empty, 5000 characters, a
// NUL byte, a device name, reserved characters, a non-existent UNC, a trailing dot and a
// drive-relative form — produced only CliError and HelpRequested, and the duck-type never
// disagreed with instanceof. CliError always carries an exitCode, so `err.exitCode ??
// EXIT.FAILED` and guard's `err.exitCode` cannot differ either.
const cli = guard(() => parseCli({ usage: USAGE, options: { out: { type: 'string' } } }));

const dir = cli.projectDir;
// timing.json is ENGINE-chosen: the caller named a project directory, not this file. Joined
// raw, a planted link was followed and handed to JSON.parse, whose message quotes the bytes
// it parsed — disclosing a file outside the project on the bare invocation path.
const timingPath = guard(() => requireExistingFile(dir, 'timing.json', 'timing file'));
// AND THE PARSE ITSELF IS GUARDED, BY SIZE. An unparseable timing.json threw at module top
// level, so the refusal was a V8 stack — and V8's SyntaxError quotes bytes of the input, which
// is the disclosure this stage exists to prevent, on the very first thing it reads. Reported
// by size, matching write-chapters.mjs:197 and the other three stages standardised on exit 2.
const timing = guard(() => {
  const text = fs.readFileSync(timingPath, 'utf8');
  try { return JSON.parse(text); }
  catch { throw new CliError(`${timingPath} is not valid JSON (${text.length} characters)`); }
});
// Harden DOM tokens: segment ids AND node/edge ids (and edge from/to) get interpolated into DOM/SVG
// element ids (e.g. `${seg.id}-label`, `${seg.id}-shot-0`, node/edge ids) and `url(#…)` marker refs. The
// timing schema already constrains these to a safe token, so VALIDATE (fail fast) here rather than
// coercing — silent coercion could collapse distinct invalid ids to the same token (duplicate element
// ids) or desync explicit trigger targets from the rendered ids.
const TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
// THE TOKEN ERROR IS POSITIONAL TOO. It used to quote the offending value, which meant an
// identifier that was BOTH an invalid DOM token AND a no-go match got echoed here — before
// the screen below ever saw it. Order matters as much as wording: screen first, then shape.
const assertTok = (val, where) => { const t = String(val == null ? '' : val); if (!TOKEN_RE.test(t)) throw new CliError(`${where} is not a valid DOM token — it must match ${TOKEN_RE} (fix timing.json and re-run schema validation). It is named by position and deliberately not quoted.`); return t; };
// AN IDENTIFIER IS AUTHOR CONTENT THAT SHIPS. The ids above are interpolated into the
// rendered HTML as DOM element ids and into this stage's diagnostics, so a no-go string in
// one reaches the artefact on a SUCCESSFUL build — the case the frame-level guard never
// sees, because it scans visual.json and not the structure around it. `cortex-supportgraph`
// is a perfectly valid DOM token, so TOKEN_RE passes it straight through.
//
// ===========================================================================
// WHERE SCREENING HAPPENS, AND WHY IT IS NOT OVER THE FINISHED DOCUMENT.
//
// This gate screens CONTRIBUTING INPUTS, and inputs alone were once the whole story — which
// left a ceiling, because the artefact also contains DERIVED strings. The worked example:
// pattern `scenario-label` against `segments[0].id` of `scenario`. The id does not match;
// the engine concatenates the suffix at render time; the matching text existed NOWHERE in
// timing.json, so no input screen could ever see it, and it shipped at exit 0.
//
// That ceiling is CLOSED, and not by scanning the output. MEASURED on the real project: its
// own `https?://` pattern matches the generated document 62 times — 61 SVG `xmlns`
// declarations and one w3.org reference — and ZERO author strings. A whole-document scan
// refuses the only real project we have while catching nothing, which is worse than doing
// nothing at all. Do not add one, including as a backstop.
//
// Instead both author surfaces are screened AT THE POINT OF EMISSION, which is also the last
// place provenance still exists:
//   - `esc(value, where)` — every author string that reaches the HTML. Scaffolding is
//     literal template text and never passes through it, so those 62 false positives are
//     impossible by construction rather than by heuristic.
//   - `elId(value, where)` — the CONCATENATED identifier, screened at the moment it is
//     formed, which is the only place a derived id exists.
//
// This input gate still earns its place: it refuses before any rendering work is done, and
// it is the only screen that sees an identifier the renderer may never emit.
//
// ===========================================================================
// THE POLICY: THIS GUARD IS BEST-EFFORT BY DECISION, NOT BY OMISSION.
//
// It screens what passes the chokepoints. It is NOT a completeness guarantee, and it is not
// intended to become one. 23 disclosure routes were closed across seven independent review
// rounds; the counts per round went 4, 4, 3, 3, 2, 3, 4 and did not converge. Asked directly
// whether what remained was a finite tail of the classes already closed, the reviewer
// answered:
//
//     "the remaining routes are not a finite tail closed by those chokepoints"
//
// The project owner then ruled that the guard is declared best-effort and the tail is not
// chased. That is a decision taken WITH the measurement in hand, not a task running out of
// energy — an eighth round would have found a ninth class.
//
// KNOWN OPEN CLASSES, named so the next reader meets the reason rather than re-deriving it:
//   1. Coercion at any unscreened shape boundary. `String(x)` on an object is
//      `[object Object]` — it discloses nothing and passes, while the object's keys ship.
//      `target` and `action` now refuse non-string shapes; anything new must do the same.
//   2. Diagnostics not routed through `quoted()`. Any message that interpolates an author
//      value and relies on a remembered upstream screen is one refactor from leaking.
//   3. `cli-support.mjs` forwards `err.message` (`:947`, and `err.code ?? err.message` at
//      `:139`, `:188`, `:204`). Another stream owns that file; logged, not reached into.
//
// AND THE RULE THAT FOLLOWS FROM ALL OF IT: adding a new emission path without routing it
// through a screen REOPENS DISCLOSURE SILENTLY. There is no check that will tell you.
//
// HAZARD, learned the hard way: this file now has a guard whose ABSENCE IS INVISIBLE TO
// EVERY STATIC CHECK WE RUN. A duplicated `const screenPayload = …` was syntactically valid,
// `node --check` accepted it, and screening was simply OFF — semantically dead, no warning,
// no error. Only a failing test saw it. Treat `node --check` passing as evidence of nothing
// about this guard.
// ===========================================================================
//
// Completeness is ENFORCED where it can be, not asserted: `everyGeneratedElementId_goes`
// `ThroughTheScreeningHelpers` in tests/guard-inputs.test.mjs fails when an element id
// bypasses both helpers. It carries its own "IT DOES NOT DETECT" list — a guard against
// regression, not a proof — and it found two `-title` sites hand-enumeration had missed,
// then twice waved through bypasses because its own allowlist had rotted.
// ===========================================================================
//
// This screen deliberately issues NO verdict on the pattern list itself: a malformed list is
// codeBlock's to judge, on the code-mode path, and reporting it here would widen this
// stage's reach to projects that never render source data. Anything unusable is skipped and
// the screen simply does less.
const noGoScreen = (() => {
  const raw = timing.project?.noGoPatterns;
  if (!Array.isArray(raw)) return null;
  const usable = [];
  for (const src of raw) {
    if (typeof src !== 'string') continue;
    try { usable.push({ src, re: new RegExp(src, 'i') }); } catch { /* codeBlock reports it */ }
  }
  return usable.length ? (s) => usable.some(c => c.re.test(s) || s.includes(c.src)) : null;
})();
// The refusal names the identifier BY POSITION and never quotes it — quoting it here would
// do precisely the damage the screen exists to prevent, in the message announcing it.
const assertNotDisclosing = (val, where) => {
  if (noGoScreen && noGoScreen(String(val == null ? '' : val))) {
    throw new CliError(
      `${where} matches timing.project.noGoPatterns.\n` +
      'This value is written into the rendered HTML — as visible text, as a DOM element id,\n' +
      'as an attribute, or as trigger data the runtime paints into the frame — and into this\n' +
      "stage's diagnostics, so a no-go string in it reaches the video and the logs even when\n" +
      'every scanned value passes. It is named by position and deliberately not quoted —\n' +
      'read it in timing.json and change it.');
  }
  return val;
};
// SCREEN BY THE ACT OF QUOTING. Every disclosure of this class has had the same shape: a
// diagnostic interpolates an author value that the no-go walk never ran on — a missing file,
// an unresolved path, an unusable timestamp. Fixing them one at a time does not converge,
// and a static scanner cannot help, because it cannot see an upstream screen and so reports
// every safe site as a violation (MEASURED: 7 of 7 such sites in this file are safe).
//
// So the screen moves into the formatting. `quoted(v, where)` is the only sanctioned way to
// put an author value inside a diagnostic: it screens and then quotes, which makes "I forgot
// to screen this first" unrepresentable rather than merely discouraged.
const quoted = (value, where) => {
  const s = String(value ?? '');
  assertNotDisclosing(s, where);
  return JSON.stringify(s);
};
for (const [si, s] of (timing.segments || []).entries()) {
  // Labels are POSITIONAL. They previously embedded `s.id`, which put the very identifier
  // being screened into the message that screens it.
  //
  // SCREEN BEFORE SHAPE, everywhere: `assertTok`'s refusal names a field, so a value that
  // fails both checks must be caught by the screen first or the token error discloses it.
  //
  // `guard()` is what makes this a refusal rather than a crash: a CliError thrown at module
  // top level escapes as an uncaught exception with a stack, and the first version of this
  // screen did exactly that — exit 1 with a stack trace instead of a clean USAGE refusal.
  guard(() => {
    const tok = (val, where) => { assertNotDisclosing(val, where); assertTok(val, where); };
    if (s && s.id != null) tok(s.id, `segments[${si}].id`);
    const v = s && s.visual; if (!v) return;
    (v.nodes || []).forEach((n, i) => { if (n && n.id != null) tok(n.id, `segments[${si}].visual.nodes[${i}].id`); });
    (v.edges || []).forEach((e, i) => {
      if (!e) return;
      const at = `segments[${si}].visual.edges[${i}]`;
      if (e.id != null) tok(e.id, `${at}.id`);
      if (e.from != null) tok(e.from, `${at}.from`);
      if (e.to != null) tok(e.to, `${at}.to`);
    });
    // Fields and hotspots are interpolated into `id="…"` at :422 and :424 UNESCAPED, and
    // `assertTok` never covered them — so a quote in one could close the attribute. They are
    // DOM identifiers by use, so they get the same two checks as the rest.
    (v.fields || []).forEach((f, i) => { if (f && f.id != null) tok(f.id, `segments[${si}].visual.fields[${i}].id`); });
    (v.hotspots || []).forEach((hp, i) => { if (hp && hp.id != null) tok(hp.id, `segments[${si}].visual.hotspots[${i}].id`); });
    // `clipId` is already shape-constrained by safeClipId because it is used as a path
    // segment, but it is ALSO emitted as `data-clip` at :325/:329, so it ships. Shape and
    // disclosure are different questions and a valid token can still be a no-go string.
    if (v.footage?.clipId != null) assertNotDisclosing(v.footage.clipId, `segments[${si}].visual.footage.clipId`);
    // An explicit trigger target is an author-written reference to a DOM id. It is compared
    // against generated ids, quoted in a refusal at :665, and serialised into the shipped
    // trigger data.
    // A TARGET MUST BE A STRING, not merely screenable as one. An object target stringifies
    // to `[object Object]` for the check — which discloses nothing and so passes — while its
    // PROPERTIES are serialised unchanged into `elementTriggers` and ship. Screening a
    // coercion is not screening the value; this is the `[123]` coercion defect once more, in
    // the one place left that still trusted `String()`.
    (s.triggers || []).forEach((t, i) => {
      if (!t || t.target == null) return;
      const where = `segments[${si}].triggers[${i}].target`;
      if (typeof t.target !== 'string') throw new CliError(`${where} must be a string naming a DOM element id. It is named by position and deliberately not quoted.`);
      assertNotDisclosing(t.target, where);
    });
  });
}
// Every slide switch, hold and trigger time is computed from startMs/endMs, and this stage does not
// run validate-timing. A missing time became NaN, which JSON writes as null, and the hold cap
// Math.min(hold, null) is 0: the slide before it was switched away at t=0 while the build exited 0.
// A numeric string is no safer, since trigger times add to it ("2000" + 500). Only a finite JSON
// number places a segment. Ordering and overlap stay validate-timing's job.
guard(() => {
  const describeMs = (v, where) => v === undefined ? 'missing' : typeof v === 'number' ? String(v) : typeof v === 'string' ? `the string ${quoted(v.slice(0, 40), `${where} value`)}` : v === null ? 'null' : `a ${Array.isArray(v) ? 'list' : typeof v}`;
  const unusable = [];
  (timing.segments || []).forEach((s, i) => {
    for (const k of ['startMs', 'endMs']) {
      const v = s?.[k];
      // The segment id IS quoted here, and that is safe: the identifier gate above runs
      // first and has already screened it. What was NOT screened is the offending VALUE,
      // which `describeMs` now formats through `quoted()`. Removing the id as well broke the
      // contract these tests pin by name — a message that names the segment.
      if (typeof v !== 'number' || !Number.isFinite(v)) unusable.push(`segments[${i}] ${JSON.stringify(s?.id ?? null)}: ${k} is ${describeMs(v, `segments[${i}].${k}`)}`);
    }
  });
  if (unusable.length) throw new CliError(`cannot place ${unusable.length === 1 ? 'a segment' : 'segments'} on the timeline; startMs and endMs must be finite numbers of milliseconds (fix timing.json and re-run validate-timing):\n  ${unusable.join('\n  ')}`);
});
// DIMENSIONS ARE INTERPOLATED INTO CSS AND INTO A `content=` ATTRIBUTE, so a non-numeric
// value is markup injection as well as an unscreened author string. `|| 3840` accepts any
// truthy value, including a string — the same "truthy is not valid" shape as the no-go list
// accepting `[123]`. A frame size is a finite positive number or the project is unbuildable.
const dim = (raw, fallback, where) => {
  if (raw == null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 16384) {
    throw new CliError(`${where} must be a whole number of pixels between 1 and 16384. It is named by position and deliberately not quoted.`);
  }
  return raw;
};
const w = guard(() => dim(timing.project?.width, 3840, 'project.width')), h = guard(() => dim(timing.project?.height, 2160, 'project.height'));
// Repair the classic "UTF-8 bytes read back as Latin-1/CP1252" mojibake (e.g. "Â·" -> "·", "â€™" -> "'")
// that upstream tools can bake into titles/labels/watermarks on Windows. Guarded: it only re-decodes when
// the string is EXACTLY the latin1 view of a valid UTF-8 byte sequence (no U+FFFD and perfectly
// reversible), so clean text — and lone accented chars like "é" (U+00E9) — pass through byte-identical.
const demojibake = s => {
  if (!/[\u00C2\u00C3\u00E2]/.test(s)) return s;
  try { const r = Buffer.from(s, 'latin1').toString('utf8'); if (!r.includes('\uFFFD') && Buffer.from(r, 'utf8').toString('latin1') === s) return r; } catch {}
  return s;
};
const esc = (s, where) => {
  const out = demojibake(String(s ?? ''));
  // SCREEN AT THE POINT OF EMISSION. Everything that reaches the rendered HTML as author
  // text passes through here, and — MEASURED — the engine's own scaffolding does not: the
  // real project's `https?://` pattern matches the generated document 62 times, 61 of them
  // the SVG `xmlns` declaration and one a w3.org reference, and BOTH live at :439 and :936
  // as literal template text that is never interpolated. So this screen sees author content
  // and structurally cannot see scaffolding. That is why it is here and not over the
  // finished document, which was measured as refusing the only real project for nothing.
  //
  // An ENGINE FALLBACK is screened too, deliberately: `v.title || seg.title || 'Demo'`
  // renders the engine's own word when the author supplies none, and if the author has said
  // `Demo` must not reach a frame then it reaching the frame is a violation whoever wrote it.
  //
  // THE LINE IS NOT VISIBILITY — an earlier version of this comment said it was, and that was
  // wrong by its own code: `data-path` is screened and is never visible to a viewer. The line
  // is PROVENANCE PLUS SHIPPING. Everything that passes through here is author text, or
  // engine text standing in for it, and all of it is written into the artefact. `xmlns` is
  // neither: it is engine structure that no author input can influence, and it is literal
  // template text that never reaches this function at all.
  //
  // A consequence, accepted rather than special-cased: a fallback inside a
  // `visibility:hidden` element is screened too, because it still ships in the file.
  if (where) assertNotDisclosing(out, where);
  return out.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};
// THE DERIVED IDENTIFIER, SCREENED WHERE IT IS FORMED.
//
// `segments[0].id` of `scenario` does not match the pattern `scenario-label`; the engine
// concatenates the suffix at render time, so the matching string exists NOWHERE in
// timing.json and no input screen can ever see it. This is the only place it exists.
//
// Every generated element id in this stage goes through here, enforced by
// `everyGeneratedElementId_goesThroughTheScreeningHelpers` in tests/guard-inputs.test.mjs.
const elId = (value, where) => { const t = String(value ?? ''); assertNotDisclosing(t, where); return t; };
// Provenance for a screening refusal, by POSITION. `seg.id` is itself screened, so it must
// not appear in a message about screening.
const segWhere = (seg, field) => `segments[${timing.segments.indexOf(seg)}].${field}`;
/**
 * The id the builder gives a generated element: `<segment>-<kind>-<item's id, or its index>`.
 *
 * ONE STATEMENT BECAUSE TWO PLACES HAVE TO AGREE. The same id is emitted into the SVG and
 * then referenced again as an action target in the cue list further down — nine sites in
 * all. If the two spellings ever drifted, the action would target an element that does not
 * exist, and nothing would say so: the cue would simply do nothing at render time.
 *
 * `item.id || j` and not `??`: an id of `''` falls back to the index here, deliberately.
 * `validate-scene.mjs` builds the same shape with `??`, so an empty-string id behaves
 * differently there. The two are NOT interchangeable and this is not shared with it.
 */
const generatedElId = (segId, kind, item, j) => `${segId}-${kind}-${item.id || j}`;
// jsonScript() is the ONLY sanctioned way to embed timing-derived JSON inside a <script> block.
// Valid JSON is NOT script-safe: a narration/title/payload string containing `</script><script>` would
// terminate the block early and inject attacker markup, and U+2028/U+2029 are raw line terminators in
// JS source. Escaping `<`, `>`, `&`, U+2028 and U+2029 to \uXXXX form keeps the value byte-for-byte
// equivalent after JSON.parse while making script breakout structurally impossible. Never interpolate a
// bare JSON.stringify(...) into `<script>`.
const jsonScript = (value, space) => JSON.stringify(value, null, space)
  .replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// SAFE_SRC is canonical containment, not a regex-only allowlist. Every generated image source must
// resolve beneath this run's approved evidence-pack root and remain a local relative file path.
// Containment is decided on the REALPATH: a symlink/junction/reparse point inside evidence-pack whose
// target lives outside it is an escape, and path.resolve() alone cannot see that.
let EVIDENCE_ROOT;
try {
  EVIDENCE_ROOT = fs.realpathSync(path.resolve(dir, 'evidence-pack'));
} catch (err) {
  // A bare ENOENT stack here reads as a crash rather than a missing prerequisite.
  console.error(
    `error: evidence-pack/ not found in ${dir} (${err.code ?? err.message}) — every on-screen asset must ` +
      `resolve beneath the approved evidence pack, so the scene cannot be built without it.`,
  );
  process.exit(EXIT.USAGE);
}
/**
 * Does this `path.relative` result leave the root it was measured from?
 *
 * An EMPTY result counts as escaping here, because all three callers are asking "is this a
 * file strictly inside the root" and a candidate that IS the root is not one.
 *
 * DELIBERATELY NOT USED by the clip-root check in `evidenceSrcOrBase` further down, which
 * spells the same four conditions out and reaches the OPPOSITE verdict on the empty case:
 * there, an empty relative means "this is the clip root" and is accepted. Same expression,
 * two meanings — so they stay apart, and that site carries a note back to this one.
 *
 * Declared above its first caller rather than beside its third: `const` is not hoisted,
 * and a helper reached through a function defined earlier is only safe by argument about
 * call order. This needs no argument.
 */
const escapesRoot = rel => !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
const safeEvidenceSrc = raw => {
  const s = String(raw ?? '').trim();
  if (!s || s.includes('\0') || s.includes('\\') || s.includes('%') || /[?#]/.test(s)) throw new Error('unsafe evidence src rejected');
  if (s.startsWith('//') || s.startsWith('/') || /^[A-Za-z]:/.test(s) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) throw new Error('unsafe evidence src rejected');
  const parts = s.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error('unsafe evidence src rejected');
  const absolute = path.resolve(dir, ...parts);
  const inside = path.relative(EVIDENCE_ROOT, absolute);
  if (escapesRoot(inside)) throw new Error('unsafe evidence src rejected');
  // Reject reparse points (POSIX symlinks AND Windows symlinks/junctions/mount points) on every
  // component, then re-check containment on the fully resolved realpath. lstat() is what distinguishes a
  // link from its target; on Windows a junction reports isSymbolicLink() === true for lstat, and any
  // other reparse point still resolves differently under realpath, which the containment re-check below
  // catches. Missing files are allowed to fail the realpath step and be rejected.
  let walk = EVIDENCE_ROOT;
  for (const part of path.relative(EVIDENCE_ROOT, absolute).split(path.sep)) {
    walk = path.join(walk, part);
    let st; try { st = fs.lstatSync(walk); } catch { throw new Error('unsafe evidence src rejected'); }
    if (st.isSymbolicLink()) throw new Error('unsafe evidence src rejected');
  }
  let real; try { real = fs.realpathSync(absolute); } catch { throw new Error('unsafe evidence src rejected'); }
  const realInside = path.relative(EVIDENCE_ROOT, real);
  if (escapesRoot(realInside)) throw new Error('unsafe evidence src rejected');
  return path.relative(dir, absolute).split(path.sep).join('/');
};
// Aggregate, don't throw on the first bad path: a run with three broken sources should report all three
// with the OWNING segment id and the offending src, not one anonymous "unsafe evidence src rejected".
const srcErrors = [];
const checkedSrc = (raw, segmentId, where) => {
  try { return safeEvidenceSrc(raw); }
  catch { srcErrors.push(`segment "${segmentId}" ${where}: a source is not a contained evidence-pack path (named by position and deliberately not quoted)`); return null; }
};
const assertNoSrcErrors = () => {
  if (srcErrors.length) throw new Error(`unsafe evidence src rejected — ${srcErrors.length} invalid source(s):\n  - ${srcErrors.join('\n  - ')}`);
};

// ---- footage (real user clip) metadata, resolved from clip-video output --------------------------
// A `footage` segment plays REAL extracted clip frames (evidence-pack/footage/<clipId>/frame_*.jpg)
// as a full-bleed background; the frame index is chosen per capture frame by window.__setFootageFrame.
// Each of these is an OPTIONAL engine-chosen input, and `catch {}` collapsed several distinct
// states into one: genuinely absent (fine), unreadable or corrupt (silently removed content),
// and redirected through a link (silently ADDED content from outside the project — suppressing
// the error hid the message, not the read). readOptionalEngineJson keeps them apart, reserves
// null for ENOENT alone, and is told the shape each caller below actually iterates — so a
// present-but-empty file can never arrive here disguised as an absent one.
let FOOTAGE = guard(() => readOptionalEngineJson(dir, path.join('evidence-pack', 'footage', 'clips.json'), 'footage clips.json', { clips: 'array' })) ?? {};
let MANIFEST = guard(() => readOptionalEngineJson(dir, 'manifest.json', 'manifest.json', { stages: 'object' })) ?? {};
const DERIVED_FOOTAGE = MANIFEST.stages?.['materialize-footage']?.derivedFootage || null;
// C-11: evidence-pack.json is the SINGLE source of truth for what may appear on-screen. clips.json alone
// is NOT sufficient — a tampered clips.json must not be able to smuggle an unapproved clip in.
let EVIDENCE = guard(() => readOptionalEngineJson(dir, path.join('evidence-pack', 'evidence-pack.json'), 'evidence-pack.json', { assets: 'array' })) ?? {};
const evidenceApprovedClip = id => !!id && (EVIDENCE.assets || []).some(a => a && a.kind === 'clip' && a.approvedForUse === true && a.id === id);
// clipId is used verbatim as a path segment; force it to a single safe token (no separators / `..`)
// so neither the fallback path nor the frame URLs can escape evidence-pack/footage/.
const safeClipId = id => { const s = String(id || ''); return (TOKEN_RE.test(s) && s !== '.' && s !== '..') ? s : ''; };
const footageClip = id => { const cid = safeClipId(id); return cid ? ((FOOTAGE.clips || []).find(c => c.id === cid) || null) : null; };
// C-3/C-11: a clip may only be composited when it is approved AND redaction-clear in clips.json AND has
// a matching approved evidence-pack asset (kind:"clip", approvedForUse:true, id===clipId) — the manifest
// is the authoritative gate, so a tampered clips.json can never approve a clip on its own.
const footageApproved = c => !!c && c.approvedForUse === true && c.redaction === 'clear' && evidenceApprovedClip(c.id);
const footageUsable = seg => footageApproved(footageClip(seg.visual?.footage?.clipId));
// A segment renders as `footage` ONLY when its clip is approved + redaction-clear; otherwise it falls
// back to a synthetic mode (explicit visual.mode, else inferred diagram/live/narrative) so the panel is
// never blank and autoTriggers() still generates the reveal/diagram/live triggers (schema/docs promise).
// `v.mode` IS INTERPOLATED INTO `data-mode` AND A CLASS NAME, unescaped, so an unknown value
// is both markup injection and an unscreened author string. `if (v.mode && v.mode !== 'footage') return v.mode`
// returned whatever the author wrote. The supported set is closed — `body()` dispatches on
// exactly these — so anything else is a refusal, not a silent passthrough.
const MODES = new Set(['footage', 'code', 'diagram', 'live', 'narrative', 'statement', 'endcard']);
const mode = seg => { const v = seg.visual || {}; if ((v.mode === 'footage' || (!v.mode && v.footage)) && footageUsable(seg)) return 'footage'; if (v.mode && v.mode !== 'footage') { if (!MODES.has(v.mode)) throw new CliError(`segments[${timing.segments.indexOf(seg)}].visual.mode is not one of ${[...MODES].join(', ')}. It is named by position and deliberately not quoted.`); return v.mode; } return v.nodes ? 'diagram' : (v.shot || v.fields || v.hotspots) ? 'live' : 'narrative'; };
// Playback metadata is security-sensitive: frameCount changes where playback clamps, while fps changes
// timestamp-to-frame mapping. Derive count from the exact independently enumerated frame set, bind fps
// to storyboard-protected timing.project.fps, and require clips.json + manifest lineage to agree.
const FRAME_FILE_RE = /^frame_[0-9]{5}\.(?:jpg|jpeg|png|webp)$/i;
const containedRelative = (root, candidate, where) => {
  const rel = path.relative(root, candidate);
  if (escapesRoot(rel)) throw new Error(`footage lineage mismatch: ${where} escaped its clip root`);
  return rel;
};
const frameSetFacts = id => {
  const cid = safeClipId(id);
  if (!cid) throw new Error(`footage lineage mismatch: unsafe clip id ${JSON.stringify(id)}`);
  const clipRoot = path.resolve(EVIDENCE_ROOT, 'footage', cid);
  let rootStat;
  try { rootStat = fs.lstatSync(clipRoot); } catch { throw new Error(`footage lineage mismatch: missing frame root for ${cid}`); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`footage lineage mismatch: invalid frame root for ${cid}`);
  const clipReal = fs.realpathSync(clipRoot);
  containedRelative(EVIDENCE_ROOT, clipReal, `${cid} frame root`);
  const frames = [];
  const walk = current => {
    for (const name of fs.readdirSync(current)) {
      const candidate = path.join(current, name);
      const st = fs.lstatSync(candidate);
      if (st.isSymbolicLink()) throw new Error(`footage lineage mismatch: linked frame path for ${cid}`);
      const real = fs.realpathSync(candidate);
      containedRelative(clipReal, real, `${cid}/${name}`);
      if (st.isDirectory()) { walk(candidate); continue; }
      if (!FRAME_FILE_RE.test(name)) continue;
      if (!st.isFile()) throw new Error(`footage lineage mismatch: non-regular frame for ${cid}`);
      frames.push({ relative: path.relative(clipReal, real).split(path.sep).join('/'), real });
    }
  };
  walk(clipRoot);
  if (!frames.length) throw new Error(`footage lineage mismatch: empty frame set for ${cid}`);
  frames.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const digest = crypto.createHash('sha256');
  digest.update(Buffer.from('sizzlecraft-frame-set-v1', 'utf8'));
  digest.update(Buffer.from([0]));
  for (const frame of frames) {
    const bytes = fs.readFileSync(frame.real);
    digest.update(Buffer.from(frame.relative, 'utf8'));
    digest.update(Buffer.from([0]));
    digest.update(Buffer.from(String(bytes.length), 'ascii'));
    digest.update(Buffer.from([0]));
    digest.update(bytes);
    digest.update(Buffer.from([0]));
  }
  return { frameSetSha: digest.digest('hex'), frameCount: frames.length };
};
const VERIFIED_FOOTAGE_META = new Map();
const verifyFootageLineage = () => {
  const approved = (FOOTAGE.clips || []).filter(c => c?.approvedForUse === true);
  if (!approved.length) return;
  if (DERIVED_FOOTAGE?.kind !== 'footage-frame-set-v1' || DERIVED_FOOTAGE?.producer !== 'materialize-footage' || !Array.isArray(DERIVED_FOOTAGE.clips)) {
    throw new Error('footage lineage mismatch: approved clips require materialize-footage lineage');
  }
  const projectFps = timing.project?.fps;
  if (!Number.isSafeInteger(projectFps) || projectFps < 1) throw new Error('footage lineage mismatch: timing.project.fps must be a positive integer');
  const lineageById = new Map(DERIVED_FOOTAGE.clips.map(c => [c?.id, c]));
  if (lineageById.size !== DERIVED_FOOTAGE.clips.length) throw new Error('footage lineage mismatch: duplicate lineage clip id');
  const approvedIds = new Set(approved.map(c => c?.id));
  if (approvedIds.size !== approved.length) throw new Error('footage lineage mismatch: duplicate approved clip id');
  const projection = approved
    .slice()
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(c => {
      const cid = safeClipId(c.id), lineage = lineageById.get(cid), facts = frameSetFacts(cid);
      if (!lineage) throw new Error(`footage lineage mismatch: missing lineage clip ${cid}`);
      if (c.frameSetSha !== facts.frameSetSha || lineage.frameSetSha !== facts.frameSetSha) throw new Error(`footage lineage mismatch: frameSetSha differs for ${cid}`);
      if (!Number.isSafeInteger(c.frameCount) || c.frameCount !== facts.frameCount || lineage.frameCount !== facts.frameCount) throw new Error(`footage lineage mismatch: frameCount differs for ${cid}`);
      if (!Number.isSafeInteger(c.fps) || c.fps !== projectFps || lineage.fps !== projectFps) throw new Error(`footage lineage mismatch: fps differs for ${cid}`);
      if (lineage.redaction !== c.redaction) throw new Error(`footage lineage mismatch: redaction differs for ${cid}`);
      VERIFIED_FOOTAGE_META.set(cid, { frameCount: facts.frameCount, fps: projectFps });
      return { id: cid, frameSetSha: facts.frameSetSha, frameCount: facts.frameCount, fps: projectFps, redaction: c.redaction };
    });
  if (lineageById.size !== projection.length) throw new Error('footage lineage mismatch: lineage clip set differs');
  const projectionSha = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(projection), 'utf8')).digest('hex');
  if (DERIVED_FOOTAGE.sha256 !== projectionSha) throw new Error('footage lineage mismatch: derived projection hash differs');
};
guard(() => verifyFootageLineage());   // seventh guard() site: it throws on invalid approved-clip lineage at module top level, which exited with a native stack rather than a clean refusal
const footageMeta = id => {
  const meta = VERIFIED_FOOTAGE_META.get(safeClipId(id));
  if (!meta) throw new Error(`footage lineage mismatch: unverified playback metadata for ${String(id)}`);
  return meta;
};
// Frame dirs are attacker-influenced (timing.json) and are used to build Image.src. Canonically resolve
// them under evidence-pack first, then require containment in this clip's own subtree.
const safeFrameDir = (raw, clipId) => {
  const base = `evidence-pack/footage/${clipId}`;
  if (!raw) return base;
  try {
    const norm = safeEvidenceSrc(raw);
    const absolute = path.resolve(dir, norm);
    const clipRoot = path.resolve(EVIDENCE_ROOT, 'footage', clipId);
    const inside = path.relative(clipRoot, absolute);
    // NOT escapesRoot(): this is the one site where an EMPTY relative is accepted, because
    // here it means "the candidate IS the clip root" rather than "it is not inside one".
    // Spelled out on purpose — the four conditions match that helper and the verdict does
    // not, so collapsing them would invert this check.
    return (!inside || (!inside.startsWith(`..${path.sep}`) && inside !== '..' && !path.isAbsolute(inside))) ? norm : base;
  } catch {
    return base;
  }
};
const hasFootage = guard(() => timing.segments.some(s => mode(s) === 'footage'));  // mode() now refuses an unknown mode, and this is the FIRST call of it — at module top level, where an unguarded throw is a stack trace rather than a refusal. Sixth instance of that mistake in this file.e clip is approved + redaction-clear
function footageLayer(seg) {
  const f = seg.visual?.footage || {}, clipId = safeClipId(f.clipId);
  const clip = footageClip(clipId);
  if (!footageApproved(clip)) {
    // Fail closed: never pull an unapproved / unredacted clip into the output. Emit an inert
    // placeholder (no frame source) so the segment falls back to synthetic content instead.
    return `<div id="${elId(`${seg.id}-footage`, segWhere(seg, 'generated element id'))}" class="footage-layer footage-blocked" data-clip="${esc(clipId, segWhere(seg, 'visual.footage.clipId'))}"></div>`;
  }
  const fdir = safeFrameDir(f.frameDir, clipId);
  const fit = f.fit === 'cover' ? 'cover' : 'contain', meta = footageMeta(clipId);
  return `<div id="${elId(`${seg.id}-footage`, segWhere(seg, 'generated element id'))}" class="footage-layer" data-clip="${esc(clipId, segWhere(seg, 'visual.footage.clipId'))}" data-framedir="${esc(fdir, segWhere(seg, 'visual.footage.frameDir'))}" data-framecount="${meta.frameCount}" data-fps="${meta.fps}" data-startms="${Number(f.startAtMs || 0)}" data-segstart="${seg.startMs}" data-segend="${seg.endMs}" style="background-size:${fit}"></div>`;
}

// ---- background choice + Azure-multicolor components -----------------------
// The user picks a BACKGROUND at intake; components then render multicolor from the
// fixed Azure/Fluent PALETTE (assigned per-component by index). Background and palette
// are decoupled — the same multicolor components read cleanly on any background, and
// text/surface vars adapt to the background's light|dark mode for AA contrast.
const PALETTE = BRAND_PALETTE;
const ca = j => PALETTE[j % PALETTE.length];
const BACKGROUNDS = {
  white: { mode: 'light', stage: `radial-gradient(circle at 7% 6%,rgba(0,120,212,.10),transparent 30%),radial-gradient(circle at 93% 7%,rgba(227,0,140,.07),transparent 32%),radial-gradient(circle at 91% 94%,rgba(16,124,16,.07),transparent 32%),radial-gradient(circle at 9% 93%,rgba(247,99,12,.07),transparent 32%),linear-gradient(160deg,#FFFFFF,#F5F8FC)` },
  slate: { mode: 'light', stage: `linear-gradient(160deg,#EEF1F6,#DFE5EE)` },
  midnight: { mode: 'dark', stage: `radial-gradient(circle at 78% 12%,rgba(80,230,255,.16),transparent 30%),linear-gradient(135deg,#0B1020,#0c1a3a)` },
  transparent: { mode: 'light', stage: `#FFFFFF` } // MP4 has no alpha — transparent renders as white
};
const bgKey = String(timing.project?.background || timing.intake?.background || '').toLowerCase();
const bg = BACKGROUNDS[bgKey] || null;       // a chosen background (else null → legacy theme path)
const multicolor = !!bg;                      // multicolor components turn on with a chosen background
const bgVars = !bg ? '' : (bg.mode === 'light'
  ? '--color-text-primary:#201F1E;--color-text-secondary:#2B2A29;--color-card-bg:#FFFFFF;--color-card-border:rgba(0,0,0,.10);--color-accent-1:#0078D4;--color-accent-2:#00B7C3;--color-bg-primary:#FFFFFF;--color-bg-secondary:#F3F5F9'
  : '--color-text-primary:#FFFFFF;--color-text-secondary:#B7C6DE;--color-card-bg:rgba(255,255,255,.05);--color-card-border:rgba(255,255,255,.12);--color-bg-primary:#0B1020;--color-bg-secondary:#0c1a3a');

// ---- per-mode slide body -------------------------------------------------
function narrative(seg) {
  const v = seg.visual || {};
  const cards = (v.items || []).slice(0, 6).map((it, j) => {
    const accent = multicolor ? ca(j) : null;
    const cstyle = accent ? ` style="--ca:${accent};border-top:4px solid ${accent}"` : '';
    const statCls = accent ? 'stat' : 'stat gradient-text';
    return `<div id="${elId(`${seg.id}-item-${j}`, segWhere(seg, 'generated element id'))}" class="el card"${cstyle}><div class="kicker">${esc(it.label || 'Point ' + (j + 1), segWhere(seg, `visual.items[${j}].label`))}</div>${it.value ? `<div class="${statCls}">${esc(it.value, segWhere(seg, `visual.items[${j}].value`))}</div>` : ''}<div class="body">${esc(it.text || it.title || '', segWhere(seg, `visual.items[${j}].text`))}</div></div>`;
  }).join('');
  const shots = (v.shots || (v.image ? [{ src: v.image, label: v.imageLabel }] : [])).slice(0, 4).map((s, j) => {
    const src = checkedSrc(s.src, seg.id, 'visual.shots[].src');   // aggregates via safeEvidenceSrc(s.src); null => reported below, nothing emitted
    if (!src) return '';
    return `<figure id="${elId(`${seg.id}-shot-${j}`, segWhere(seg, 'generated element id'))}" class="el shot"><img src="${esc(src, segWhere(seg, `visual.shots[${j}].src`))}" alt="${esc(s.label || '', segWhere(seg, `visual.shots[${j}].label`))}" loading="eager"/>${s.label ? `<figcaption>${esc(s.label, segWhere(seg, `visual.shots[${j}].label`))}</figcaption>` : ''}</figure>`;
  }).join('');
  return `${cards ? `<div class="grid">${cards}</div>` : ''}${shots ? `<div class="shots">${shots}</div>` : ''}`;
}

function diagram(seg) {
  const v = seg.visual || {}, nodes = v.nodes || [], edges = v.edges || [];
  const nodeAt = id => nodes.find(n => n.id === id) || {};
  const cx = n => Number(n.x || 0) + Number(n.w || 240) / 2, cy = n => Number(n.y || 0) + Number(n.h || 96) / 2;
  // point on node n's border along the line toward (tx,ty), with a small gap so the arrowhead clears the box
  const border = (n, tx, ty, gap = 10) => {
    const nx = Number(n.x || 0), ny = Number(n.y || 0), nw = Number(n.w || 240), nh = Number(n.h || 96);
    const px = nx + nw / 2, py = ny + nh / 2, dx = tx - px, dy = ty - py;
    if (!dx && !dy) return [px, py];
    const s = Math.min(dx ? (nw / 2 + gap) / Math.abs(dx) : Infinity, dy ? (nh / 2 + gap) / Math.abs(dy) : Infinity);
    return [px + dx * s, py + dy * s];
  };
  const nodeSvg = nodes.map((n, j) => {
    const x = Number(n.x || 0), y = Number(n.y || 0), nw = Number(n.w || 240), nh = Number(n.h || 96);
    const st = multicolor ? ` style="--ca:${ca(j)}"` : '';
    // Node label uses a wrapping HTML block (foreignObject) instead of a single SVG <text> line so long
    // labels wrap + fit INSIDE the box (no overflow past the rounded rect). See `.nodelabel` CSS.
    return `<g id="${elId(`${seg.id}-node-${n.id}`, segWhere(seg, 'generated element id'))}" class="el dnode"${st}><rect x="${x}" y="${y}" width="${nw}" height="${nh}" rx="14"/><foreignObject x="${x}" y="${y}" width="${nw}" height="${nh}"><div xmlns="http://www.w3.org/1999/xhtml" class="nodelabel">${esc(n.label || n.id || '', segWhere(seg, `visual.nodes[${j}].label`))}</div></foreignObject></g>`;
  }).join('');
  const edgeSvg = edges.map((e, j) => {
    const a = nodeAt(e.from), b = nodeAt(e.to);
    const [ax, ay] = border(a, cx(b), cy(b)), [bx, by] = border(b, cx(a), cy(a));
    const st = multicolor ? ` style="--ce:${ca(j)}"` : '';
    const marker = multicolor ? generatedElId(seg.id, 'arr', e, j) : 'arrow';
    return `<path id="${elId(generatedElId(seg.id, 'edge', e, j), segWhere(seg, 'generated element id'))}" class="el dedge"${st} d="M ${ax} ${ay} L ${bx} ${by}" marker-end="url(#${marker})"/>`;
  }).join('');
  // Edge labels are emitted AFTER the nodes so they paint on TOP (never hidden behind a box or an
  // arrowhead) and carry a stroke halo (see `.delabel` CSS) so the text stays legible over any line.
  // Each keeps its `el`/`-edgelabel-` id so the runtime reveals it together with its edge (drawEdge) —
  // previously edge labels carried `el` (visibility:hidden) but no trigger ever showed them.
  const labelSvg = edges.map((e, j) => {
    if (!e.label) return '';
    const a = nodeAt(e.from), b = nodeAt(e.to);
    const [ax, ay] = border(a, cx(b), cy(b)), [bx, by] = border(b, cx(a), cy(a));
    return `<text id="${elId(generatedElId(seg.id, 'edgelabel', e, j), segWhere(seg, 'generated element id'))}" class="el delabel" x="${(ax + bx) / 2}" y="${(ay + by) / 2 - 14}" text-anchor="middle">${esc(e.label, segWhere(seg, `visual.edges[${j}].label`))}</text>`;
  }).join('');
  // Arrowhead size is per-visual (visual.arrowSize), so one diagram can change it without
  // changing every other diagram in every project. Default 6. It was 10, raised from 7 so
  // direction read at video scale, but at 10 the heads read as heavy blobs on a 4K frame —
  // reported across three separate segments before it was recognised as a global default
  // rather than a per-diagram choice. refX tracks the width at the same 0.8 ratio so the
  // head still meets the line.
const aSize = Number(v.arrowSize) > 0 ? Number(v.arrowSize) : 6;
  const arrowDims = `refX="${+(aSize * 0.8).toFixed(2)}" refY="5" markerWidth="${aSize}" markerHeight="${aSize}"`;
  const multiMarkers = multicolor ? edges.map((e, j) =>
    `<marker id="${elId(generatedElId(seg.id, 'arr', e, j), segWhere(seg, 'generated element id'))}" viewBox="0 0 10 10" ${arrowDims} orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${ca(j)}"/></marker>`).join('') : '';
  return `<svg class="diagram-svg" viewBox="${esc(v.viewBox || '0 0 1600 900', segWhere(seg, 'visual.viewBox'))}" preserveAspectRatio="xMidYMid meet"><defs><marker id="arrow" viewBox="0 0 10 10" ${arrowDims} orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker>${multiMarkers}</defs>${edgeSvg}${nodeSvg}${labelSvg}</svg>`;
}

function live(seg) {
  const v = seg.visual || {}, url = v.url || 'app.localhost', shot = v.shot || v.image;
  const shotSrc = shot ? (checkedSrc(shot, seg.id, 'visual.shot') || '') : '';   // aggregates via safeEvidenceSrc(shot)
  const fields = (v.fields || []).map((f, j) =>
    `<div id="${elId(generatedElId(seg.id, 'field', f, j), segWhere(seg, 'generated element id'))}" class="el livefield" style="left:${Number(f.x || 4)}%;top:${Number(f.y || 12)}%;width:${Number(f.w || 30)}%"><span class="livelabel">${esc(f.label || '', segWhere(seg, `visual.fields[${j}].label`))}</span><span class="liveinput" data-text="${esc(f.text || '', segWhere(seg, `visual.fields[${j}].text`))}"></span></div>`).join('');
  const hotspots = (v.hotspots || []).map((hp, j) =>
    `<div id="${elId(generatedElId(seg.id, 'hotspot', hp, j), segWhere(seg, 'generated element id'))}" class="el hotspot" style="left:${Number(hp.x || 50)}%;top:${Number(hp.y || 50)}%">${esc(hp.label || '', segWhere(seg, `visual.hotspots[${j}].label`))}</div>`).join('');
  return `<div class="browser"><div class="chrome"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><div class="urlbar">${esc(url, segWhere(seg, 'visual.url'))}</div></div><div class="viewport">${shotSrc ? `<img class="liveshot" src="${esc(shotSrc, segWhere(seg, 'visual.shot'))}" alt=""/>` : ''}${fields}${hotspots}<div id="${elId(`${seg.id}-cursor`, segWhere(seg, 'generated element id'))}" class="cursor"></div></div></div>`;
}

// ---- code mode: a real JSON object on screen, addressable field by field ----
// Shows configuration as it actually is rather than as a summary. That is the point —
// and the risk, because it is the only mode that puts SOURCE DATA on the screen instead
// of authored copy. Two guards below exist only because of that.

const codePathId = (segId, p) =>
  `${segId}-path-${String(p).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;

/** Renders one JSON value, recording every addressable path it emits. */
function jsonHtml(value, segId, at, depth, paths) {
  const pad = n => '  '.repeat(n);
  const entry = (p, inner, block) => {
    paths.push(p);
    return `<span class="j-entry${block ? ' j-block' : ''}" id="${elId(codePathId(segId, p), `code JSON path id for ${at || '(root)'}`)}" data-path="${esc(p, `code JSON path ${at || '(root)'}`)}">${inner}</span>`;
  };

  if (Array.isArray(value)) {
    if (!value.length) return '<span class="j-punc">[]</span>';
    const items = value
      .map((v, i) => {
        const p = `${at}[${i}]`;
        // The separator lives INSIDE the entry. A block-level container would otherwise
        // orphan the comma onto its own line once the highlight makes it display:block.
        const inner = jsonHtml(v, segId, p, depth + 1, paths) +
          (i < value.length - 1 ? '<span class="j-punc">,</span>' : '');
        return `${pad(depth + 1)}${entry(p, inner, v !== null && typeof v === 'object')}`;
      })
      .join('\n');
    return `<span class="j-punc">[</span>\n${items}\n${pad(depth)}<span class="j-punc">]</span>`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '<span class="j-punc">{}</span>';
    const items = keys
      .map((k, i) => {
        const p = at ? `${at}.${k}` : k;
        const inner = `<span class="j-key">"${esc(k, `code JSON key under ${at || '(root)'}`)}"</span><span class="j-punc">: </span>` +
          jsonHtml(value[k], segId, p, depth + 1, paths) +
          (i < keys.length - 1 ? '<span class="j-punc">,</span>' : '');
        return `${pad(depth + 1)}${entry(p, inner, value[k] !== null && typeof value[k] === 'object')}`;
      })
      .join('\n');
    return `<span class="j-punc">{</span>\n${items}\n${pad(depth)}<span class="j-punc">}</span>`;
  }
  if (typeof value === 'string') return `<span class="j-str">"${esc(value, `code JSON value at ${at || '(root)'}`)}"</span>`;
  if (typeof value === 'number') return `<span class="j-num">${esc(value, `code JSON value at ${at || '(root)'}`)}</span>`;
  if (typeof value === 'boolean') return `<span class="j-bool">${esc(value, `code JSON value at ${at || '(root)'}`)}</span>`;
  return `<span class="j-null">${esc('null', `code JSON value at ${at || '(root)'}`)}</span>`;
}

function codeBlock(seg) {
  const v = seg.visual || {};
  let data = v.json;

  if (data === undefined && v.jsonFile) {
    // CONFINED AT RESOLUTION TIME, NOT AT RENDER TIME.
    //
    // My first version compared `path.relative(dir, abs)` — lexical only, so it could not
    // see a link that stays inside the project as TEXT while pointing outside it once
    // followed. resolveWithinRoot canonicalises and re-checks after following links.
    //
    // The boundary matters more here than anywhere else in this file. Every other visual
    // mode renders authored copy; `code` mode renders the file's contents straight into
    // the frame. An escaping read is not a log line someone might notice — it is
    // composited into the video and encoded. And the guard must run BEFORE the read,
    // because JSON.parse quotes the first bytes it parsed in its error message, so a
    // parse failure discloses the file whether or not it is ever drawn.
    //
    // No-go patterns cannot cover this: they match content you predicted, and a link
    // redirect changes WHICH FILE you read.
    // SCREEN BEFORE THE DIAGNOSTICS THAT QUOTE THEM. Every refusal below names `v.jsonFile`,
    // and the `pick` refusal names `v.pick` and the component it stopped at. None of those
    // values is part of the walked JSON — a missing file and an unresolved path are
    // precisely the cases where the no-go scan never runs — so without this they are quoted
    // unscreened. Screened here, a disclosing value refuses by position and the quotes below
    // are only reachable for a safe one.
    assertNotDisclosing(String(v.jsonFile ?? ''), segWhere(seg, 'visual.jsonFile'));
    if (v.pick != null) assertNotDisclosing(String(v.pick), segWhere(seg, 'visual.pick'));
    const abs = resolveWithinRoot(dir, v.jsonFile, `segment "${seg.id}" visual.jsonFile`);
    if (!fs.existsSync(abs)) throw new CliError(`segment "${seg.id}": visual.jsonFile not found — ${v.jsonFile}`);
    try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); }
    catch (e) {
      // Do NOT echo the parser message: it embeds file contents.
      throw new CliError(`segment "${seg.id}": visual.jsonFile is not valid JSON (${v.jsonFile})`);
    }
    if (v.pick) {
      // `k in data` walks the prototype chain and does not check the container's type, so
      // `__proto__` resolves without existing in the JSON, and descending into a STRING
      // throws a native error that can quote that string — before the no-go guard has run.
      // Own properties of objects and arrays only, and a content-free refusal.
      for (const k of String(v.pick).split('.')) {
        const isContainer = data !== null && typeof data === 'object';
        if (!isContainer || !Object.prototype.hasOwnProperty.call(data, k)) {
          throw new CliError(`segment "${seg.id}": visual.pick path "${v.pick}" does not resolve in ${v.jsonFile} (stopped at "${k}")`);
        }
        data = data[k];
      }
    }
  }
  if (data === undefined) throw new CliError(`segment "${seg.id}": code mode needs visual.json or visual.jsonFile`);

  // GUARD 1 — no-go strings. Authored copy is reviewed by a human; source data is not.
  // This is the only mode that renders data nobody wrote for the screen, so the patterns
  // are enforced HERE, at the point the data reaches a frame, rather than trusted upstream.
  //
  // The refusal names the PATTERN'S INDEX and the JSON PATH, never the pattern's source
  // text and never the matched value. An earlier version printed 80 characters of the
  // match "so the author could see what tripped" — which moves the very content the
  // pattern exists to contain into the console and the render log. A guard that discloses
  // what it refuses has done the damage it was preventing.
  //
  // That reasoning was written here, applied to the match, and NOT applied to the pattern,
  // which this stage went on to print on both refusal paths. A no-go list is by
  // construction a list of the strings an author wants kept off the screen — on the one
  // real sample project they are internal hostnames — so echoing the pattern leaks the
  // same class of value, through the path that fires when the guard SUCCEEDS.
  // validate-scene.mjs:748 had already ruled the other way for the same field: "The
  // pattern is no safer than the match." The index is the handle; it says which pattern
  // without saying what it is, and the author can read it in their own file.
  const patterns = timing.project?.noGoPatterns;
  if (!Array.isArray(patterns)) {
    // ABSENT IS NOT PERMISSION. Defaulting to "no patterns" makes the frame-boundary
    // guarantee inert exactly where it matters — a project that never configured it is
    // the one least likely to have reviewed its source data. Opting out has to be said
    // out loud, so an empty array is accepted and a missing key is refused.
    throw new CliError(
      `segment "${seg.id}": code mode requires timing.project.noGoPatterns.\n` +
      'This mode renders source data straight into the frame, and unlike authored copy it\n' +
      'gets no human review, so the no-go list is mandatory rather than optional.\n' +
      'Set it to [] to state explicitly that this object needs no redaction.');
  }
  if (patterns.length) {
    // The shape is cli-support's `noGoPatternsProblem`, shared with validate-scene. This
    // stage previously checked only `Array.isArray`, so `[123]` was coerced to "123" by
    // `new RegExp` and became a live pattern, and neither the count nor each pattern's
    // length was bounded. The absence refusal above stays local: it is this stage's own
    // code-mode rule, and a render stage refusing is not the same act as a report stage
    // recording a finding.
    const shape = noGoPatternsProblem(patterns, 'timing.project.noGoPatterns');
    if (shape) throw new CliError(shape);
    const hits = [];
    // Compile every pattern BEFORE walking, so a key can be tested against all of them.
    // A key is disclosed through the path of any hit beneath it, not just its own, so the
    // decision to print it cannot depend on which pattern is currently being walked.
    const compiled = patterns.map((src, index) => {
      try { return { index, src, re: new RegExp(src, 'i') }; }
      catch { throw new CliError(`timing.project.noGoPatterns[${index}] is not a valid regular expression`); }
    });
    // A KEY IS PRINTABLE ONLY IF IT DISCLOSES NOTHING. It is withheld when it matches any
    // pattern — a matching key IS the matched value — and also when it carries a pattern's
    // source text literally, which is how an author who names a key after their own regex
    // would otherwise have that regex echoed. Everything else is ordinary structure and is
    // kept, because the path is the author's only locator and a refusal nobody can act on
    // is its own defect.
    //
    // `i` is the key's position in Object.keys() ENUMERATION order, which is not the order
    // in the file: V8 emits integer-like keys first. The trailing note below says so rather
    // than letting the number read as a line position.
    const discloses = (s) => compiled.some(c => c.re.test(s) || s.includes(c.src));
    // A DEGENERATE PATTERN DEGRADES THIS, AND THAT IS CORRECT. `.*` makes `discloses` true
    // for every string, so every component is withheld and the refusal keeps only the
    // pattern's index. But `.*` also matches every value in the data, so that project
    // refuses whatever it contains: the locators are uninformative because the pattern is,
    // not because the screening is wrong. `noGoPatternsProblem` bounds count and length and
    // deliberately does not judge what a pattern matches.
    const shownKey = (k, i) => (discloses(k) ? `key #${i}` : k);
    // AN ARRAY INDEX IS A PATH COMPONENT TOO, and it is screened the same way. Unlike a key
    // there is no non-disclosing substitute that is still a locator — the index IS the
    // digits that would collide — so the component is dropped. The containing path and the
    // pattern's index remain, which is enough to find it in the source file.
    const shownIndex = (i) => (discloses(String(i)) ? '[…]' : `[${i}]`);
    // AND THE FINISHED PATH IS SCREENED TOO. Screening each component is not the same as
    // screening what is printed: with pattern `foo.bar`, the keys `foo` and `bar` each pass
    // on their own and the path they assemble into does not. There is no safe partial form
    // of a string whose whole is the disclosure, so it is withheld; the pattern's index
    // remains, and the author can run that pattern over their own file.
    const shownPath = (at) => (discloses(at) ? '(path withheld — it would itself disclose)' : at);
    for (const { index, re } of compiled) {
      // Walk values rather than the serialised blob, so a hit can be reported by path.
      //
      // IT DOES NOT DETECT:
      //   1. Authored copy — titles, labels, subtitles, voiceover. Only `visual.json` source
      //      data is walked, because copy is human-reviewed and source data is not. Those
      //      strings are screened where they are EMITTED instead, by `esc(value, where)`.
      //   2. Anything outside this segment's rendered object. Identifiers are screened at the
      //      top of this stage, and derived identifiers by `elId()` where they are formed.
      //
      // IT NO LONGER FAILS TO DETECT booleans or null. The walk still tests strings and
      // numbers only, so a pattern matching the literal `true`, `false` or `null` does not
      // refuse HERE — but `jsonHtml` renders every scalar through `esc(value, …)`, which
      // screens what is actually about to appear on screen whatever its type. The gap closed
      // without this walk changing, which is the point of screening at emission.
      //
      // The walk carries TWO paths. `at` is what gets PRINTED, with disclosing components
      // already substituted. `real` is the path as `jsonHtml` will emit it in `data-path`
      // (`:441`), and it is screened in its own right: with pattern `foo.bar` and data
      // `{foo:{bar:"safe"}}`, no key and no value matches, yet `data-path="foo.bar"` shipped
      // in the HTML at exit 0. MEASURED before this check existed.
      const walk = (val, at, real) => {
        if (typeof val === 'string' || typeof val === 'number') {
          if (re.test(String(val))) hits.push({ index, at: at || '(root)' });
        } else if (Array.isArray(val)) {
          val.forEach((v, i) => walk(v, `${at}${shownIndex(i)}`, `${real}[${i}]`));
        } else if (val && typeof val === 'object') {
          Object.keys(val).forEach((k, i) => {
            const shown = shownKey(k, i);
            const here = at ? `${at}.${shown}` : shown;
            const realHere = real ? `${real}.${k}` : k;
            if (re.test(k)) hits.push({ index, at: here });
            // The assembled path ships even when neither end of it matches. Only tested
            // below the root, where it differs from the key already tested above.
            else if (real && re.test(realHere)) hits.push({ index, at: here });
            walk(val[k], here, realHere);
          });
        }
      };
      walk(data, '', '');
    }
    if (hits.length) {
      throw new CliError(
        `segment "${seg.id}": code mode refused — ${hits.length} no-go match(es).\n` +
        hits.slice(0, 10).map(h => `  timing.project.noGoPatterns[${h.index}] matched at ${shownPath(h.at)}`).join('\n') +
        (hits.length > 10 ? `\n  …and ${hits.length - 10} more` : '') +
        '\n\nThe matched text and the pattern are both withheld deliberately — read them in\n' +
        'the source file. A path component shown as `key #N` or `[…]` is one that would\n' +
        'itself have disclosed one of them; N counts keys in JavaScript enumeration order,\n' +
        'which puts integer-like keys first and so is not the order they appear in the file.\n' +
        'Redact the source object or narrow visual.pick; do not render it and rely on it\n' +
        'being small on screen.');
    }
  }

  const paths = [];
  const html = jsonHtml(data, seg.id, '', 0, paths);
  const emitted = new Set(paths);

  // GUARD 2 — a highlight that addresses a path which does not exist must FAIL THE BUILD.
  // Rendering nothing is indistinguishable from a highlight the viewer simply missed, and
  // that failure mode has already cost this pipeline a card: a trigger whose target did not
  // resolve returned null, animated nothing, and reported success. A check that cannot fire
  // looks exactly like a check that passed.
  const near = p => {
    const want = String(p).toLowerCase();
    const best = paths.filter(c => c.toLowerCase().includes(want.split(/[.[]/)[0])).slice(0, 6);
    return best.length ? `\n  did you mean: ${best.join(', ')}` : `\n  available: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ', …' : ''}`;
  };
  for (const [hi, h] of (v.highlights || []).entries()) {
    if (!emitted.has(h.path)) {
      // SCREEN BEFORE QUOTING. A highlight path that does NOT exist was never walked, so
      // the no-go scan has not seen it — and this diagnostic quotes it. Screening it here is
      // what makes the quote below safe: a disclosing path refuses first, by position.
      assertNotDisclosing(String(h.path ?? ''), segWhere(seg, `visual.highlights[${hi}].path`));
      throw new CliError(`segment "${seg.id}": visual.highlights path "${h.path}" does not exist in the rendered JSON.${near(h.path)}`);
    }
  }
  const prefix = `${seg.id}-path-`;
  for (const t of seg.triggers || []) {
    if (typeof t.target === 'string' && t.target.startsWith(prefix)) {
      const ok = paths.some(p => codePathId(seg.id, p) === t.target);
      if (!ok) throw new CliError(`segment "${seg.id}": trigger target "${t.target}" addresses no field in the rendered JSON.${near(t.target.slice(prefix.length))}`);
    }
  }

  const cap = v.caption ? `<figcaption class="codecap">${esc(v.caption, segWhere(seg, 'visual.caption'))}</figcaption>` : '';
  return `<figure class="codewrap el" id="${elId(`${seg.id}-code`, segWhere(seg, 'generated element id'))}"><pre class="codeblock" data-seg="${esc(seg.id, segWhere(seg, 'id'))}">${html}</pre>${cap}</figure>`;
}

function body(seg) { const m = mode(seg); return m === 'footage' ? '' : m === 'code' ? codeBlock(seg) : m === 'diagram' ? diagram(seg) : m === 'live' ? live(seg) : narrative(seg); }

function slide(seg, i) {
  const v = seg.visual || {}, m = mode(seg);
  if (m === 'footage') {
    const f = v.footage || {}, ov = f.overlays || ['lowerThird', 'brandBug'];
    const lt = ov.includes('lowerThird')
      ? `<div class="safe safe-footage"><div id="${elId(`${seg.id}-lt`, segWhere(seg, 'generated element id'))}" class="el lower-third"><div id="${elId(`${seg.id}-label`, segWhere(seg, 'generated element id'))}" class="kicker">${esc(v.kicker || timing.project?.title || timing.project?.slug || 'Demo', segWhere(seg, 'visual.kicker'))}</div><h1 id="${elId(`${seg.id}-title`, segWhere(seg, 'generated element id'))}" class="title lt-title">${esc(v.title || seg.title || '', segWhere(seg, 'visual.title'))}</h1>${v.subtitle ? `<p id="${elId(`${seg.id}-subtitle`, segWhere(seg, 'generated element id'))}" class="subtitle lt-sub">${esc(v.subtitle, segWhere(seg, 'visual.subtitle'))}</p>` : ''}</div></div>`
      : `<div class="safe safe-footage"><div id="${elId(`${seg.id}-label`, segWhere(seg, 'generated element id'))}" class="el kicker" style="visibility:hidden">${esc(v.title || seg.title || 'Demo', segWhere(seg, 'visual.title'))}</div></div>`;
    const bug = ov.includes('brandBug') ? `<div class="brand-bug">${esc(timing.project?.title || 'SizzleCraft', 'project.title')}</div>` : '';
    return `<section id="seg-${i}" class="sl ${i === 0 ? 'on' : ''}" data-mode="footage"><div class="footage-fullbleed">${footageLayer(seg)}</div>${bug}${lt}</section>`;
  }
  return `<section id="seg-${i}" class="sl ${i === 0 ? 'on' : ''}" data-mode="${m}"><div class="safe" style="--fit:1"><div id="${elId(`${seg.id}-label`, segWhere(seg, 'generated element id'))}" class="el kicker">${esc(v.kicker || timing.project?.title || timing.project?.slug || 'Demo', segWhere(seg, 'visual.kicker'))}</div><h1 id="${elId(`${seg.id}-title`, segWhere(seg, 'generated element id'))}" class="el title">${esc(v.title || seg.title || '', segWhere(seg, 'visual.title'))}</h1>${v.subtitle ? `<p id="${elId(`${seg.id}-subtitle`, segWhere(seg, 'generated element id'))}" class="el subtitle">${esc(v.subtitle, segWhere(seg, 'visual.subtitle'))}</p>` : ''}<div class="stage-body ${m}">${body(seg)}</div></div></section>`;
}

// ---- triggers (segment-relative atMs -> absolute seconds) -----------------
function autoTriggers(seg) {
  const v = seg.visual || {}, m = mode(seg), dur = Math.max(1, seg.endMs - seg.startMs);
  const out = [{ atMs: 0, target: `${seg.id}-label`, action: 'rise', withSegment: true }, { atMs: 0, target: `${seg.id}-title`, action: 'rise', withSegment: true }];
  if (v.subtitle) out.push({ atMs: 450, target: `${seg.id}-subtitle`, action: 'rise' });
  if ((seg.triggers || []).some(t => t.target)) return out; // author drives the rest
  if (m === 'diagram') {
    const seq = [...(v.nodes || []).map(n => ({ target: `${seg.id}-node-${n.id}`, action: 'revealNode' })),
                 ...(v.edges || []).map((e, j) => ({ target: generatedElId(seg.id, 'edge', e, j), action: 'drawEdge' }))];
    const step = Math.min(900, (dur * 0.7) / (seq.length || 1));
    seq.forEach((t, k) => out.push({ atMs: Math.round(700 + k * step), target: t.target, action: t.action }));
    // Standard+ engagement: interactive-animation-enabled workflow by default — numbered step badges,
    // flowing edge particles, and an active-path pulse that walks the flow node-by-node so the viewer
    // follows how it works (C-17). `minimal` keeps clean reveals only. All positioned by seek (deterministic).
    const lvl = timing.project?.engagementLevel || timing.intake?.engagementLevel || 'standard';
    if (lvl !== 'minimal') {
      const base = Math.round(700 + seq.length * step) + 400;
      const particles = lvl === 'rich' ? 4 : 2;
      (v.nodes || []).forEach((n, k) => out.push({ atMs: base + k * 120, target: `${seg.id}-node-${n.id}`, action: 'stepBadge', payload: { stepIndex: k + 1 } }));
      (v.edges || []).forEach((e, j) => out.push({ atMs: base + 500 + j * 160, target: generatedElId(seg.id, 'edge', e, j), action: 'flowEdge', payload: { particles } }));
      (v.edges || []).forEach((e, j) => { const eid = generatedElId(seg.id, 'edge', e, j); out.push({ atMs: base + 500 + j * 220, target: eid, action: 'pulsePath', payload: { chain: [`${seg.id}-node-${e.from}`, eid, `${seg.id}-node-${e.to}`] } }); });
    }
  } else if (m === 'code') {
    // The block carries `.el`, so like every other element it stays hidden until something
    // reveals it. Nothing else will: codeFocus targets a FIELD, and showing a field does not
    // show its hidden ancestor. Reveal the block itself first or the whole segment renders
    // blank — with no error, because a trigger that resolves and animates an invisible
    // element reports success exactly like one that worked.
    out.push({ atMs: 300, target: `${seg.id}-code`, action: 'rise' });
    // Walk the authored highlights in order. Each focus releases the previous one, so
    // exactly one field is ever emphasised — the viewer is never asked which box to read.
    const hs = v.highlights || [];
    const step = Math.min(2600, (dur * 0.8) / (hs.length || 1));
    hs.forEach((h, k) => out.push({
      atMs: Math.round(h.atMs ?? (900 + k * step)),
      target: codePathId(seg.id, h.path),
      action: 'codeFocus',
      payload: { label: h.label || '' },
    }));
    if (hs.length) out.push({ atMs: Math.round((hs[hs.length - 1].atMs ?? (900 + (hs.length - 1) * step)) + Math.min(2200, step)), target: `${seg.id}-code`, action: 'codeFocus', payload: { release: true } });
  } else if (m === 'live') {
    let at = 600;
    (v.hotspots || []).forEach(hp => { out.push({ atMs: at, target: `${seg.id}-cursor`, action: 'moveCursor', payload: { toId: `${seg.id}-hotspot-${hp.id}` } }); at += 650; out.push({ atMs: at, target: `${seg.id}-hotspot-${hp.id}`, action: 'click' }); at += 500; });
    (v.fields || []).forEach(f => { out.push({ atMs: at, target: `${seg.id}-cursor`, action: 'moveCursor', payload: { toId: `${seg.id}-field-${f.id}` } }); at += 450; out.push({ atMs: at, target: `${seg.id}-field-${f.id}`, action: 'type' }); at += 900; });
  } else if (m === 'footage') {
    // Real footage plays full-bleed. Reveal the lower-third WRAPPER (it carries `.el`, so it stays
    // hidden until revealed — its title/subtitle children ride inside it). No card/shot reveals: the
    // pixels are real, so we don't composite synthetic content over them.
    if ((v.footage?.overlays || ['lowerThird', 'brandBug']).includes('lowerThird')) out.push({ atMs: 400, target: `${seg.id}-lt`, action: 'rise' });
  } else {
    // Narrative: reveal cards (visual.items) then screenshots (visual.shots). Both use `.el`
    // (visibility:hidden until revealed), so each needs a pop trigger or the panel renders blank.
    const items = (v.items || []).slice(0, 6).map((_, j) => `${seg.id}-item-${j}`);
    const shots = (v.shots || (v.image ? [1] : [])).slice(0, 4).map((_, j) => `${seg.id}-shot-${j}`);
    [...items, ...shots].forEach((target, j) => out.push({ atMs: 500 + j * 260, target, action: 'pop' }));
  }
  // Never let an auto-generated trigger land past the segment's own end: a later-firing effect would
  // run while a LATER slide is active, accumulate hidden-slide overlays, and break seek determinism/QC.
  // (Author-supplied triggers are the author's responsibility and are scheduled elsewhere.)
  const lastMs = Math.max(0, dur - 50);
  out.forEach(o => { if (o.atMs > lastMs) o.atMs = lastMs; });
  return out;
}

const segs = timing.segments.map((s, i) => ({ slide: i + 1, id: s.id, audioStart: s.startMs / 1000, audioEnd: s.endMs / 1000 }));
const trs = guard(() => timing.segments.flatMap((s, i) => {
  // AN EXPLICIT TRIGGER PAYLOAD IS AUTHOR TEXT THAT REACHES A FRAME. It is serialised into
  // `elementTriggers` and the runtime paints `payload.label`/`payload.text` into callouts,
  // rollover tips and step badges. `jsonScript` makes that embedding script-SAFE; it does
  // nothing about whether the text should be on screen, which is a different question and
  // the one this guard exists to answer.
  const screenPayload = (p, where) => {
    // EVERY SERIALISED SCALAR, NOT A LIST OF FIELD NAMES. The whole payload is serialised
    // into `elementTriggers` and ships, so `{extra: "…"}` or `{chain: ["…"]}` reached the
    // artefact while a six-name list looked thorough. A hand-maintained field list is the
    // same rot that has already bitten this task twice in the completeness guard's
    // allowlist — so it is gone, replaced by a walk over what actually gets serialised.
    //
    // The runtime stringifies whatever it paints: MEASURED, `String(['protected-value'])` is
    // `'protected-value'`, so arrays disclose their contents and a `typeof === 'string'`
    // test would miss them — the same coercion bug as `[123]` becoming `/123/i`.
    const walk = (v, at) => {
      if (v == null) return;
      if (Array.isArray(v)) { v.forEach((x, k) => walk(x, `${at}[${k}]`)); return; }
      if (typeof v === 'object') {
        // KEYS SHIP TOO. `{"cortex-supportgraph": "safe"}` serialises the key verbatim into
        // `elementTriggers`, so walking only the values repeats, in the payload, exactly the
        // matching-key defect already fixed in the code-block walk: a key that matches IS the
        // disclosed string.
        //
        // AND THE LOCATION LABEL MUST NOT DISCLOSE EITHER. Building `at` from the keys it
        // walks meant a nested value's refusal printed the assembled key path — with pattern
        // `foo.bar` and payload `{foo:{bar:"…"}}` the message announcing the match contained
        // it. That is the defect this whole task began with, reproduced inside the screen.
        //
        // A key is therefore named only when naming it discloses nothing, and replaced by its
        // ordinal when it would — the same rule, and the same wording, as `shownKey` in the
        // code-block walk. Replacing every key with an ordinal would have been safe too, and
        // would have made every payload refusal unreadable for the sake of the rare one.
        Object.keys(v).forEach((k, ki) => {
          assertNotDisclosing(k, `${at} key #${ki}`);
          const safe = !noGoScreen || !noGoScreen(`${at}.${k}`);
          walk(v[k], safe ? `${at}.${k}` : `${at}.key #${ki}`);
        });
        return;
      }
      assertNotDisclosing(String(v), at);
    };
    walk(p, where);
    return p ?? null;
  };
  const explicit = (s.triggers || []).filter(t => t.target).map((t, ti) => {
    // `action` is serialised as `kind` into `elementTriggers` and ships in the artefact, so
    // it is author text like any other — the payload is not the only part of a trigger that
    // leaves the build.
    // SHAPE, NOT A COERCION — the same rule already applied to `target`. An object `action`
    // screens as `[object Object]`, which discloses nothing, and then ships unchanged as
    // `kind` with its keys intact. Screening a coercion is not screening the value.
    if (t.action != null) {
      if (typeof t.action !== 'string') throw new CliError(`segments[${i}].triggers[${ti}].action must be a string. It is named by position and deliberately not quoted.`);
      assertNotDisclosing(t.action, `segments[${i}].triggers[${ti}].action`);
    }
    return { atMs: Number(t.atMs || 0), target: t.target, action: t.action || 'rise', withSegment: !!(t.withSegment || t.withSlide), payload: screenPayload(t.payload, `segments[${i}].triggers[${ti}].payload`) };
  });
  // EVERY SERIALISED TARGET, NOT ONLY THE ONES THAT BECOME ELEMENTS. `autoTriggers` derives
  // targets like `${seg.id}-title` and `${seg.id}-cursor` and they ship in `elementTriggers`
  // whether or not a matching element is ever rendered — a footage slide without `lowerThird`
  // emits no title element but still emits the trigger. Screening at `elId()` therefore
  // covers only the subset that reaches the DOM. This is the chokepoint where ALL of them,
  // author-written and engine-derived alike, are about to leave the build.
  return [...autoTriggers(s), ...explicit].map(t => {
    assertNotDisclosing(String(t.target ?? ''), `segments[${i}] trigger target`);
    return { t: (s.startMs + Number(t.atMs || 0)) / 1000, s: i + 1, a: t.target, kind: t.action || 'rise', withSegment: !!t.withSegment, payload: screenPayload(t.payload, `segments[${i}] trigger payload`) };
  });
}).map((t, i) => ({ ...t, _i: i }))  // stable source-order index (autoTriggers then explicit, per segment) — the canonical tiebreaker below
  .sort((a, b) => (a.t - b.t) || (a.s - b.s) || (a._i - b._i)));  // strict TOTAL order: triggers that clamp/collapse to the same (t, slide) keep a single deterministic order so non-commutative effects (pulsePath clears, overlays) converge to one final state under parallel-worker seeks

// ---- background themes (user-selectable preset) ---------------------------
const THEMES = {
  midnight: { label: 'Midnight (default) — deep navy + cyan glow', stage: `radial-gradient(circle at 78% 12%,rgba(80,230,255,.20),transparent 30%),linear-gradient(135deg,#0B1020,#0c1a3a)`, size: 'auto', anim: '' },
  light: { label: 'Light — clean Fluent white (dark text)', stage: `radial-gradient(circle at 80% 10%,rgba(0,120,212,.10),transparent 34%),linear-gradient(160deg,#FFFFFF,#F3F2F1)`, size: 'auto', anim: '', vars: '--color-text-primary:#1B1A19;--color-text-secondary:#323130;--color-accent-1:#0078D4;--color-accent-2:#00A4EF;--color-card-bg:rgba(0,90,158,.06);--color-card-border:rgba(0,0,0,.12);--color-bg-primary:#FFFFFF;--color-bg-secondary:#F3F2F1' },
  microsoft: { label: 'Microsoft — light with brand accents (blue + green)', stage: `radial-gradient(circle at 12% 88%,rgba(127,186,0,.10),transparent 40%),radial-gradient(circle at 85% 12%,rgba(0,164,239,.12),transparent 38%),linear-gradient(150deg,#FFFFFF,#EEF3FB)`, size: 'auto', anim: '', vars: '--color-text-primary:#201F1E;--color-text-secondary:#2B2A29;--color-accent-1:#0078D4;--color-accent-2:#7FBA00;--color-card-bg:rgba(0,120,212,.06);--color-card-border:rgba(0,0,0,.12);--color-bg-primary:#FFFFFF;--color-bg-secondary:#EEF3FB' },
  azure: { label: 'Azure — deep azure-blue gradient', stage: `linear-gradient(135deg,#0A2540,#0F4C81,#0078D4,#0A2540)`, size: '300% 300%', anim: '#stage{animation:bgAzure 20s ease infinite}@keyframes bgAzure{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}', vars: '--color-accent-1:#50E6FF;--color-accent-2:#C3F1FF' },
  aurora: { label: 'Aurora — slow-shifting indigo / teal / violet', stage: `linear-gradient(120deg,#0a0e29,#11324a,#1a1040,#0a0e29)`, size: '300% 300%', anim: '#stage{animation:bgAurora 18s ease infinite}@keyframes bgAurora{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}' },
  mesh: { label: 'Mesh — drifting multi-colour blobs', stage: `radial-gradient(40% 50% at 20% 25%,rgba(80,230,255,.22),transparent 60%),radial-gradient(45% 55% at 80% 30%,rgba(155,240,11,.16),transparent 60%),radial-gradient(50% 60% at 50% 88%,rgba(120,90,255,.20),transparent 60%),#0a0f22`, size: '180% 180%,180% 180%,180% 180%,auto', anim: '#stage{animation:bgMesh 26s ease-in-out infinite}@keyframes bgMesh{0%{background-position:0% 0%,100% 0%,50% 100%,0 0}50%{background-position:30% 25%,70% 35%,50% 70%,0 0}100%{background-position:0% 0%,100% 0%,50% 100%,0 0}}' },
  slate: { label: 'Slate — clean minimal neutral (no motion)', stage: `linear-gradient(160deg,#1b2230,#10151f)`, size: 'auto', anim: '' },
  dawn: { label: 'Dawn — warm plum + amber glow', stage: `radial-gradient(circle at 75% 15%,rgba(255,140,90,.18),transparent 35%),linear-gradient(140deg,#1a1030,#2a1430,#0d0a1e)`, size: 'auto', anim: '' }
};
const theme = THEMES[(timing.project?.theme || timing.theme || timing.intake?.theme || 'midnight')] || THEMES.midnight;

// ---- version end-card (Feature B) -----------------------------------------
// One extra brand-styled slide appended after the segments, revealed at contentMs and held through the
// trailing outro (Voice appended matching silence so the -shortest MP4 covers it). NaN/absence-guarded:
// only built when endCard.enabled AND builderVersion is a valid displayable string AND contentMs is finite.
// `validVersion` defensively rejects empty / whitespace / the literal "undefined"/"null" strings so a buggy
// upstream stamp can never surface on screen (graceful-omit — the whole end-card is dropped instead).
const bvRaw = timing.builderVersion;
const validVersion = (typeof bvRaw === 'string' && bvRaw.trim() !== '' && !['undefined','null'].includes(bvRaw.trim().toLowerCase())) ? bvRaw.trim() : null;
const endCardOn = !!(timing.endCard && timing.endCard.enabled !== false && validVersion && Number.isFinite(timing.contentMs));
const endCardIndex = timing.segments.length;                 // 0-based section index => slide number endCardIndex+1
const endCardText = endCardOn ? `${String(timing.endCard.tagline || 'Created by SizzleCraft')} ${validVersion}`.trim() : '';
// No `.el` on the children, so they are visible whenever the slide is `.on` (deterministic — no trigger
// needed). Reuses `.title` (AA-contrast: --color-text-primary adapts to the background mode) + `.safe`
// (safe-area + fitLayout), so visual-qc/a11y pass on any theme/background.
const endCardSlide = guard(() => endCardOn ? `<section id="seg-${endCardIndex}" class="sl" data-mode="endcard"><div class="safe" style="--fit:1"><h1 id="endcard-title" class="title">${esc(endCardText, 'endCard.tagline')}</h1></div></section>` : '');

// ---- styles + runtime -----------------------------------------------------
// The opacity of a code field dimmed around the focused one. The CSS rule and the
// runtime's release fade both read it, so the fade starts from what is on screen.
const CODE_DIM_OPACITY = 0.28;
const css = `:root{--color-bg-primary:#0B1020;--color-bg-secondary:#0c1a3a;--color-accent-1:#50E6FF;--color-accent-2:#9BF00B;--color-text-primary:#fff;--color-text-secondary:#8aa4c8;--color-card-bg:rgba(255,255,255,.04);--color-card-border:rgba(255,255,255,.10);--font-display:'Aptos Display','Segoe UI Variable Display',sans-serif;--font-body:'Aptos','Segoe UI Variable Text',sans-serif}
html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;font-family:var(--font-body);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
#stage{width:${w}px;height:${h}px;position:relative;overflow:hidden;color:var(--color-text-primary);background:${bg ? bg.stage : theme.stage};background-size:${bg ? 'auto' : theme.size}${bg ? ';' + bgVars : (theme.vars ? ';' + theme.vars : '')}}
${bg ? '' : theme.anim}
.sl{position:absolute;inset:0;visibility:hidden;opacity:0;overflow:hidden}.sl.on{visibility:visible;opacity:1}
.safe{position:absolute;left:6%;right:6%;top:6%;bottom:7%;display:grid;gap:calc(var(--fit) * 2vh);align-content:center;justify-items:center;text-align:center}
.el{visibility:hidden}.el.show{visibility:visible}
.kicker{text-transform:uppercase;letter-spacing:.12vw;font-size:calc(var(--fit) * clamp(16px,.8vw,30px));color:var(--color-accent-1)}
.title{font-family:var(--font-display);font-weight:900;font-size:calc(var(--fit) * clamp(44px,3vw,118px));line-height:1;letter-spacing:-.03vw;overflow-wrap:anywhere;max-width:88%}
.subtitle{font-weight:600;font-size:calc(var(--fit) * clamp(24px,1.2vw,52px));line-height:1.25;color:var(--color-text-secondary);overflow-wrap:anywhere;max-width:80%}
.stage-body{width:100%;display:grid;gap:calc(var(--fit) * 1.6vh);justify-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:calc(var(--fit) * 1.2vw);width:100%}
.card{background:var(--color-card-bg);border:1px solid var(--color-card-border);border-radius:.7vw;padding:calc(var(--fit) * 1.2vw);min-width:0}
.card .kicker{color:var(--ca,var(--color-accent-1))}.card .stat{color:var(--ca)}
.stat{font-family:var(--font-display);font-weight:900;font-size:calc(var(--fit) * clamp(28px,2.2vw,72px))}
.body{font-weight:500;font-size:calc(var(--fit) * clamp(18px,1vw,40px));color:var(--color-text-secondary);overflow-wrap:anywhere}
.gradient-text{background:linear-gradient(135deg,var(--color-accent-1),var(--color-accent-2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.shots{display:flex;gap:calc(var(--fit) * 1.2vw);justify-content:center;align-items:center;width:100%}
.shot{margin:0;max-width:100%}.shot img{display:block;max-width:100%;max-height:calc(var(--fit) * 52vh);width:auto;height:auto;object-fit:contain;border-radius:.6vw;border:1px solid var(--color-card-border)}
.shot figcaption{margin-top:.6vh;font-size:calc(var(--fit) * clamp(16px,.9vw,32px));color:var(--color-text-secondary)}
.diagram-svg{width:100%;max-height:calc(var(--fit) * 58vh)}
/* code mode. Highlight is outline + weight + dimming of the rest, never colour alone
   (WCAG 1.4.1) — a viewer who cannot separate the syntax hues still sees which field
   is being discussed, because the box and the contrast difference carry it. */
.codewrap{width:100%;max-width:92%;margin:0}
.codeblock{font-family:ui-monospace,"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace;
  font-size:calc(var(--fit) * 1.55vh);line-height:1.5;text-align:left;
  /* pre-WRAP, not pre. A long string value used to run past the panel and be clipped by
     overflow:hidden — content on screen, cut off mid-sentence, with nothing reporting it.
     Wrapping keeps every character visible across the width. A wrapped continuation
     starts at the block's left edge. There is no hanging indent: text-indent is a single
     offset from the block's edge, not from a line's own indentation, so it cannot tuck a
     continuation under its key at every nesting depth.
     Wrapping moves the overflow from the right edge to the bottom, where max-height still
     clips it. auditLayout checks each block against its own box, so that clip fails the
     audit instead of shipping. */
  white-space:pre-wrap;overflow-wrap:anywhere;
  overflow:hidden;max-height:calc(var(--fit) * 68vh);margin:0;padding:calc(var(--fit) * 2.2vh);
  border-radius:calc(var(--fit) * 1vh);background:var(--code-bg,#f6f7f9);
  border:1px solid var(--code-br,#d6dae0);color:var(--code-fg,#1b1f24)}
.j-key{color:var(--code-key,#8250df);font-weight:600}
.j-str{color:var(--code-str,#0a6b40)}
.j-num{color:var(--code-num,#0550ae)}
.j-bool,.j-null{color:var(--code-num,#0550ae);font-style:italic}
.j-punc{color:var(--code-punc,#6a737d)}
.j-entry{display:inline;border-radius:3px;transition:opacity .35s ease,background .35s ease}
/* a multi-line array/object cannot carry a clean outline as an inline box — it steps
   around the text flow. Block-level containers give the highlight a real rectangle. */
.j-entry.j-block{display:block}
.codeblock.is-dim .j-entry.is-off{opacity:${CODE_DIM_OPACITY}}
.j-entry.is-focus{outline:calc(var(--fit) * 0.34vh) solid var(--code-focus,#1b1f24);
  outline-offset:calc(var(--fit) * 0.5vh);background:var(--code-focus-bg,#fff3c4);
  font-weight:700;opacity:1}
.codecap{margin-top:calc(var(--fit) * 1.4vh);font-size:calc(var(--fit) * 1.7vh);opacity:.75;text-align:left}
.dnode rect{fill:var(--color-card-bg);stroke:var(--ca,var(--color-accent-1));stroke-width:3}
/* Sustained signalling mark. Thicker stroke plus a halo, so it is distinguishable without
   relying on hue (WCAG 1.4.1) and without dimming the rest of the frame.
   emphasize accepts ANY target, not only diagram nodes, so the non-SVG case needs its
   own treatment — otherwise a held mark on a card or a title silently got the scale tween
   and none of the outline this is documented as providing. */
.is-marked rect{stroke-width:9;filter:drop-shadow(0 0 10px rgba(0,0,0,.28))}
.is-marked:not(:has(rect)){outline:calc(var(--fit) * 0.34vh) solid currentColor;
  outline-offset:calc(var(--fit) * 0.6vh);border-radius:calc(var(--fit) * 0.8vh);
  filter:drop-shadow(0 0 10px rgba(0,0,0,.28))}
.is-marked{transition:filter .3s ease}
.dnode foreignObject{overflow:hidden}
.nodelabel{width:100%;height:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;padding:6px 14px;color:var(--color-text-primary);font-family:var(--font-display);font-weight:700;font-size:22px;line-height:1.12;overflow-wrap:anywhere;word-break:break-word;hyphens:auto}
.dedge{fill:none;stroke:var(--ce,var(--color-accent-2));stroke-width:4.5;stroke-linecap:round}
.delabel{fill:var(--color-text-primary);font-size:22px;font-weight:600;paint-order:stroke;stroke:var(--color-bg-primary,#0a0f22);stroke-width:6px;stroke-linejoin:round}#arrow path{fill:var(--color-accent-2)}
/* Diagram slides top-align their title (with padding) so a tall diagram never pushes the title flush to the top edge. */
section[data-mode="diagram"] .safe{align-content:start;top:8%;gap:calc(var(--fit) * 1.4vh)}
.browser{width:100%;max-width:84%;margin:0 auto;border-radius:.9vw;overflow:hidden;background:#0d1426;border:1px solid var(--color-card-border)}
.chrome{display:flex;align-items:center;gap:.6vw;padding:.7vw 1vw;background:#0a1322}
.dot{width:.9vw;height:.9vw;border-radius:50%}.dot.r{background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
.urlbar{flex:1;background:#06101f;border-radius:.4vw;padding:.45vw 1vw;color:var(--color-text-secondary);font-size:calc(var(--fit) * clamp(16px,.95vw,34px))}
.viewport{position:relative;height:calc(var(--fit) * 54vh);background:#06101f}
.liveshot{width:100%;height:100%;object-fit:cover;object-position:top}
.livefield{position:absolute;background:rgba(6,16,31,.92);border:2px solid var(--color-accent-1);border-radius:.4vw;padding:.45vw .8vw;color:#fff;font-size:calc(var(--fit) * clamp(16px,.95vw,34px));text-align:left}
.livelabel{display:block;color:var(--color-text-secondary);font-size:.8em}.liveinput{display:inline-block;min-height:1em;border-left:2px solid var(--color-accent-1);padding-left:.2vw}
.hotspot{position:absolute;transform:translate(-50%,-50%);background:var(--color-accent-2);color:#06101f;padding:.45vw 1vw;border-radius:2vw;font-weight:700;font-size:calc(var(--fit) * clamp(16px,.95vw,34px))}
.hotspot.clicked{box-shadow:0 0 0 .5vw rgba(155,240,11,.35)}
.cursor{position:absolute;left:50%;top:50%;width:2.2vw;height:2.2vw;pointer-events:none;z-index:6;background:no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 2l16 7-6 2-2 6-8-15z' fill='white' stroke='%2306101f' stroke-width='1.2'/%3E%3C/svg%3E")}
/* --- footage (real user clip played full-bleed; frame swapped per capture frame) --- */
.footage-fullbleed{position:absolute;inset:0;background:#000;z-index:0}
.footage-layer{position:absolute;inset:0;background-position:center;background-repeat:no-repeat;background-color:#000}
.safe.safe-footage{align-content:end;justify-items:start;text-align:left;bottom:8%;top:auto;height:auto}
.lower-third{--color-bg-primary:#0B1020;background:linear-gradient(90deg,rgba(4,8,18,.72),rgba(4,8,18,.30) 70%,transparent);border-left:.4vw solid var(--color-accent-1);padding:calc(var(--fit) * 1.4vh) calc(var(--fit) * 1.6vw);border-radius:.3vw;display:grid;gap:.5vh;justify-items:start;max-width:72%;backdrop-filter:blur(2px)}
.lower-third .kicker{color:#fff;opacity:.92}
.lt-title{font-size:calc(var(--fit) * clamp(30px,2vw,66px));color:#fff;max-width:100%;text-align:left;text-shadow:0 2px 10px rgba(0,0,0,.55)}
.lt-sub{font-size:calc(var(--fit) * clamp(18px,1vw,36px));color:#e8f0ff;max-width:100%;text-align:left;text-shadow:0 1px 6px rgba(0,0,0,.5)}
.brand-bug{position:absolute;right:2.4%;top:3.2%;z-index:6;font-family:var(--font-display);font-weight:800;font-size:calc(var(--fit,1) * clamp(16px,.9vw,30px));color:#fff;opacity:.85;letter-spacing:.02vw;text-shadow:0 2px 8px rgba(0,0,0,.65)}
/* --- interactive engagement primitives (spotlight, emphasis, callout, flow, pulse, steps, progress) --- */
.fx-spot{position:absolute;border-radius:1vw;box-shadow:0 0 0 9999px rgba(4,8,18,.62);z-index:5;pointer-events:none}
.callout{position:absolute;max-width:28%;background:rgba(6,16,31,.96);border:2px solid var(--color-accent-1);border-radius:.6vw;padding:.7vw 1vw;color:#fff;font-size:calc(var(--fit) * clamp(16px,.95vw,34px));line-height:1.2;z-index:7;pointer-events:none;box-shadow:0 1vh 3vh rgba(0,0,0,.4)}
.callout::after{content:"";position:absolute;left:1.4vw;bottom:-.7vw;border:.4vw solid transparent;border-top-color:var(--color-accent-1)}
.rollover-tip{position:absolute;background:rgba(6,16,31,.96);border:2px solid var(--color-accent-2);border-radius:.4vw;padding:.4vw .8vw;color:#fff;font-size:calc(var(--fit) * clamp(14px,.85vw,30px));white-space:nowrap;z-index:7;pointer-events:none}
.stepbadge{position:absolute;transform:translate(-40%,-40%);width:2.4vw;height:2.4vw;border-radius:50%;background:var(--color-accent-1);color:#06101f;font-family:var(--font-display);font-weight:900;display:flex;align-items:center;justify-content:center;font-size:calc(var(--fit) * clamp(18px,1.1vw,40px));z-index:6}
.progress{position:absolute;left:6%;right:6%;bottom:3.2%;height:.6vh;background:rgba(255,255,255,.14);border-radius:1vw;overflow:hidden;z-index:6}
.progress > i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--color-accent-1),var(--color-accent-2))}
.flow-dot{r:7px;fill:var(--color-accent-1);offset-distance:0%;animation:flowMove 1.8s linear infinite}
@keyframes flowMove{from{offset-distance:0%}to{offset-distance:100%}}
.pulsing rect,.pulsing.dedge{animation:fxPulse 1.4s ease-in-out infinite}
@keyframes fxPulse{0%,100%{filter:drop-shadow(0 0 0 rgba(80,230,255,0))}50%{stroke-width:7;filter:drop-shadow(0 0 .6vw rgba(80,230,255,.85))}}`;

// ---------------------------------------------------------------------------------------------
// WARNING — EDITING THIS BLOCK
//
// Everything from here to the closing backtick is a TEMPLATE LITERAL in this .mjs file that
// happens to contain client-side JavaScript. Two traps follow from that, and both surface far
// from the edit, at a line number in the GENERATED output:
//
//   1. Most statement lines here are MINIFIED — many statements to a line. A `//` comment added
//      mid-line therefore comments out the rest of THAT LINE, silently deleting working code.
//      Put comments on their own line, as the existing ones are.
//   2. A backtick anywhere in here — including inside a comment — CLOSES this template literal
//      and the file stops parsing as intended. Use '...' or "..." in emitted code; write "backtick"
//      in prose rather than typing one.
//
// `${...}` is build-time interpolation and runs in THIS file's scope, not the browser's.
// ---------------------------------------------------------------------------------------------
const runtime = `
const masterTimeline=gsap.timeline({paused:true});window.masterTimeline=masterTimeline;
// %%SEGMENTS_START%%
const segments=${jsonScript(segs, 2)};
// %%SEGMENTS_END%%
// %%TRIGGERS_START%%
const elementTriggers=${jsonScript(trs, 2)};
// %%TRIGGERS_END%%
const audio=document.getElementById('vo'),LINGER=2;let currentSlide=1;const fired=new Set();
function safeOverflow(safe){return safe.scrollHeight>safe.clientHeight+2||safe.scrollWidth>safe.clientWidth+2;}
window.fitLayout=function(){document.querySelectorAll('.sl').forEach(sl=>{const safe=sl.querySelector('.safe');if(!safe)return;const on=sl.classList.contains('on');sl.classList.add('on');let fit=1;safe.style.setProperty('--fit',fit);let g=0;while(g++<10&&safeOverflow(safe)){fit=Math.max(0.6,fit-0.06);safe.style.setProperty('--fit',fit);}if(!on)sl.classList.remove('on');});};
// A code block is capped at a max-height and clips its own overflow, so the safe area around a
// clipped block still fits. Each block is therefore also checked against its own box.
window.auditLayout=function(){const out=[];document.querySelectorAll('.sl').forEach(sl=>{const safe=sl.querySelector('.safe');if(!safe)return;const on=sl.classList.contains('on');sl.classList.add('on');if(safeOverflow(safe))out.push({id:sl.id,reason:'overflow-after-fit'});sl.querySelectorAll('.codeblock').forEach(cb=>{if(safeOverflow(cb))out.push({id:sl.id,seg:cb.dataset.seg,reason:'codeblock-clipped',scroll:[cb.scrollWidth,cb.scrollHeight],client:[cb.clientWidth,cb.clientHeight]});});if(!on)sl.classList.remove('on');});return out;};
// Legibility guard: flags low-contrast (WCAG-AA) or too-small visible text so a "text not readable"
// regression is caught early. Advisory by default (Recorder logs it); Builder self-checks it at build.
function _lum(r,g,b){const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);}
// This script is emitted from a template literal, which halves every backslash, so the regex
// escapes below are written doubled. Written singly, the colour regex shipped as /rgba?(([^)]+))/,
// which read every red channel as NaN, so no contrast issue was ever reported.
function _rgba(s){const m=String(s).match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const p=m[1].split(/[\\s,\\/]+/).filter(Boolean).map(x=>parseFloat(x));if(p.length<3||!p.slice(0,3).every(Number.isFinite))return null;return [p[0],p[1],p[2],Number.isFinite(p[3])?p[3]:1];}
function _rgb(s){const c=_rgba(s);return c&&c[3]>0?c.slice(0,3):null;}
function _hex(s){const m=String(s).trim().match(/^#?([0-9a-fA-F]{6})$/);if(!m)return null;const h=m[1];return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
// What the text sits on is what the browser paints under it. elementsFromPoint lists the elements that
// hit testing finds at a point, in paint order, top first, so everything after the text in that list
// is painted beneath it, including a backdrop that is not an ancestor, such as a footage layer. Hit
// testing is not painting, though. It skips an element whose pointer-events is none, however much it
// paints, and _hittable lifts that for the length of the audit. It still skips paint that no
// pointer-events value makes hit-testable, which the audit therefore never sees: an inert subtree,
// the contents of an SVG marker, such as a diagram's arrowheads, and paint outside an element's
// border box, such as a box-shadow or an outline. A ::before or ::after box is listed as its element,
// and only the element's own paint is read. Each element paints its background images over its
// background colour. Colours are premultiplied [r,g,b,a] in 0..1, the space CSS gradients
// interpolate in. Composition multiplies candidates, so many translucent layers of many stops could
// stall the audit: past 2^18 combinations _over gives up and returns null, and the backdrop is
// reported as too complex to certify.
function _pm(c){const a=c[3];return [c[0]/255*a,c[1]/255*a,c[2]/255*a,a];}
function _over(top,under){let work=0;for(const p of top)work+=p[3]>=0.999?1:under.length;if(work>262144)return null;const out=[],seen=new Set();for(const p of top){for(const q of (p[3]>=0.999?[[0,0,0,0]]:under)){const k=1-p[3],r=[p[0]+k*q[0],p[1]+k*q[1],p[2]+k*q[2],Math.min(1,p[3]+k*q[3])],key=r.map(v=>Math.round(v*1024)).join();if(!seen.has(key)){seen.add(key);out.push(r);}}}return out;}
function _split(s){const out=[];let d=0,cur='';for(const ch of String(s)){if(ch==='(')d++;else if(ch===')')d--;if(ch===','&&!d){out.push(cur.trim());cur='';}else cur+=ch;}if(cur.trim())out.push(cur.trim());return out;}
function _at(list,i){const a=_split(list);return a[i%a.length]||'';}
// A computed gradient: its head (direction or shape), and its stops as premultiplied colours with
// positions as fractions of the gradient line when they are percentages. Null if any colour is not
// one this audit can read, or if it interpolates in a colour space other than sRGB.
function _grad(img){const m=String(img).match(/^(repeating-)?(linear|radial|conic)-gradient\\((.*)\\)$/);if(!m)return null;const g={rep:!!m[1],kind:m[2],head:'',stops:[],hint:false,pct:true,bad:false};_split(m[3]).forEach((part,i)=>{const c=part.match(/^(rgba?\\([^)]*\\))\\s*(.*)$/);if(!c){if(i===0)g.head=part;else if(/^-?[\\d.]+(%|[a-z]+)?$/.test(part))g.hint=true;else g.bad=true;return;}const col=_rgba(c[1]);if(!col){g.bad=true;return;}const pos=c[2]?c[2].split(/\\s+/):[];if(!pos.length)g.stops.push({c:_pm(col),p:null});pos.forEach(x=>{const v=x.match(/^(-?[\\d.]+)%$/);if(!v)g.pct=false;g.stops.push({c:_pm(col),p:v?parseFloat(v[1])/100:null});});});return g.bad||g.stops.length<2||/(^|\\s)in\\s/.test(g.head)?null:g;}
function _fix(stops){const s=stops.map(x=>({c:x.c,p:x.p}));if(s[0].p==null)s[0].p=0;if(s[s.length-1].p==null)s[s.length-1].p=1;let max=-Infinity;for(const x of s){if(x.p!=null){x.p=Math.max(x.p,max);max=x.p;}}for(let i=1;i<s.length;i++){if(s[i].p!=null)continue;let j=i;while(s[j].p==null)j++;for(let k=i;k<j;k++)s[k].p=s[i-1].p+(s[j].p-s[i-1].p)*(k-i+1)/(j-i+1);i=j;}return s;}
// The colours a gradient takes over [lo,hi] of its line, or over all of it when range is null. Luminance
// can dip between two stops below both (red to green does), so every piece is sampled, with neighbouring
// samples at most 1/16 of full scale apart in any channel. Luminance is convex along a piece, so its
// maximum is always a sample and its minimum is missed by at most 0.0015: about 0.03 of a contrast
// ratio for black text.
function _gradColours(g,range){const s=range?_fix(g.stops):g.stops.map((x,i)=>({c:x.c,p:i})),lo=range?range[0]:0,hi=range?range[1]:s.length-1,out=[],mix=(a,b,f)=>a.map((v,k)=>v+(b[k]-v)*f);if(lo<s[0].p)out.push(s[0].c);if(hi>s[s.length-1].p)out.push(s[s.length-1].c);for(let i=1;i<s.length;i++){const a=s[i-1],b=s[i];if(b.p<lo||a.p>hi)continue;if(b.p<=a.p){out.push(a.c,b.c);continue;}const u=mix(a.c,b.c,(Math.max(lo,a.p)-a.p)/(b.p-a.p)),v=mix(a.c,b.c,(Math.min(hi,b.p)-a.p)/(b.p-a.p));let d=0;for(let k=0;k<3;k++)d=Math.max(d,Math.abs(v[k]-u[k]),Math.abs(v[k]-u[k]-(v[3]-u[3])));const n=Math.max(1,Math.ceil(16*d));for(let j=0;j<=n;j++)out.push(mix(u,v,j/n));}return out;}
// The span of the gradient line that rectangle R covers, in a W x H gradient box. Null when the
// geometry is not one this audit models.
function _tRange(g,W,H,R){const cs=[[R.l,R.t],[R.r,R.t],[R.l,R.b],[R.r,R.b]],h=g.head.trim(),P=(t,len)=>{const v=String(t).match(/^(-?[\\d.]+)(%|px)$/);return v?(v[2]==='%'?parseFloat(v[1])/100*len:parseFloat(v[1])):null;};if(g.kind==='linear'){let A=Math.PI;if(h){const m=h.match(/^(-?[\\d.]+)(deg|rad|turn|grad)$/),to=h.match(/^to ((?:left|right|top|bottom)(?: (?:left|right|top|bottom))?)$/);if(m){const v=parseFloat(m[1]);A=m[2]==='deg'?v*Math.PI/180:m[2]==='rad'?v:m[2]==='turn'?v*2*Math.PI:v*Math.PI/200;}else if(to){const w=to[1].split(' '),sx=w.includes('right')?1:w.includes('left')?-1:0,sy=w.includes('bottom')?1:w.includes('top')?-1:0;A=Math.atan2(sx*(sy?H:1),-sy*(sx?W:1));}else return null;}const dx=Math.sin(A),dy=-Math.cos(A),len=Math.abs(W*dx)+Math.abs(H*dy);if(!(len>0))return null;const ts=cs.map(([x,y])=>((x-W/2)*dx+(y-H/2)*dy)/len+0.5);return [Math.min(...ts),Math.max(...ts)];}if(g.kind!=='radial')return null;const i=h.search(/(^|\\s)at\\s/),shape=(i<0?h:h.slice(0,i)).trim(),pos=i<0?[]:h.slice(i).trim().replace(/^at\\s+/,'').split(/\\s+/);if(pos.length>2)return null;const cx=pos.length?P(pos[0],W):W/2,cy=pos.length>1?P(pos[1],H):H/2;if(cx==null||cy==null)return null;const st=shape?shape.split(/\\s+/):[],kw=st.find(x=>/^(closest|farthest)-(side|corner)$/.test(x))||'farthest-corner',lens=st.filter(x=>P(x,1)!=null);if(st.some(x=>x!=='circle'&&x!=='ellipse'&&x!==kw&&!lens.includes(x)))return null;const circle=st.includes('circle')||lens.length===1,L=Math.abs(cx),Rt=Math.abs(W-cx),T=Math.abs(cy),B=Math.abs(H-cy);let rx,ry;if(lens.length){if(circle){if(lens.length!==1||!/px$/.test(lens[0]))return null;rx=ry=parseFloat(lens[0]);}else{if(lens.length!==2)return null;rx=P(lens[0],W);ry=P(lens[1],H);}}else{const f=kw.startsWith('farthest')?Math.max:Math.min;if(kw.endsWith('side')){rx=circle?f(L,Rt,T,B):f(L,Rt);ry=circle?rx:f(T,B);}else if(circle){rx=ry=f(Math.hypot(L,T),Math.hypot(Rt,T),Math.hypot(L,B),Math.hypot(Rt,B));}else{rx=f(L,Rt)*Math.SQRT2;ry=f(T,B)*Math.SQRT2;}}if(!(rx>0&&ry>0))return null;const nx=Math.min(Math.max(cx,R.l),R.r),ny=Math.min(Math.max(cy,R.t),R.b);return [Math.hypot((nx-cx)/rx,(ny-cy)/ry),Math.max(...cs.map(([x,y])=>Math.hypot((x-cx)/rx,(y-cy)/ry)))];}
// A background-position or -size component as a percentage plus a length, so values in different units
// interpolate the way calc() does. Null for anything else.
function _lp(v){v=String(v).trim();if(v==='0')return {p:0,x:0};let m=v.match(/^(-?[\\d.]+)(%|px)$/);if(m)return m[2]==='%'?{p:+m[1],x:0}:{p:0,x:+m[1]};m=v.match(/^calc\\((-?[\\d.]+)% ([+-]) ([\\d.]+)px\\)$/);return m?{p:+m[1],x:(m[2]==='-'?-1:1)*m[3]}:null;}
// Where an element's backgrounds can be: steps [from, to] of positions ([x list, y list]) between which
// they move in a straight line. Not animated, the one step is its current position. Animated, each
// keyframe to the next in 16 steps, since an easing that does not overshoot keeps the backgrounds on
// the line between two keyframes. Null when an animation moves them in a way this audit does not model.
function _bgStates(n,cs){const pos=(x,y)=>{const X=_split(x).map(_lp),Y=_split(y).map(_lp);return X.length&&Y.length&&X.every(Boolean)&&Y.every(Boolean)?[X,Y]:null;},ease=s=>/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|steps\\(.*\\))$/.test(s)||(m=>!!m&&+m[2]>=0&&+m[2]<=1&&+m[4]>=0&&+m[4]<=1)(String(s).match(/^cubic-bezier\\(([^,]+),([^,]+),([^,]+),([^,]+)\\)$/));const an=(n.getAnimations?n.getAnimations():[]).filter(a=>a.effect&&a.effect.getKeyframes&&a.effect.getKeyframes().some(k=>Object.keys(k).some(p=>/^background/.test(p))));if(!an.length){const s=pos(cs.backgroundPositionX,cs.backgroundPositionY);return s&&[[s,s]];}if(an.length>1)return null;const e=an[0].effect,tm=e.getTiming(),kf=e.getKeyframes(),ks=[];if(tm.easing!=='linear'||tm.iterations!==Infinity||tm.delay>0||e.composite!=='replace'||kf.length<2||kf[0].computedOffset!==0||kf[kf.length-1].computedOffset!==1)return null;for(const k of kf){if(Object.keys(k).some(p=>!/^(offset|computedOffset|easing|composite|backgroundPositionX|backgroundPositionY)$/.test(p))||!ease(k.easing)||!/^(auto|replace)$/.test(k.composite))return null;for(const p of ['backgroundPositionX','backgroundPositionY'])if((p in k)!==(p in kf[0]))return null;const s=pos('backgroundPositionX' in k?k.backgroundPositionX:cs.backgroundPositionX,'backgroundPositionY' in k?k.backgroundPositionY:cs.backgroundPositionY);if(!s||(ks.length&&(s[0].length!==ks[0][0].length||s[1].length!==ks[0][1].length)))return null;ks.push(s);}const mix=(a,b,f)=>a.map((L,d)=>L.map((c,j)=>({p:c.p+(b[d][j].p-c.p)*f,x:c.x+(b[d][j].x-c.x)*f}))),out=[];for(let i=1;i<ks.length;i++)for(let j=0;j<16;j++)out.push([mix(ks[i-1],ks[i],j/16),mix(ks[i-1],ks[i],(j+1)/16)]);return out;}
// The colours of gradient layer i behind the text during one step iv: the text box relative to the
// layer's tile at both ends of the step, and everything between, which their bounding box contains.
// Without a step, or where the geometry is not one this audit models, all of the gradient's colours;
// a layer that does not repeat may then also leave the text over whatever is below it.
function _gradCands(g,n,cs,i,tr,iv){let range=null;if(iv&&!g.rep&&!g.hint&&g.pct&&_at(cs.backgroundOrigin,i)==='padding-box'&&_at(cs.backgroundAttachment,i)==='scroll'&&n.offsetWidth){const b=n.getBoundingClientRect(),W=n.clientWidth,H=n.clientHeight,sz=_at(cs.backgroundSize,i).split(' '),fit=/^(cover|contain)$/.test(sz[0]),dim=(v,len)=>{if(fit||!v||v==='auto')return len;const c=_lp(v);return c?c.p/100*len+c.x:NaN;},Wi=dim(sz[0],W),Hi=dim(sz[1],H);if(W>0&&H>0&&Wi>0&&Hi>0&&Math.abs(b.width-n.offsetWidth)<1&&Math.abs(b.height-n.offsetHeight)<1){const x0=b.left+n.clientLeft,y0=b.top+n.clientTop,R={l:Math.max(0,tr.left-x0),t:Math.max(0,tr.top-y0),r:Math.min(W,tr.right-x0),b:Math.min(H,tr.bottom-y0)},at=s=>{const X=s[0][i%s[0].length],Y=s[1][i%s[1].length],ox=X.p/100*(W-Wi)+X.x,oy=Y.p/100*(H-Hi)+Y.x;return {l:R.l-ox,t:R.t-oy,r:R.r-ox,b:R.b-oy};},A=at(iv[0]),B=at(iv[1]),U={l:Math.min(A.l,B.l),t:Math.min(A.t,B.t),r:Math.max(A.r,B.r),b:Math.max(A.b,B.b)};if(R.l<=R.r&&R.t<=R.b&&U.l>=-0.5&&U.t>=-0.5&&U.r<=Wi+0.5&&U.b<=Hi+0.5)range=_tRange(g,Wi,Hi,U);}}const out=_gradColours(g,range);if(!range&&!/^repeat( repeat)?$/.test(_at(cs.backgroundRepeat,i)))out.push([0,0,0,0]);return out;}
// One element's own paint, top layer first, as candidate colours. A string names a backdrop whose
// pixels this audit cannot read. An SVG text halo (paint-order:stroke) is painted directly under
// the glyphs, so it is their backdrop. Gradient layers are composed one step at a time, so colours
// that two moving layers never show together are never combined.
function _paint(n,el,tr){if(n.classList&&n.classList.contains('footage-layer'))return 'footage';if(/^(img|video|canvas|iframe|object|embed|image)$/i.test(n.tagName))return 'image';const cs=getComputedStyle(n),op=parseFloat(cs.opacity),top=[],grads=[],under=[],alpha=(c,o)=>{const k=parseFloat(o);c[3]*=Number.isFinite(k)?k:1;return _pm(c);};if(!(op>0))return [];if(n===el&&/^stroke/.test(cs.paintOrder)&&cs.stroke!=='none'&&parseFloat(cs.strokeWidth)>0){const s=_rgba(cs.stroke);if(!s)return 'paint-server';top.push([alpha(s,cs.strokeOpacity)]);}const imgs=_split(cs.backgroundImage);for(let i=0;i<imgs.length;i++){if(imgs[i]==='none')continue;if(!/gradient\\(/.test(imgs[i]))return 'image';const g=_grad(imgs[i]);if(!g)return 'gradient';grads.push([g,i]);}const bg=_rgba(cs.backgroundColor);if(!bg)return 'colour';if(bg[3]>0)under.push([_pm(bg)]);if(typeof SVGGeometryElement!=='undefined'&&n instanceof SVGGeometryElement){const alts=[];for(const [p,o] of [[cs.fill,cs.fillOpacity],[cs.stroke,cs.strokeOpacity]]){if(p==='none')continue;const c=_rgba(p);if(!c)return 'paint-server';alts.push(alpha(c,o));}if(alts.length)under.push(alts);}const seen=new Set(),paint=[];for(const iv of (grads.length&&_bgStates(n,cs))||[null]){let p=[[0,0,0,0]];for(const l of [...top,...grads.map(([g,i])=>_gradCands(g,n,cs,i,tr,iv)),...under]){p=_over(p,l);if(!p)return 'complex';}for(const c of p){const k=c.map(v=>Math.round(v*1024)).join();if(!seen.has(k)){seen.add(k);paint.push(c);}}if(paint.length>16384)return 'complex';}return op<1?paint.map(c=>c.map(v=>v*op)):paint;}
// The element stacks under the text at nine points across it. A point that misses the text, such as
// a gap between SVG glyphs, says nothing about what is under it: what it lists may be painted above
// the text or below it, and without the text in the list nothing separates the two. So when no point
// on screen lands on the text, its backdrop is unsampled, a reason in place of a stack. A box with no
// area paints no text, and a box none of whose points is on screen is taken to be out of the frame.
function _stacks(el){const r=el.getBoundingClientRect(),hit=[],add=(a,st)=>{if(!a.some(o=>o.length===st.length&&o.every((n,k)=>n===st[k])))a.push(st);};let seen=false;if(!(r.width>0&&r.height>0))return hit;for(const fy of [.15,.5,.85])for(const fx of [.15,.5,.85]){const hits=document.elementsFromPoint(r.left+r.width*fx,r.top+r.height*fy),i=hits.indexOf(el);if(i>=0)add(hit,hits.slice(i));else if(hits.length)seen=true;}return hit.length||!seen?hit:['unsampled'];}
// Every colour that can be behind the text in one stack, or the reason none can be certified. The
// stacks under one text share elements, and memo keeps each element's paint for that text.
function _backdrop(st,el,tr,memo){if(typeof st==='string')return st;let acc=[[0,0,0,0]];for(const n of st){let p=memo.get(n);if(p===undefined){p=_paint(n,el,tr);memo.set(n,p);}if(typeof p==='string')return p;if(!p.length)continue;acc=_over(acc,p);if(!acc||acc.length>16384)return 'complex';if(acc.every(c=>c[3]>=0.999))return acc.map(c=>[c[0]/c[3]*255,c[1]/c[3]*255,c[2]/c[3]*255]);}return 'unknown';}
// Makes every element that is not hit-testable by its own pointer-events, including one that only
// inherits none, hit-testable with an inline pointer-events:auto !important, which outranks every
// author declaration, inline or not, and every animation. On SVG, auto hits a shape only where it
// paints. Returns what puts each style attribute back exactly as it was. Chrome writes a style
// attribute set through el.style only when it is next read, and removing it before then leaves an
// empty one behind, so an attribute that was absent is set empty and then removed. All reads come
// before any write, so style is recomputed once, and the audit is synchronous, so no frame is
// painted between.
function _hittable(){const saved=[];for(const n of document.querySelectorAll('*'))if(n.style&&getComputedStyle(n).pointerEvents!=='auto')saved.push([n,n.getAttribute('style')]);for(const [n] of saved)n.style.setProperty('pointer-events','auto','important');return ()=>{for(const [n,s] of saved){n.setAttribute('style',s===null?'':s);if(s===null)n.removeAttribute('style');}};}
window.auditLegibility=function(){const out=[];const stageH=(document.getElementById('stage')||document.body).clientHeight||1080;const minPx=Math.max(14,stageH*0.014);const restore=_hittable();try{document.querySelectorAll('.sl.on .kicker,.sl.on .title,.sl.on .subtitle,.sl.on .body,.sl.on .label,.sl.on .value,.sl.on .text,.sl.on .lt-title,.sl.on .lt-sub,.sl.on svg text').forEach(el=>{if(!el.textContent.trim())return;const eid=el.id||el.className||el.tagName.toLowerCase();const cs=getComputedStyle(el);if(cs.visibility==='hidden'||parseFloat(cs.opacity)<0.5)return;const fg=_rgb(cs.color)||_rgb(cs.fill)||_hex(cs.fill);const px=parseFloat(cs.fontSize);if(px&&px<minPx)out.push({id:eid,reason:'text-too-small',px:Math.round(px),minPx:Math.round(minPx)});if(!fg)return;const fw=cs.fontWeight==='bold'?700:(cs.fontWeight==='normal'?400:(parseInt(cs.fontWeight,10)||400));const large=px>=stageH*0.033||(fw>=600&&px>=stageH*0.026);const need=large?3.0:4.5;const tr=el.getBoundingClientRect(),L1=_lum(...fg);let worst=Infinity,unverified=null;const memo=new Map();for(const st of _stacks(el)){const b=_backdrop(st,el,tr,memo);if(typeof b==='string'){unverified=unverified||b;continue;}for(const c of b){const L2=_lum(...c);worst=Math.min(worst,(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05));}}if(worst<need)out.push({id:eid,reason:'low-contrast',ratio:Math.floor(worst*10)/10,need});else if(unverified)out.push({id:eid,reason:'contrast-unverified',backdrop:unverified});});}finally{restore();}return out;};
function show(el){if(el)el.classList.add('show');}
// Deterministic effect driver: GSAP flourishes must be a pure function of VIDEO time, not wall-clock, so
// seek(t)/frame capture yields the same pixels regardless of worker scheduling. Each effect tween is
// created PAUSED and registered with its trigger's absolute start time (__curT); __syncTweens(t) then
// sets every registered tween's progress from (t - t0)/duration. This is what actually makes the
// "seek-safe determinism" guarantee hold (the empty masterTimeline never drove these tweens).
const __drv=[];let __curT=0;
function __sch(tw){const t0=__curT,dur=tw.totalDuration()||0.001;tw.pause();__drv.push({tw,t0,d:dur});tw.totalProgress(Math.max(0,Math.min(1,((window.__t||0)-t0)/dur)));return tw;}
window.__syncTweens=function(t){for(const e of __drv)e.tw.totalProgress(e.d>0?Math.max(0,Math.min(1,(t-e.t0)/e.d)):1);};
function reveal(id,kind){const el=document.getElementById(id);if(!el||fired.has(id))return;fired.add(id);show(el);const p={rise:{y:'0.8vw'},pop:{scale:.82,opacity:0},left:{x:'-1.4vw'},flip:{rotateY:75,transformPerspective:900}}[kind]||{y:'0.8vw'};__sch(gsap.fromTo(el,p,{x:0,y:0,scale:1,opacity:1,rotateY:0,duration:.55,ease:'power3.out'}));}
function drawEdge(id){const el=document.getElementById(id);if(!el||fired.has(id))return;fired.add(id);show(el);const lb=document.getElementById(id.replace('-edge-','-edgelabel-'));if(lb)show(lb);try{const len=el.getTotalLength();__sch(gsap.fromTo(el,{strokeDasharray:len,strokeDashoffset:len},{strokeDashoffset:0,duration:.7,ease:'power2.inOut'}));}catch(e){}}
function moveCursor(cursorId,toId){const c=document.getElementById(cursorId),t=document.getElementById(toId);if(!c||!t)return;show(c);const vp=c.parentElement.getBoundingClientRect(),r=t.getBoundingClientRect();__sch(gsap.to(c,{left:(r.left-vp.left+r.width/2)+'px',top:(r.top-vp.top+r.height/2)+'px',duration:.6,ease:'power2.inOut'}));}
function clickAt(id){const t=document.getElementById(id);if(!t)return;show(t);t.classList.add('clicked');__sch(gsap.fromTo(t,{scale:1},{scale:.95,duration:.12,yoyo:true,repeat:1}));}
function typeInto(id,tr){const f=document.getElementById(id);if(!f)return;show(f);const inp=f.querySelector('.liveinput');if(!inp)return;const txt=inp.getAttribute('data-text')||'';const startT=tr?tr.t:0,cps=26;const k=Math.max(0,Math.min(txt.length,Math.round(((window.__t||0)-startT)*cps)));inp.textContent=txt.slice(0,k);}
// --- interactive engagement effects (create-once; guarded so per-frame seek stays deterministic) ---
const fxDone=new Set();function once(tr){const k=tr.kind+'|'+tr.a+'|'+tr.t;if(fxDone.has(k))return false;fxDone.add(k);return true;}
function fxHost(tr,id){const el=id&&document.getElementById(id);return (el&&el.closest('.sl'))||document.getElementById('seg-'+((tr.s||1)-1));}
function fxRect(id){const el=document.getElementById(id);if(!el)return null;const host=el.closest('.sl');if(!host)return null;const hb=host.getBoundingClientRect(),r=el.getBoundingClientRect();return{el,host,hb,x:r.left-hb.left,y:r.top-hb.top,w:r.width,h:r.height};}
function spotlight(id,tr){const host=fxHost(tr,id);if(!host)return;if(tr.payload&&tr.payload.release){host.querySelectorAll('.fx-spot').forEach(n=>n.remove());return;}const r=fxRect(id);if(!r)return;show(r.el);const pad=Math.min(r.w,r.h)*0.25+14,d=document.createElement('div');d.className='fx-spot';d.style.left=(r.x-pad)+'px';d.style.top=(r.y-pad)+'px';d.style.width=(r.w+2*pad)+'px';d.style.height=(r.h+2*pad)+'px';host.appendChild(d);__sch(gsap.fromTo(d,{opacity:0},{opacity:1,duration:.4}));}
function codeFocus(id,tr){const p=tr.payload||{};if(p.release){document.querySelectorAll('.codeblock.is-dim').forEach(b=>{
/* the dimmed fields fade back over video time; dropping the classes alone jumped them to full
   opacity in one frame. Only a field that shows the dim fades from it. A field with an inline
   opacity is held there by its focus tween, and starting it from the dim value would flicker it. */
const off=Array.from(b.querySelectorAll('.j-entry.is-off')).filter(n=>!n.style.opacity);b.classList.remove('is-dim');b.querySelectorAll('.j-entry').forEach(n=>n.classList.remove('is-off','is-focus'));if(off.length)__sch(gsap.fromTo(off,{opacity:${CODE_DIM_OPACITY}},{opacity:1,duration:.45,ease:'power2.out',clearProps:'opacity'}));});return;}
const el=document.getElementById(id);if(!el)return;const blk=el.closest('.codeblock');if(!blk)return;show(blk);
/* showing a field cannot show its hidden .el ancestor, so walk up */
for(let a=blk;a;a=a.parentElement){if(a.classList&&a.classList.contains('el'))show(a);if(a.classList&&a.classList.contains('sl'))break;}
blk.classList.add('is-dim');
blk.querySelectorAll('.j-entry').forEach(n=>{n.classList.remove('is-focus');n.classList.add('is-off');});
// the focused field and everything inside it stay lit; so do its ancestors, or a nested
// field would sit inside a dimmed parent and read as disabled rather than as context.
el.classList.remove('is-off');el.classList.add('is-focus');
el.querySelectorAll('.j-entry').forEach(n=>n.classList.remove('is-off'));
for(let a=el.parentElement;a&&a!==blk;a=a.parentElement){if(a.classList.contains('j-entry'))a.classList.remove('is-off');}
__sch(gsap.fromTo(el,{opacity:.55},{opacity:1,duration:.45,ease:'power2.out'}));}
function emphasize(id,tr){const el=document.getElementById(id);if(!el)return;show(el);const p=tr.payload||{};const sc=p.scale||1.12;
/* hold: a SUSTAINED local mark instead of a transient pulse. Replaces the full-screen
   spotlight, which dimmed everything and read as a glitch. Mayer signalling wants the
   viewer's eye directed to the narrated element; it does not want the rest of the frame
   extinguished. Outline plus a small scale, nothing else touched. */
if(p.hold){document.querySelectorAll('.is-marked').forEach(n=>{if(n!==el)n.classList.remove('is-marked');});el.classList.add('is-marked');
__sch(gsap.fromTo(el,{scale:1},{scale:sc,duration:.45,ease:'power2.out',transformOrigin:'center center'}));return;}
__sch(gsap.fromTo(el,{scale:1},{scale:sc,duration:.5,yoyo:true,repeat:1,ease:'power2.inOut',transformOrigin:'center center'}));}
function zoomFocus(id,tr){const p=tr.payload||{},host=fxHost(tr,id),surf=host&&(host.querySelector('.viewport')||host.querySelector('.diagram-svg')||host.querySelector('.stage-body'));if(!surf)return;if(p.release){__sch(gsap.to(surf,{scale:1,x:0,y:0,duration:.6,ease:'power2.inOut'}));return;}const sc=p.scale||1.4;let ox=0,oy=0;const r=fxRect(id);if(r){const cb=surf.getBoundingClientRect(),cx=cb.left-r.hb.left+cb.width/2,cy=cb.top-r.hb.top+cb.height/2;ox=(cx-(r.x+r.w/2))*sc;oy=(cy-(r.y+r.h/2))*sc;}__sch(gsap.to(surf,{scale:sc,x:ox,y:oy,duration:.7,ease:'power2.inOut',transformOrigin:'center center'}));}
function callout(id,tr){const r=fxRect(id);if(!r)return;show(r.el);const c=document.createElement('div');c.className='callout';c.textContent=(tr.payload&&tr.payload.text)?String(tr.payload.text):'';c.style.left=Math.max(0,r.x)+'px';c.style.top=Math.max(0,r.y-16)+'px';c.style.transform='translateY(-100%)';r.host.appendChild(c);__sch(gsap.fromTo(c,{opacity:0,y:12},{opacity:1,y:0,duration:.45,ease:'power3.out'}));}
function hover(cursorId,tr){const toId=tr.payload&&tr.payload.toId;if(toId)moveCursor(cursorId,toId);const r=toId&&fxRect(toId);if(!r)return;document.querySelectorAll('.hovered').forEach(n=>n.classList.remove('hovered'));document.querySelectorAll('.rollover-tip').forEach(n=>n.remove());r.el.classList.add('hovered');if(tr.payload&&tr.payload.text){const t=document.createElement('div');t.className='rollover-tip';t.textContent=String(tr.payload.text);t.style.left=r.x+'px';t.style.top=(r.y+r.h+8)+'px';r.host.appendChild(t);__sch(gsap.fromTo(t,{opacity:0},{opacity:1,duration:.35}));}}
function flowEdge(id,tr){const path=document.getElementById(id);if(!path)return;show(path);const svg=path.closest('svg');if(!svg)return;const d=path.getAttribute('d'),n=Math.max(1,(tr.payload&&tr.payload.particles)||3),r=(tr.payload&&tr.payload.r)||7;for(let i=0;i<n;i++){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('class','flow-dot');dot.setAttribute('r',String(r));dot.style.offsetPath="path('"+d+"')";dot.style.animationDelay=(-(i*(1.8/n)))+'s';svg.appendChild(dot);}if(window.__sizzleAnim&&window.__sizzleAnim.scan)window.__sizzleAnim.scan();}
function pulsePath(tr){const chain=(tr.payload&&tr.payload.chain&&tr.payload.chain.length)?tr.payload.chain:[tr.a];const first=document.getElementById(chain[0]);const scope=(first&&first.closest('.sl'))||document;scope.querySelectorAll('.pulsing').forEach(el=>el.classList.remove('pulsing'));chain.forEach(id=>{const el=document.getElementById(id);if(el){show(el);el.classList.add('pulsing');}});if(window.__sizzleAnim&&window.__sizzleAnim.scan)window.__sizzleAnim.scan();}
function stepBadge(id,tr){const r=fxRect(id);if(!r)return;show(r.el);const b=document.createElement('div');b.className='stepbadge';b.textContent=String((tr.payload&&tr.payload.stepIndex)||'');b.style.left=r.x+'px';b.style.top=r.y+'px';r.host.appendChild(b);__sch(gsap.fromTo(b,{scale:0},{scale:1,duration:.4,ease:'back.out(2)'}));}
function progressBar(tr){const host=fxHost(tr,null);if(!host)return;let bar=host.querySelector('.progress');if(!bar){bar=document.createElement('div');bar.className='progress';const i=document.createElement('i');bar.appendChild(i);host.appendChild(bar);}const v=Math.max(0,Math.min(1,(tr.payload&&tr.payload.value!=null)?tr.payload.value:1));__sch(gsap.to(bar.querySelector('i'),{width:(v*100)+'%',duration:.5,ease:'power2.out'}));}
function apply(tr){__curT=tr.t||0;switch(tr.kind){case 'drawEdge':return drawEdge(tr.a);case 'revealNode':return reveal(tr.a,'pop');case 'moveCursor':return void(once(tr)&&moveCursor(tr.a,(tr.payload&&tr.payload.toId)||tr.a));case 'hover':case 'rollover':return void(once(tr)&&hover(tr.a,tr));case 'click':case 'clickRipple':return void(once(tr)&&clickAt(tr.a));case 'type':return typeInto(tr.a,tr);case 'spotlight':return void(once(tr)&&spotlight(tr.a,tr));case 'emphasize':return void(once(tr)&&emphasize(tr.a,tr));case 'codeFocus':return void(once(tr)&&codeFocus(tr.a,tr));case 'zoomFocus':return void(once(tr)&&zoomFocus(tr.a,tr));case 'callout':return void(once(tr)&&callout(tr.a,tr));case 'flowEdge':return void(once(tr)&&flowEdge(tr.a,tr));case 'pulsePath':return void(once(tr)&&pulsePath(tr));case 'stepBadge':return void(once(tr)&&stepBadge(tr.a,tr));case 'progress':return void(once(tr)&&progressBar(tr));default:return reveal(tr.a,tr.kind);}}
// A slide lingers LINGER seconds past its narration, but never into the next narration. Uncapped,
// a seam shorter than LINGER showed the next slide late, after its opening triggers had fired unseen.
const slideShowTimes=[{slide:1,showAt:0}];for(let i=0;i<segments.length-1;i++)slideShowTimes.push({slide:segments[i+1].slide,showAt:Math.min(segments[i].audioEnd+LINGER,segments[i+1].audioStart)});${endCardOn ? `slideShowTimes.push({slide:${endCardIndex + 1},showAt:${jsonScript(timing.contentMs / 1000)}});` : ''}
// --- footage frame injection (real user clip). Maps absolute time -> extracted frame file and swaps
// the full-bleed background. Pure index->file map so per-frame seek stays deterministic + resumable.
// Preview calls it fire-and-forget from fireTriggersUpTo; the capture script awaits it before screenshot.
window.__footage=${hasFootage};
window.__setFootageFrame=function(absMs){const ls=document.querySelectorAll('.footage-layer'),ps=[];ls.forEach(el=>{const s=+el.dataset.segstart,e=+el.dataset.segend,dir=el.dataset.framedir;if(!dir||!Number.isFinite(s)||!Number.isFinite(e))return;if(absMs<s-1||absMs>e+1)return;const fps=+el.dataset.fps||30,count=Math.max(1,+el.dataset.framecount||1),start=+el.dataset.startms||0;let idx=Math.round(((absMs-s)+start)/1000*fps)+1;idx=Math.max(1,Math.min(count,idx));const url=dir+'/frame_'+String(idx).padStart(5,'0')+'.jpg';if(el.dataset.cur===url)return;if(el.__pendingUrl===url&&el.__pendingPromise){ps.push(el.__pendingPromise);return;}const p=new Promise(res=>{const im=new Image();im.onload=()=>res(true);im.onerror=()=>res(false);im.src=url;}).then(ok=>{if(ok){el.style.backgroundImage='url("'+url+'")';el.dataset.cur=url;}if(el.__pendingUrl===url){el.__pendingUrl=null;el.__pendingPromise=null;}return ok;});el.__pendingUrl=url;el.__pendingPromise=p;ps.push(p);});return Promise.all(ps);};
function setSlide(n){if(n===currentSlide)return;document.querySelectorAll('.sl').forEach(s=>s.classList.remove('on'));document.getElementById('seg-'+(n-1))?.classList.add('on');currentSlide=n;elementTriggers.filter(t=>t.s===n&&t.withSegment).forEach(apply);}
let __lastFireT=0;
// Seek-safety: on a backwards / non-monotonic seek (preview scrub), cumulative state (fired, fxDone,
// __drv tweens) and injected overlays (.fx-spot/.callout/.rollover-tip/.stepbadge/.flow-dot/.progress)
// would otherwise persist and once()/fired would short-circuit re-creation. Reset them, then re-apply
// triggers up to the new time so the frame is reconstructed deterministically from scratch.
function __resetSeekState(){fired.clear();fxDone.clear();for(const e of __drv){try{e.tw.kill();}catch(_){}}__drv.length=0;document.querySelectorAll('.fx-spot,.callout,.rollover-tip,.stepbadge,.flow-dot,.progress').forEach(n=>n.remove());document.querySelectorAll('.show,.clicked,.hovered,.pulsing,.is-marked,.is-dim,.is-off,.is-focus').forEach(el=>el.classList.remove('show','clicked','hovered','pulsing','is-marked','is-dim','is-off','is-focus'));try{gsap.set('*',{clearProps:'transform,opacity'});}catch(_){}currentSlide=0;}
function fireTriggersUpTo(time){if(time<__lastFireT-0.0005)__resetSeekState();__lastFireT=time;window.__t=time;let target=1;for(const s of slideShowTimes)if(time>=s.showAt)target=s.slide;setSlide(target);for(const tr of elementTriggers)if(time>=tr.t)apply(tr);window.__syncTweens(time);if(window.__footage)window.__setFootageFrame(time*1000);}
window.fireTriggersUpTo=fireTriggersUpTo;
// Deterministic per-frame visual-state signature for capture-time dedup (dedupHolds). Two frames are
// pixel-identical iff their computed visual state is identical; __frameSig(frameNo) serialises EVERY
// source of per-frame pixel change so the recorder may hardlink (reuse) a settled frame ONLY when the
// signature is unchanged. CORRECTNESS INVARIANT: any omitted pixel source => false dedup => corruption.
// MOTION GUARD: if anything is mid-motion at this instant (an active GSAP tween, a live t-dependent CSS
// animation — themes/flow-dots/pulses are captured PAUSED with a rewritten animation-delay, so we test
// applicability via animationName, NOT play-state — or any animated raster/SMIL media that advances on
// the browser clock), we return a frame-unique token so those frames are NEVER deduped. Only fully
// settled, no-motion spans (static themes, no active tween, no animated media) can be held.
function __sigVis(el){if(!el)return false;const cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none'||parseFloat(cs.opacity)===0)return false;return el.getClientRects().length>0;}
function __sigActiveTween(){for(const e of __drv){const p=e.d>0?((window.__t||0)-e.t0)/e.d:1;if(p>0.0001&&p<0.9999)return true;}return false;}
function __sigLiveCssAnim(){if(!window.__sizzleAnim||!window.__sizzleAnim.els)return false;for(const el of window.__sizzleAnim.els()){if(getComputedStyle(el).animationName!=='none'&&__sigVis(el))return true;}return false;}
function __sigLiveMedia(){for(const im of document.querySelectorAll('.sl.on img')){if(!__sigVis(im))continue;const s=(im.currentSrc||im.src||'').split('?')[0].split('#')[0].toLowerCase();if(/\\.(gif|apng|webp|svg)$/.test(s))return true;}for(const a of document.querySelectorAll('.sl.on animate,.sl.on animateTransform,.sl.on animateMotion,.sl.on set')){if(__sigVis(a.ownerSVGElement||a))return true;}return false;}
window.__frameSig=function(frameNo){
  if(__sigActiveTween()||__sigLiveCssAnim()||__sigLiveMedia())return 'm'+frameNo; // in-motion: never hold
  const p=[],on=document.querySelector('.sl.on');
  p.push('S'+(on?on.id:'-')); // on-screen slide identity (covers inter-segment flips + end-card)
  const ids=sel=>Array.from(document.querySelectorAll(sel)).map((el,i)=>el.id||('#'+i)).sort().join(',');
  p.push('V'+ids('.show')); // every revealed/shown element (reveal/drawEdge + effect-shown elements)
  p.push('C'+ids('.clicked')+'|'+ids('.hovered')+'|'+ids('.pulsing')+'|'+ids('.is-marked')+'|'+ids('.is-dim')+'|'+ids('.is-off')+'|'+ids('.is-focus')); // discrete stateful classes, incl. held marks + code-focus dimming
  const ov=[];document.querySelectorAll('.fx-spot,.callout,.rollover-tip,.stepbadge,.flow-dot,.progress').forEach(n=>ov.push(n.className+':'+(n.textContent||'')+':'+(n.style.left||'')+','+(n.style.top||'')+','+(n.style.width||'')+','+(n.style.height||'')+','+(n.style.transform||'')+','+(n.style.opacity||'')));
  const pw=[];document.querySelectorAll('.progress i').forEach(i=>pw.push(i.style.width||''));
  p.push('O'+ov.sort().join(';')+'|'+pw.join(',')); // dynamic overlays: EVERY inline pixel-affecting prop
  // (left/top/width/height/transform/opacity) + text/progress. .fx-spot settles style.height, callout
  // settles style.transform, and GSAP writes inline transform/opacity — all must be in the tuple or two
  // settled frames differing only by one could collide and be wrongly held (C-19 violation).
  const ty=[];document.querySelectorAll('.liveinput').forEach(inp=>{if(inp.textContent)ty.push((inp.id||inp.getAttribute('data-text')||'')+'#'+inp.textContent.length);});
  p.push('T'+ty.sort().join(',')); // typed text (advances per-frame; NOT a tween, so must be explicit)
  // Footage: derive the index DETERMINISTICALLY from window.__t using the SAME math as
  // __setFootageFrame — NOT el.dataset.cur, which is committed asynchronously (after image load) and
  // therefore lags the frame about to be screenshotted by one frame. Reading dataset.cur here would
  // make the sig describe the PREVIOUS footage frame, causing a false dedup on footage segments (e.g.
  // a lower-fps clip whose index repeats then advances) and violating the C-19 equivalence invariant.
  // For layers outside their active window (index not changing this frame) dataset.cur is stable, so
  // it is read directly with no lag.
  const ft=[],__absMs=(window.__t||0)*1000;
  document.querySelectorAll('.footage-layer').forEach(el=>{const s=+el.dataset.segstart,e=+el.dataset.segend,dir=el.dataset.framedir;if(dir&&Number.isFinite(s)&&Number.isFinite(e)&&__absMs>=s-1&&__absMs<=e+1){const fps=+el.dataset.fps||30,count=Math.max(1,+el.dataset.framecount||1),start=+el.dataset.startms||0;let idx=Math.round(((__absMs-s)+start)/1000*fps)+1;idx=Math.max(1,Math.min(count,idx));ft.push(dir+'/frame_'+String(idx).padStart(5,'0')+'.jpg');}else ft.push(el.dataset.cur||'-');});
  p.push('G'+ft.join(',')); // footage frame that WILL be shown per layer (deterministic in t)
  const safe=on&&on.querySelector('.safe');p.push('L'+(safe?(safe.style.getPropertyValue('--fit')||'1'):'1')); // layout fit
  return p.join('~');
};
function tick(){fireTriggersUpTo(audio.currentTime);if(!window.__done)requestAnimationFrame(tick);}
window.startPlayback=async()=>{window.fitLayout();window.__done=false;fireTriggersUpTo(0);await audio.play();requestAnimationFrame(tick);};
audio.addEventListener('ended',()=>setTimeout(()=>{window.__done=true},3000));
function refit(){try{window.fitLayout();}catch(e){}}
refit();window.addEventListener('load',refit);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(refit);
Promise.all([...document.images].map(im=>im.complete?0:new Promise(r=>{im.addEventListener('load',r);im.addEventListener('error',r);}))).then(refit);
elementTriggers.filter(t=>t.s===1&&t.withSegment).forEach(apply);`;

// Inline GSAP from the local install so video-auto.html runs fully offline (C-8) — no CDN, no network, no external supply chain.
const gsapPath = path.join(dir, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
if (!fs.existsSync(gsapPath)) {
  console.error(
    `error: gsap not installed locally at ${gsapPath} — run \`npm install gsap\` in ${dir} ` +
      `(a local-first render must not depend on a CDN)`,
  );
  process.exit(EXIT.USAGE);
}
const gsapInline = `<script>${fs.readFileSync(gsapPath, 'utf8')}</script>`;
// Materialize EVERY slide first. narrative()/live() call checkedSrc(), so asserting before this map
// would inspect an empty srcErrors list and silently omit unsafe imagery from the final HTML.
//
// Guarded because this is where per-segment refusals are raised — a `code` mode path
// boundary, a highlight addressing a field that does not exist, a no-go match. Unguarded,
// those surfaced as a raw stack trace, which reads as an engine crash rather than as the
// deliberate refusal it is, and buries the one line the author needs.
const slideHtml = guard(() => timing.segments.map(slide).join(''));
guard(() => assertNoSrcErrors());   // every invalid evidence source, named by segment id, reported in ONE error
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${w},height=${h},initial-scale=1">${gsapInline}<style>${css}</style></head><body><div id="stage">${slideHtml}${endCardSlide}<audio id="vo" preload="auto" src="voiceover.mp3"></audio></div><script>${runtime}</script></body></html>`;
const outPath = guard(() => resolveOutput(dir, cli.values.out ?? 'video-auto.html', { apply: cli.apply, replace: cli.replace, label: 'output' }));
if (!cli.apply) {
  console.log(`plan: build the scene for ${timing.segments?.length ?? 0} segment(s)`);
  console.log(`  source ${path.join(dir, 'timing.json')}`);
  console.log(`  output ${outPath} — ${describeWrite(outPath, cli.replace)}`);
  console.log(`  size   ${html.length} bytes of generated HTML`);
  planFooter();
  process.exit(EXIT.OK);
}
fs.writeFileSync(outPath, html);
console.log('wrote video-auto.html (' + timing.segments.length + ' segments)');
