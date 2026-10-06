import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, resolveWithinRoot, resolveEngineOutput, planFooter } from './cli-support.mjs';

const USAGE = `
coach-rulings — present a coach report with the project's prior rulings collapsed against
it, so a review you have already answered does not arrive again unchanged.

  node coach-rulings.mjs --report coach-report.md
  node coach-rulings.mjs --report coach-report.md --rule <key>=waived --apply

  --report <path>   the coach's report, as emitted by the video-coach agent
  --rule <key>=<ruling>   record a ruling. Repeatable. Needs --apply to persist.
                    rulings: valid · waived · false-alarm · taste
  --apply           actually write coach-rulings.json. Without it nothing is recorded.

A RULING THAT AGREES THE DEFECT IS REAL DOES NOT SUPPRESS IT. "valid" keeps the finding
open and labels it "ruled valid, still unfixed"; only waived, false-alarm and taste
collapse. Because the key hashes the sentence a finding quotes, any edit to that sentence
re-opens it — a finding cannot be silenced by rewording the text it cites.

Exit codes: 0 success/plan · 1 the report could not be matched · 2 bad usage

  Chosen against the README table, not inherited. coach-pack splits 1 (stale record) from 2
  (malformed record); here every refusal ABOUT THE REPORT is the same kind of event — "this
  cannot be matched to these inputs" — so those are all 1.

  2 covers the caller's own mistakes, and honestly that includes two that are not
  arguments: an unknown --rule word, and a link planted at coach-rulings.json, both of which
  the shared guards raise as usage errors. Stating that split is the point — an exit code
  documented but never produced, or produced but never documented, is a defect this engine
  keeps finding.
`;

const RULINGS_FILE = 'coach-rulings.json';
// Where coach-pack publishes. The manifest a report cites normally lives here, not in the
// project — see the resolution below.
//
// THE BOUNDARY IS THE COACH FOLDER, NOT THE PACK FOLDER, for the reason coach-pack states:
// rooting at `coach/pack` would canonicalise onto a link's target and then certify reads
// there. `coach/` is committed and holds the rubric, so it is the lowest known-good point,
// and it is checked directly rather than trusted. The regress stops there because anyone
// who can relink it can equally edit this file.
const COACH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'coach');
function coachDirIsReal() {
  try {
    const st = fs.lstatSync(COACH_DIR);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}
// A ruling that agrees is not a permission to hide. Only these three collapse a finding.
const COLLAPSING = new Set(['waived', 'false-alarm', 'taste']);
const KNOWN_RULINGS = new Set(['valid', ...COLLAPSING]);

/**
 * The normalisation the keys are built on. MEASURED, not chosen because it looked
 * reasonable: five candidates were scored against the shipped EvalLoopDemo script on
 * whether they re-open the edits an author really makes and collapse the ones that are not
 * edits at all. This rule scored 10/10; keeping markdown scored 9 (every bolded word
 * re-opened a finding) and additionally lowercasing and stripping punctuation scored 8 —
 * it silenced a real `;`→`:` change and a quote-character change, which is the failure
 * this stage exists to prevent.
 *
 * ITS BLIND SPOT, stated because a normalisation without one is a normalisation nobody
 * measured: emphasis and backticks are stripped, so a finding ABOUT formatting does not
 * re-open when the formatting is fixed, and `snake_case` keys the same as `snakecase`.
 * Both are narrow; the alternative was false re-opens on every bolded word.
 */
export function normaliseForKey(text) {
  return String(text)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[`*_]/g, '');
}

/**
 * The sentence containing a quote.
 *
 * MEASURED: a splitter guarded against decimals, filenames and initials was compared with
 * a naive one across 71 real quotes from the shipped EvalLoopDemo script. They produced
 * the SAME normalised key for all 71 — the differences were trailing whitespace and an
 * empty tail, both of which `normaliseForKey` removes. So the simple rule is kept, and the
 * risk this design carries lives in the normalisation above, not here.
 *
 * Falls back to the whole block when no sentence boundary is found, which keys a
 * bullet or a heading on itself rather than on nothing.
 */
export function sentenceContaining(text, quote) {
  const at = text.indexOf(quote);
  if (at < 0) return null;
  // AMBIGUOUS IS NOT KEYABLE. If the quote appears more than once, "the sentence containing
  // it" is not a single thing: taking the first occurrence means editing the LATER sentence
  // leaves the key unchanged, so a prior waiver keeps collapsing a finding whose evidence
  // moved. That is silent suppression, so an ambiguous quote is refused here and the
  // caller shows it as unkeyable instead.
  if (text.indexOf(quote, at + 1) >= 0) return null;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  let cursor = 0;
  for (const s of sentences) {
    const start = text.indexOf(s, cursor);
    if (start < 0) continue;
    cursor = start + s.length;
    if (at >= start && at < cursor) return s;
  }
  return text;
}

const keyOf = (parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

/**
 * Parses the agent's REQUIRED output block (.github/agents/video-coach.agent.md).
 *
 * QUOTE IS TOLERATED AS ABSENT, DELIBERATELY. That contract's prose says a still-only
 * finding names the still and "its hash is the key", but its output TEMPLATE shows
 * `QUOTE:` unconditionally under both DEFECTS and ADVISORY and tells the agent to emit
 * exactly that. The two halves disagree, so an agent following the template will invent a
 * quote for an image. Refusing here would turn that contract defect into a wall of
 * unkeyable findings; a finding with no quote whose location names a still is keyed on the
 * still instead. Reported upstream — the agent file is the orchestrator's.
 */
export function parseReport(text) {
  // NORMALISED FIRST. A report can arrive with either line ending — this one did, and a
  // `^SECTION:\n` pattern silently matched nothing against `SECTION:\r\n` while the
  // single-line fields still parsed, so the report looked readable and had no findings.
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  const field = (name) => {
    const hit = lines.find((l) => l.startsWith(`${name}:`));
    return hit ? hit.slice(name.length + 1).trim() : null;
  };
  const manifest = field('MANIFEST');
  const pass = Number((lines[0]?.match(/pass\s*(\d+)/) ?? [])[1] ?? NaN);
  // The agent declares its own totals. They are a free cross-check on this parser: if the
  // report says two defects and one is read, something was dropped — and a dropped finding
  // is the one outcome this stage must never produce quietly.
  const declared = (() => {
    const m = field('COUNTS')?.match(/defects\s+(\d+).*?advisory\s+(\d+)/);
    return m ? Number(m[1]) + Number(m[2]) : null;
  })();

  // LINE-BASED, NOT ONE CLEVER REGEX. The format is line-oriented, and the regex version of
  // this stopped at the first end-of-line because `$` under the `m` flag matches there —
  // capturing each finding's head and dropping its QUOTE, which turned every finding
  // unkeyable while looking like a successful parse.
  const findings = [];
  const unparsed = [];
  let section = null;
  let current = null;
  const flush = () => {
    if (current) findings.push(current);
    current = null;
  };
  for (const line of lines) {
    const heading = line.match(/^([A-Z][A-Z ]*):\s*$/);
    if (heading) {
      flush();
      section = heading[1];
      continue;
    }
    if (section !== 'DEFECTS' && section !== 'ADVISORY') continue;

    const head = line.match(/^\s*-\s*\[([^\]]+)\]\s*(\S+)\s*@\s*(.+?)\s*$/);
    if (head) {
      flush();
      current = { section, rule: head[1].trim(), file: head[2], location: head[3], quote: null, body: '' };
      continue;
    }
    // A BULLET THAT IS NOT A HEAD IS AN UNREADABLE FINDING, WHEREVER IT APPEARS. Guarding
    // this with `!current` meant that after one good finding, a malformed second bullet was
    // absorbed into the first one's body and disappeared — and with a missing COUNTS line
    // there was nothing left to notice it. Entries are bullets; body lines are not.
    if (/^\s*-\s+/.test(line) && !/^\s*-\s*none\s*$/.test(line)) {
      unparsed.push(`${section}: ${line.trim()}`);
      continue;
    }
    if (!current) continue;

    const quote = line.match(/^\s*QUOTE:\s?(.*)$/);    // Only the FIRST QUOTE line counts. Taking the last would let a second one overwrite
    // the quote the finding was keyed on.
    if (quote && current.quote === null) current.quote = quote[1].trim();
    else if (line.trim()) current.body = `${current.body} ${line.trim()}`.trim();
  }
  flush();
  return { manifest, pass, declared, findings, unparsed };
}

// RUNS ONLY WHEN EXECUTED DIRECTLY. Every other stage in this engine is a pure script and
// calls runCli unconditionally, which is correct for them. This one also EXPORTS the two
// rules the whole design rests on — the normalisation and the sentence rule — so that they
// can be tested against real text rather than only through the CLI. Without this guard,
// importing them to test them would execute the CLI with the test runner's argv.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await runCli(async () => {
  const { values, projectDir, apply } = parseCli({
    usage: USAGE,
    options: { report: { type: 'string' }, rule: { type: 'string', multiple: true, default: [] } },
  });

  if (!values.report) throw new CliError('--report is required: pass the coach report to match.');
  const reportPath = requireExistingFile(projectDir, values.report, 'coach report');
  const parsed = parseReport(fs.readFileSync(reportPath, 'utf8'));

  // A finding this parser could not read must never be dropped. Refusing is the only safe
  // outcome: presenting the rest would show a shorter report than the coach wrote, and the
  // reader would have no way to know.
  if (parsed.unparsed.length) {
    console.error(`\nFAILED: ${parsed.unparsed.length} finding line(s) in the report could not be read:`);
    for (const u of parsed.unparsed) console.error(`  ${u}`);
    console.error('  Expected: "  - [<rule>] <file> @ <location>". Refusing rather than presenting a report with findings missing.');
    return EXIT.FAILED;
  }
  // The agent's own COUNTS line is a free cross-check. If it disagrees with what was read,
  // one of the two is wrong and neither may be presented as authoritative. A MISSING or
  // unreadable COUNTS is itself a refusal: treating it as "no cross-check available" would
  // mean the one report most likely to be malformed is the one checked least.
  if (parsed.declared === null) {
    console.error('\nFAILED: the report has no readable COUNTS line, so there is nothing to check the findings read against.');
    console.error('  Expected: "COUNTS: defects <n> \u00b7 advisory <n> \u00b7 not evaluated <n>".');
    return EXIT.FAILED;
  }
  if (parsed.declared !== parsed.findings.length) {
    console.error(`\nFAILED: the report declares ${parsed.declared} finding(s) but ${parsed.findings.length} could be read.`);
    console.error('  Refusing rather than presenting a count this stage cannot account for.');
    return EXIT.FAILED;
  }

  // A ruling made against one input set must not silently apply to another, so the report
  // has to say which set it reviewed.
  if (!parsed.manifest || parsed.manifest === 'none') {
    console.error(`\nFAILED: the report names no manifest, so its findings cannot be tied to the inputs they describe.`);
    console.error('  A pass-2 report must carry a MANIFEST line. Re-run the coach with the manifest coach-pack wrote.');
    return EXIT.FAILED;
  }

  // THE MANIFEST DOES NOT LIVE IN THE PROJECT. coach-pack publishes it under the tool's own
  // coach/pack folder, so confining this to projectDir refused the real manifest from the
  // only stage that produces one — a defect my own fixture hid, because it put the manifest
  // in the project where it was convenient rather than where the system puts it.
  //
  // Both locations are bounded: inside the project, or inside the tool's pack root. The
  // path still comes from a file on disk, so neither is taken on trust.
  const manifestPath = (() => {
    const inPack = (candidate) => {
      // Refused outright if the boundary root itself cannot be trusted — resolving inside a
      // linked `coach/` would canonicalise onto the target and accept a path there.
      if (!coachDirIsReal()) return null;
      return resolveWithinRoot(COACH_DIR, path.join('pack', candidate), 'manifest');
    };
    const tries = [
      () => resolveWithinRoot(projectDir, parsed.manifest, 'manifest'),
      () => inPack(path.relative(path.join(COACH_DIR, 'pack'), path.resolve(parsed.manifest))),
      () => inPack(parsed.manifest.replace(/^.*?coach[\\/]pack[\\/]/, '')),
    ];
    for (const attempt of tries) {
      try {
        const p = attempt();
        if (p && fs.existsSync(p)) return p;
      } catch {
        // Out of that boundary; try the next one. A path in neither is refused below.
      }
    }
    return null;
  })();
  if (!manifestPath) {
    console.error(`\nFAILED: the manifest the report cites (${parsed.manifest}) is not in this project or in the coach pack folder.`);
    console.error('  Re-run coach-pack, and cite the manifest it writes.');
    return EXIT.FAILED;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // A MANIFEST THAT BINDS NOTHING MAKES EVERY CHECK BELOW VACUOUS. `files ?? []` would walk
  // an empty list, find nothing moved, and report success — "absence reads as nothing
  // wrong" one level in, which is the failure this stage exists to refuse.
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    console.error(`\nFAILED: the manifest binds no files, so it cannot say what the coach read.`);
    return EXIT.FAILED;
  }

  // THE REAL TEST OF "A DIFFERENT MANIFEST" IS NOT THE PATH, IT IS THE BYTES. Comparing
  // manifest filenames would accept a stale report that happens to cite the same name.
  // Every input the manifest binds is re-hashed against the project as it is NOW: if any
  // has moved, the report describes text that no longer exists.
  const moved = [];
  for (const f of manifest.files) {
    const p = resolveWithinRoot(projectDir, f.file, 'manifest input');
    if (!fs.existsSync(p)) moved.push(`${f.file} — named by the manifest but missing`);
    else if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== f.sha256) {
      moved.push(`${f.file} — changed since the coach read it`);
    }
  }
  if (moved.length) {
    console.error(`\nFAILED: ${moved.length} input(s) have changed since this report was written:`);
    for (const m of moved) console.error(`  ${m}`);
    console.error('  Re-run coach-pack and the coach; a report about older bytes must not be presented as current.');
    return EXIT.FAILED;
  }

  // A finding may only be keyed from an input the MANIFEST BOUND. Keying from a project
  // file the manifest never named would key a finding to bytes nobody proved the coach
  // read — a key that looks sound and certifies nothing.
  const bound = new Set(manifest.files.map((f) => f.file));

  // Each finding is keyed, or explicitly marked unkeyable. A quote that does not appear
  // verbatim is NOT dropped and NOT collapsed — it is shown as new and flagged, because a
  // finding nobody can key is still a finding somebody has to read.
  const inputCache = new Map();
  const readInput = (name) => {
    if (!inputCache.has(name)) {
      const p = resolveWithinRoot(projectDir, name, 'reviewed input');
      inputCache.set(name, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
    }
    return inputCache.get(name);
  };

  const segmentOf = (location) => location.split(/\s*[\u00b7|]\s*/)[0].trim();

  for (const f of parsed.findings) {
    // A STILL KEY IS ONLY AVAILABLE TO THE STILL ITSELF. Matching the basename anywhere in
    // the head line let a quote-free finding on an UNBOUND file borrow a bound still's hash
    // just by mentioning it — `notes.md @ big.png` collapsing under a waiver recorded for
    // `preview/big.png`. The finding's own file must BE the bound still, which is exact and
    // unambiguous because a manifest binds each path once.
    const stillEntry = manifest.files.find((entry) => entry.role === 'still' && entry.file === f.file);
    if (!f.quote && stillEntry) {
      f.key = keyOf([f.rule, segmentOf(f.location), stillEntry.file, stillEntry.sha256]);
      f.keyedOn = `still ${path.basename(stillEntry.file)}`;
      continue;
    }
    const input = f.quote ? readInput(f.file) : null;
    if (!f.quote || input === null || !bound.has(f.file) || !input.includes(f.quote)) {
      f.unkeyable = !f.quote
        ? 'no QUOTE, and the location names no still in the manifest'
        : input === null
          ? `the named input ${f.file} was not readable`
          : !bound.has(f.file)
            ? `${f.file} is not bound by the manifest, so the coach is not recorded as having read it`
            : `the quote does not appear verbatim in ${f.file}`;
      continue;
    }
    const sentence = sentenceContaining(input, f.quote);
    if (sentence === null) {
      // The quote appears more than once, so no single sentence owns it.
      f.unkeyable = `the quote appears more than once in ${f.file}, so it cannot be keyed to one sentence`;
      continue;
    }
    // THE FILE IS PART OF THE IDENTITY. Without it, two manifest-bound inputs carrying the
    // same sentence produce the same key for the same rule and segment, so a waiver
    // recorded against one collapses a genuinely different finding in the other.
    f.key = keyOf([f.rule, segmentOf(f.location), f.file, normaliseForKey(sentence)]);
    f.keyedOn = 'quoted sentence';
  }

  // IF TWO FINDINGS IN ONE REPORT KEY THE SAME, THE KEY CANNOT TELL THEM APART — so neither
  // may collapse. Two quote-free findings on one still ("big.png · top-left" and
  // "big.png · bottom-right") reduce to the same rule, segment and still, because
  // `segmentOf` deliberately discards the rest of the location; a waiver entered for the
  // first would then silently collapse the second, unrelated defect.
  //
  // Refusing to key is better than inventing a distinction. Folding the full location into
  // the key would make every reworded location a new finding, which is the opposite failure
  // — so the ambiguity is reported rather than guessed at, exactly as a duplicated quote is.
  const keyCount = new Map();
  for (const f of parsed.findings) if (f.key) keyCount.set(f.key, (keyCount.get(f.key) ?? 0) + 1);
  for (const f of parsed.findings) {
    if (!f.key || keyCount.get(f.key) === 1) continue;
    f.unkeyable = `${keyCount.get(f.key)} findings in this report key identically (same rule, segment and evidence), so no ruling can be told apart`;
    f.key = undefined;
    f.keyedOn = undefined;
  }

  // THE RULINGS FILE IS UNTRUSTED INPUT, and an unvalidated one can make a finding VANISH.
  // A stored ruling whose key matches but whose word is unknown — `pending`, a typo, a
  // hand-edit — is not new (a ruling exists), not open (not `valid`), not collapsed (not a
  // collapsing word) and not orphaned (its key matched). It falls out of every section and
  // disappears at exit 0. That is precisely the suppression this stage exists to prevent,
  // reproduced inside the stage itself, so an unreadable rulings file is a refusal.
  //
  // Nobody names this file either, so a link at it is refused rather than written through.
  // `replace` is true because updating it IS the normal operation — it is a committed
  // record that grows — and the link refusal is what actually protects it.
  const rulingsPath = resolveEngineOutput(projectDir, RULINGS_FILE, { apply, replace: true, label: 'rulings file' });
  let existing = { version: 1, rulings: [] };
  if (fs.existsSync(rulingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(rulingsPath, 'utf8'));
    } catch (err) {
      console.error(`\nFAILED: ${RULINGS_FILE} could not be read (${err.message}).`);
      return EXIT.FAILED;
    }
    const rows = existing?.rulings;
    if (!Array.isArray(rows)) {
      console.error(`\nFAILED: ${RULINGS_FILE} has no rulings array, so prior rulings cannot be applied.`);
      return EXIT.FAILED;
    }
    const bad = rows.filter((r) => !r || typeof r.key !== 'string' || !KNOWN_RULINGS.has(r.ruling));
    if (bad.length) {
      console.error(`\nFAILED: ${bad.length} ruling(s) in ${RULINGS_FILE} are not readable:`);
      for (const r of bad) {
        console.error(`  key ${r?.key ?? '(none)'} — ruling ${JSON.stringify(r?.ruling ?? null)}`);
      }
      console.error(`  Every ruling must be one of: ${[...KNOWN_RULINGS].join(', ')}.`);
      console.error('  Refusing rather than presenting a report with findings silently missing from every section.');
      return EXIT.FAILED;
    }
  }
  const byKey = new Map((existing.rulings ?? []).map((r) => [r.key, r]));

  // --- record, only on the user's word -------------------------------------------------
  const requested = [];
  for (const spec of values.rule) {
    const at = spec.lastIndexOf('=');
    if (at < 0) throw new CliError(`--rule must be <key>=<ruling>, not ${JSON.stringify(spec)}.`);
    const key = spec.slice(0, at).trim();
    const ruling = spec.slice(at + 1).trim();
    if (!KNOWN_RULINGS.has(ruling)) {
      throw new CliError(`unknown ruling ${JSON.stringify(ruling)} — use one of: ${[...KNOWN_RULINGS].join(', ')}.`);
    }
    // A ruling must name a finding that is actually in this report. Recording one for a key
    // that is not present would write an orphan at birth, and the user would have no way to
    // see that their ruling landed on nothing.
    if (!parsed.findings.some((f) => f.key === key)) {
      throw new CliError(`no finding in this report has key ${key} — rule on a key the report printed.`);
    }
    requested.push({ key, rule: parsed.findings.find((f) => f.key === key).rule, ruling });
  }

  // --- present -------------------------------------------------------------------------
  const effective = new Map(byKey);
  for (const r of requested) effective.set(r.key, r);

  const show = (f) => {
    const where = `[${f.rule}] ${f.file} @ ${f.location}`;
    if (f.unkeyable) return `  ${where}\n    UNKEYABLE — ${f.unkeyable}\n    QUOTE: ${f.quote ?? '(none)'}\n    ${f.body}`;
    return `  ${where}\n    key: ${f.key} (${f.keyedOn})\n    ${f.body}`;
  };

  const ruled = (f) => (f.key ? effective.get(f.key) : undefined);
  // `!f.unkeyable` is DEFENSIVE AND CURRENTLY UNREACHABLE, and that is recorded rather than
  // tested: an unkeyable finding carries no key, so `ruled()` already returns undefined for
  // it and no ruling can reach it. A mutant removing this clause survives the suite, and
  // the honest reading is that the code is dead, not that the test is weak — so there is no
  // green assertion over it pretending the branch is covered. It stays because the
  // invariant it states ("nothing unkeyable may ever collapse") is the one this stage
  // exists to hold, and a later change that gives unkeyable findings a provisional key
  // would otherwise silently start collapsing them.
  const isCollapsed = (f) => !f.unkeyable && COLLAPSING.has(ruled(f)?.ruling);
  const fresh = parsed.findings.filter((f) => f.unkeyable || !ruled(f));
  const openValid = parsed.findings.filter((f) => !f.unkeyable && ruled(f)?.ruling === 'valid');
  const collapsed = parsed.findings.filter(isCollapsed);
  const matched = new Set(parsed.findings.map((f) => f.key).filter(Boolean));
  const orphaned = [...effective.values()].filter((r) => !matched.has(r.key));

  console.log(`coach report, pass ${Number.isFinite(parsed.pass) ? parsed.pass : '?'} — ${parsed.findings.length} finding(s)\n`);

  console.log(`NEW (${fresh.length}):`);
  console.log(fresh.length ? fresh.map(show).join('\n\n') : '  none');

  // A ruling that agrees the defect is real does not suppress it.
  console.log(`\nOPEN — ruled valid, still unfixed (${openValid.length}):`);
  console.log(openValid.length ? openValid.map(show).join('\n\n') : '  none');

  console.log(`\nCOLLAPSED under a prior ruling (${collapsed.length}):`);
  console.log(
    collapsed.length
      ? collapsed.map((f) => `  [${f.rule}] ${f.file} @ ${f.location} — ${ruled(f).ruling}${ruled(f).note ? `: ${ruled(f).note}` : ''}`).join('\n')
      : '  none',
  );

  // Evidence either way: the defect was fixed, or the sentence it cited was reworded.
  // Dropping these silently would be the one thing this stage exists to prevent.
  console.log(`\nORPHANED — ruled before, matches nothing now (${orphaned.length}):`);
  console.log(
    orphaned.length
      ? orphaned.map((r) => `  [${r.rule ?? '?'}] key ${r.key} — ${r.ruling}. Either it was fixed, or the text it cited changed.`).join('\n')
      : '  none',
  );

  if (!requested.length) return EXIT.OK;

  if (!apply) {
    console.log(`\nplan: record ${requested.length} ruling(s) in ${RULINGS_FILE}`);
    for (const r of requested) console.log(`    ${r.key} = ${r.ruling}`);
    planFooter();
    return EXIT.OK;
  }

  for (const r of requested) byKey.set(r.key, r);
  const next = { version: 1, rulings: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  fs.writeFileSync(rulingsPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nrecorded ${requested.length} ruling(s) in ${RULINGS_FILE}`);
  return EXIT.OK;
  });
}
