import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, resolveOutput, resolveEngineOutput, describeWrite, planFooter } from './cli-support.mjs';
import {
  isSilentSegment, silentSegmentProblems, silentDurationMs, silentMp3, silentMp3DurationMs, SILENCE_FRAME_MS,
  unvoicedNarrationProblem, voiceBlocker, remixBlocker, gatedRemedy, declareSilentRemedy, sameIdentity,
  segmentEntryBlocker,
} from './silent-segment.mjs';

function audioStart(buffer) {
  let offset = 0;
  if (buffer.length >= 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size + ((buffer[5] & 0x10) ? 10 : 0);
  }
  while (offset < buffer.length - 1) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) break;
    offset++;
  }
  return offset;
}

function stripId3v1(buffer) {
  return buffer.length >= 128 && buffer[buffer.length - 128] === 0x54 && buffer[buffer.length - 127] === 0x41 && buffer[buffer.length - 126] === 0x47
    ? buffer.subarray(0, buffer.length - 128)
    : buffer;
}

function clean(buffer, keepLeadingTag) {
  return stripId3v1(keepLeadingTag ? buffer : buffer.subarray(audioStart(buffer)));
}

const USAGE = `
concat-audio — concatenate the per-segment clips into voiceover.mp3, inserting silence
between segments (pipeline stage S4).

  node concat-audio.mjs                    plan only (default)
  node concat-audio.mjs --apply            write voiceover.mp3
  node concat-audio.mjs --apply --replace  overwrite an existing voiceover.mp3

Segments declared silent in timing.json (\`segments[].silence\`) are filled with digital
silence generated from their CURRENT authored window, never from a clip on disk: that
clip was made for the window or declaration the voice stage saw, and a silence edit since
then is honoured here without re-voicing. They keep their place and their length in the
voice track, which is what stops every later segment drifting earlier. A narrated segment
whose record names its clip but holds no measured words is refused, because arranging
audio cannot create speech — it needs voice.mjs (S3). So is a silent segment in a project
whose timeline names no clips, because clips matched by position cannot say which one is
whose — unless every segment is silent, when no clip is matched at all.

This stage never writes timing.json. remix.mjs (S4) is the stage that also reflows the
timeline and rewrites the records to match the audio.

Options
  --out <file>      output path (default: voiceover.mp3, which is refused if it is a
                    link; a path you name follows an in-root link)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing --out
  --help            show this message

Exit codes: 0 success/plan · 1 failed (including a missing clip or a malformed silence
declaration) · 2 bad usage, a refused overwrite, or a timeline this stage cannot arrange
`.trimStart();

await runCli(() => {
  const { values, projectDir, boundary, apply, replace } = parseCli({
    usage: USAGE,
    options: { out: { type: 'string' } },
  });

  // THE TIMELINE IS THE AUTHORITY, NOT THE DIRECTORY LISTING.
  //
  // This stage used to glob `segment_*.mp3` and concatenate whatever it found. A glob
  // cannot tell "three segments, the middle one deliberately silent" apart from "three
  // segments, the middle clip missing" — or from "two segments". So a segment with no
  // clip was simply omitted, and EVERY LATER SEGMENT MOVED EARLIER by its whole duration:
  // a corrupted timeline, no error, exit 0. Measured on the fixture in
  // tests/silent-segments.test.mjs, a 2160ms track came out 1440ms, putting the back half
  // a full 720ms early against the picture.
  //
  // Reading timing.json makes the hole DETECTABLE, and the `silence` declaration makes it
  // ATTRIBUTABLE: a hole that was declared is filled, and one that was not is refused.
  const timingPath = requireExistingFile(projectDir, 'timing.json', 'timing file');
  let timing;
  try {
    timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
  } catch (err) {
    throw new CliError(`${timingPath} is not valid JSON — ${err.message}`, EXIT.FAILED);
  }
  const segments = Array.isArray(timing.segments) ? timing.segments : [];
  if (!segments.length) {
    throw new CliError('timing.json declares no segments — there is nothing to concatenate', EXIT.FAILED);
  }
  // SHAPE FIRST, BUT AFTER THE LIST CHECK ABOVE. A null, an array or a string where a
  // segment object belongs used to reach the map below and throw an uncaught TypeError on
  // `s.audio` — a crash with a stack, not a refusal, and the path had no exit code of its
  // own. It is asked SECOND so this stage's own wording for an empty list, and its own
  // EXIT.FAILED for it, both of which are shipped, keep precedence.
  //
  // EXIT.USAGE here, not FAILED: a null where a segment object belongs is bad input,
  // refused before any work runs. The two codes differ on purpose.
  {
    const bad = segmentEntryBlocker(segments);
    if (bad) throw new CliError(bad.fact);
  }

  const discovered = fs
    .readdirSync(projectDir)
    .filter((name) => /^segment_\d+\.mp3$/i.test(name))
    .sort();

  // Two ways a project names its clips, and they must not be mixed.
  //
  // After the voice stage runs, every segment carries `audio.file`, and that name is
  // authoritative. A project that predates it has clips on disk and no names in the
  // timeline, which can only be mapped positionally. A PARTIALLY named project is
  // ambiguous — positional mapping would hand one segment's clip to another, quietly — so
  // it is refused below rather than guessed at.
  const declaredName = segments.map((s) =>
    typeof s.audio?.file === 'string' && s.audio.file.trim() !== '' ? s.audio.file : null);
  const anyNamed = declaredName.some((n) => n !== null);

  // Both refusals a silent segment can draw are decided before any clip is consumed, so an
  // earlier segment's clip cannot pre-empt them. The declarations first, so a malformed
  // one is reported as such (exit 1) wherever it sits in the timeline.
  const silentIds = [];
  for (let i = 0; i < segments.length; i++) {
    if (!isSilentSegment(segments[i])) continue;
    const problems = silentSegmentProblems(segments[i], `segment "${segments[i]?.id ?? i}"`);
    if (problems.length) throw new CliError(problems[0], EXIT.FAILED);
    silentIds.push(`segment "${segments[i]?.id}"`);
  }
  if (!anyNamed && silentIds.length && segments.some((s) => !isSilentSegment(s))) {
    // Positional mode matched clips to segments by skipping the silent ones, which is
    // only right if the directory has no clip for them — and voice.mjs gives every
    // segment one, silent or not. Skipping handed each later segment the clip before
    // it, and made its own clip an orphan, at exit 0. A listing cannot settle it. Where
    // every segment is silent, no clip is matched to anything, so there is nothing to
    // settle: each window is generated, as it always was.
    throw new CliError(
      `${silentIds.join(', ')} ${silentIds.length > 1 ? 'are' : 'is'} declared silent, but no segment in timing.json names its ` +
      'clip in `audio.file`, so clips could only be matched to segments by their order on disk — and once a ' +
      'segment is silent, a directory listing cannot say which clip belongs to which segment. Name each narrated ' +
      "segment's clip in its `audio.file` (no re-voice needed, provided each record carries its measured words), " +
      `or ${gatedRemedy(voiceBlocker(projectDir, timing), {
        open: 'run voice.mjs (S3), which names every clip it writes',
        stem: 'voice.mjs (S3) would name every clip it writes',
      })}.`,
      EXIT.USAGE);
  }

  // A clip a record names is claimed under the name discovery lists — the top-level entry
  // the record names, however it cases it — so it is never reported as an orphan. Where
  // that entry is a link, the file it resolves to is claimed too: the link plays that
  // file, and calling it unclaimed invites deleting what the link needs. And the file is
  // claimed by its canonical name, where the platform reports one: that is the name
  // discovery lists where the record names it by another — on Windows, an 8.3 short name.
  // That is accounting only — what is read is still the path the record names, confined
  // as before.
  const used = new Set();
  const fold = (n) => (process.platform === 'win32' ? n.toLowerCase() : n);
  const claimTopLevel = (abs) => {
    if (fold(path.dirname(abs)) === fold(boundary.root)) used.add(fold(path.basename(abs)));
  };
  // A LINK a record names by its short name is the one case those names miss: each of them
  // follows the link, so none is the link's own entry, and nothing maps a short name to its
  // long one without following it. The link's identity can stand in: lstat describes the
  // link itself, so the root entry that is the same link is the one the short name names —
  // where exactly one is. Hard links of one link are one identity under several names, so
  // which of them the short name belongs to cannot be told: none is claimed, and each is
  // reported as one the record may name. Only links: a regular file's canonical name above
  // is its entry. Accounting only. Where identity is unavailable — the volume reports no
  // file IDs, or an entry could not be inspected — nothing more is claimed, and no entry
  // that may be that link is called unclaimed: each is reported as one the record may name.
  const mayBe = new Map();
  const unidentified = [];
  const claimLinkByShortName = (named, label) => {
    if (fold(path.dirname(named)) !== fold(boundary.root)) return;
    let link;
    let entries;
    try {
      link = fs.lstatSync(named, { bigint: true });
      if (!link.isSymbolicLink()) return;
      entries = fs.readdirSync(boundary.root);
    } catch {
      return; // the names above are claimed; nothing more is known
    }
    if (entries.some((e) => fold(e) === fold(path.basename(named)))) return;
    const unknown = (why) => { unidentified.push({ label, alias: path.basename(named), why }); };
    if (link.ino === 0n) return unknown('no file IDs');
    const same = [];
    for (const e of entries) {
      let st;
      try {
        st = fs.lstatSync(path.join(boundary.root, e), { bigint: true });
      } catch {
        return unknown('uninspectable');
      }
      if (st.isSymbolicLink() && sameIdentity(link, st.ino === 0n ? null : st)) same.push(e);
    }
    if (same.length === 1) used.add(fold(same[0]));
    for (const e of same.length > 1 ? same : []) {
      if (!mayBe.has(fold(e))) mayBe.set(fold(e), { label, alias: path.basename(named), others: same.filter((o) => o !== e) });
    }
  };
  const claim = (name, resolved, label) => {
    claimTopLevel(path.resolve(boundary.root, name));
    claimTopLevel(resolved);
    let canonical = null;
    try { canonical = fs.realpathSync.native(resolved); } catch { /* the names above are claimed; nothing more is known */ }
    if (canonical !== null) claimTopLevel(canonical);
    claimLinkByShortName(path.resolve(boundary.root, name), label);
  };
  let nextPositional = 0;
  const parts = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = `segment "${seg?.id ?? i}"`;
    const silent = isSilentSegment(seg);

    let name = declaredName[i];
    if (name === null && !anyNamed && !silent) {
      // Positional mode, in which either no segment is silent or every one is: the pointer
      // advances once per narrated segment, and a silent one takes no clip.
      name = discovered[nextPositional++] ?? null;
    }

    const onDisk = name !== null && fs.existsSync(path.join(projectDir, name));

    if (silent) {
      // The authored window IS the duration — there is no second field to disagree with
      // it — and the silence is generated from it every time. A clip the record names is
      // never read: it was made for the window or declaration voice saw, and playing it
      // against an edited window is a timeline that says one length and a track that holds
      // another. It is still confined and claimed, so it is not reported as an orphan.
      // Generated at the shared frame size so the concatenation stays frame-aligned,
      // exactly as an inserted gap does.
      const resolved = onDisk ? requireExistingFile(projectDir, name, `${label} audio`) : null;
      if (resolved !== null) claim(name, resolved, label);
      // Reported under the name the record gives it. Where that name leads through a link,
      // what it resolves to is shown beside it: the record names the link, not its target.
      const linkedTo = resolved !== null && fold(path.resolve(boundary.root, name)) !== fold(resolved)
        ? path.relative(boundary.root, resolved) : null;
      const claimed = resolved === null ? null : `${name}${linkedTo === null ? '' : ` (a link to ${linkedTo})`}`;
      const requestedMs = silentDurationMs(seg);
      parts.push({
        kind: 'generated',
        id: seg.id,
        requestedMs,
        realMs: silentMp3DurationMs(requestedMs),
        bytes: silentMp3(requestedMs),
        silent: true,
        claimed,
      });
      continue;
    }

    if (onDisk) {
      // A narrated segment's record must describe speech. One that holds no measured
      // words names a clip voice did not synthesise as its narration — typically the
      // silence it generated while the segment was declared silent.
      const unvoiced = declaredName[i] !== null ? unvoicedNarrationProblem(seg, label, projectDir, timing) : null;
      if (unvoiced) throw new CliError(unvoiced, EXIT.USAGE);
      // Confine the name before reading it: `audio.file` is authored input, and authored
      // input is not trusted input.
      const resolved = requireExistingFile(projectDir, name, `${label} audio`);
      claim(name, resolved, label);
      parts.push({
        kind: 'clip',
        id: seg.id,
        name: path.basename(resolved),
        bytes: clean(fs.readFileSync(resolved), parts.length === 0),
        silent,
      });
      continue;
    }

    // A hole nobody declared. Nothing on disk says how long it should be, so there is no
    // safe fill — and dropping it is the corruption described above.
    const what = `${label} has no clip to concatenate` +
      (name === null ? ' and no `audio.file` naming one' : ` (${name} is missing)`) +
      (anyNamed && declaredName[i] === null ? ', while other segments do name theirs' : '');
    if (!anyNamed) {
      // A timeline that names no clips, and so has no silent segment here: worded as it
      // always was.
      throw new CliError(
        `${what}. The voice stage has not produced it and it is not declared silent — run voice.mjs (S3), ` +
        'or add a `silence` declaration if this segment is meant to be a gap.',
        EXIT.FAILED);
    }
    throw new CliError(
      `${what}. The voice stage has not produced it and it is not declared silent; if this segment is meant to be ` +
      `a gap, ${declareSilentRemedy(seg)}; otherwise, ${gatedRemedy(voiceBlocker(projectDir, timing), {
        open: 'run voice.mjs (S3)',
        stem: 'voice.mjs (S3) produces it',
      })}.`,
      EXIT.FAILED);
  }

  const orphans = discovered.filter((name) => !used.has(fold(name)));
  // An entry the record may name by a short name it cannot be told apart from another by.
  const mayBeNamed = (name) => {
    const { label, alias, others } = mayBe.get(fold(name));
    return `${name} may be the file ${label} names by the short name ${alias} — it and ${others.join(' and ')} are ` +
      'hard links of one link, so which of them that short name belongs to cannot be told';
  };
  // An entry that may be a link a record names by a short name its identity could not
  // find: one that lstats as a link, or could not be inspected. A regular file is not
  // qualified: a record that names it, by whatever name, claims it above — by its
  // canonical name, where the platform reports one. null where the entry needs no qualifying.
  const unidentifiedNamed = (name) => {
    if (unidentified.length === 0) return null;
    try {
      if (!fs.lstatSync(path.join(boundary.root, name)).isSymbolicLink()) return null;
    } catch { /* not known to be a regular file */ }
    const reasons = [...new Set(unidentified.map((u) => u.why))]
      .map((why) => (why === 'no file IDs' ? 'this volume reports no file IDs' : 'not every entry here could be inspected'));
    return `${name} may be ${unidentified.map((u) => `the file ${u.label} names by the short name ${u.alias}`).join(' or ')} — ` +
      `${reasons.join(', and ')}, so whether ${unidentified.length > 1 ? 'any of those short names' : 'that short name'} ` +
      'belongs to it cannot be told';
  };

  // Inter-segment silence is NOT inserted beside a declared silent segment: the authored
  // silence already IS the pause, and padding it would make the audio longer than the
  // timeline that describes it.
  const seam = (i) => i + 1 < parts.length && !parts[i].silent && !parts[i + 1].silent;
  const seamCount = parts.reduce((n, _, i) => n + (seam(i) ? 1 : 0), 0);

  // Required only where a seam will actually use it, so an entirely silent project is not
  // asked for an asset it has no use for.
  const silencePath = seamCount > 0 ? requireExistingFile(projectDir, 'silence.mp3', 'silence asset') : null;

  // voiceover.mp3 is a name the ENGINE chose when --out is omitted, so a link there is
  // refused rather than followed into a file nobody named. A path the caller names with
  // --out is resolved as it always was, following an in-root link they planted themselves.
  const outPath = values.out === undefined
    ? resolveEngineOutput(projectDir, 'voiceover.mp3', { apply, replace, label: 'output' })
    : resolveOutput(projectDir, values.out, { apply, replace, label: 'output' });

  // Generated silence lands on a whole number of 24ms frames, so a filled window can miss
  // its authored length by up to 12ms — and across several silent segments that
  // accumulates. Disclosed rather than absorbed: a track that is quietly 120ms short of
  // the timeline describing it is drift, and drift that nothing prints is drift nobody
  // finds. This stage never writes timing.json, so it cannot close the gap itself; remix
  // (S4) regenerates the same silence and reflows the timeline onto it, with no re-voice —
  // named as the step only where it would run.
  const generated = parts.filter((p) => p.kind === 'generated');
  const quantDeltaMs = generated.reduce((a, p) => a + (p.realMs - p.requestedMs), 0);
  const quantNote = quantDeltaMs === 0 ? null
    : `note: generated silence is quantised to ${SILENCE_FRAME_MS}ms frames, so the filled window(s) come to `
    + `${quantDeltaMs > 0 ? '+' : ''}${quantDeltaMs}ms against their authored length. `
    + `${gatedRemedy(remixBlocker(projectDir, timing), {
      open: 'Run remix.mjs (S4) to reflow the timeline onto the audio that exists — a silence edit needs no re-voice',
      stem: 'remix.mjs (S4) reflows the timeline onto the audio that exists, with no re-voice',
    }, { factOnly: true })}.`;

  if (!apply) {
    console.log(`plan: concatenate ${parts.length} segment(s), inserting silence at ${seamCount} seam(s)`);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.kind === 'clip') console.log(`  + ${p.name}`);
      else if (p.claimed === null) console.log(`  + segment "${p.id}" — GENERATE ${p.realMs}ms of digital silence (declared silent, no clip on disk)`);
      else {
        console.log(`  + segment "${p.id}" — GENERATE ${p.realMs}ms of digital silence from its authored window ` +
          `(declared silent; ${p.claimed}, which its record names, is not used and is left as it is)`);
      }
      if (seam(i)) console.log('  + silence.mp3');
    }
    for (const name of orphans) {
      const unsure = mayBe.has(fold(name)) ? mayBeNamed(name) : unidentifiedNamed(name);
      console.log(unsure !== null ? `  ! ${unsure}`
        : `  ! ${name} is on disk but no segment claims it — it will NOT be included`);
    }
    console.log(`  output ${outPath} — ${describeWrite(outPath, replace)}`);
    if (quantNote) console.log(`  ${quantNote}`);
    planFooter();
    return EXIT.OK;
  }

  const silence = silencePath === null ? null : clean(fs.readFileSync(silencePath), false);
  const buffers = [];
  for (let i = 0; i < parts.length; i++) {
    buffers.push(parts[i].bytes);
    if (seam(i)) buffers.push(silence);
  }
  fs.writeFileSync(outPath, Buffer.concat(buffers));
  for (const p of parts) {
    if (p.kind === 'generated') {
      console.log(`generated ${p.realMs}ms of silence for segment "${p.id}" (authored window ${p.requestedMs}ms` +
        `${p.claimed === null ? '' : `; ${p.claimed}, which its record names, was not used`})`);
    }
  }
  for (const name of orphans) {
    const unsure = mayBe.has(fold(name)) ? mayBeNamed(name) : unidentifiedNamed(name);
    console.log(unsure !== null ? `warning: ${unsure}`
      : `warning: ${name} is on disk but no segment claims it — it was NOT included`);
  }
  if (quantNote) console.log(quantNote);
  console.log(`wrote ${outPath}`);
  return EXIT.OK;
});
