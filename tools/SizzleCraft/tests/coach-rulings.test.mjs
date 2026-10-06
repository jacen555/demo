import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { EXIT } from '../src/cli-support.mjs';
import { normaliseForKey, sentenceContaining } from '../src/coach-rulings.mjs';
import { makeProject, runScript, tryMakeFileLink } from './_helpers.mjs';

import { fileURLToPath } from 'node:url';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// --------------------------------------------------------------------------------------
// G4 — the rulings matcher. It presents a coach report with prior rulings collapsed
// against it.
//
// THE PROPERTY THE WHOLE STAGE EXISTS FOR: a ruling that AGREES the defect is real does
// NOT suppress it. Only waived / false alarm / taste collapse. And because the key
// includes a hash of the sentence the finding quotes, any edit to that sentence re-opens
// the finding — you cannot silence a finding by rewording the sentence it cites.
//
// So every test below that makes a finding disappear is asserting a NARROW permission, and
// the tests that matter most are the ones asserting a finding STAYS.
// --------------------------------------------------------------------------------------

const SCRIPT = `# Script

### 1 \u00b7 \`hard\` \u00b7 0:01\u20130:27

> A unit test is easy. One input, one answer; and the same answer every time. It was so slow that customers were finding the regressions before we did.

### 2 \u00b7 \`scenario\` \u00b7 0:29\u20131:20

> Let's look at one specific scenario definition. The opening is deliberately vague, because that is how people actually write.
`;

// The quotes below are COPIED OUT OF `SCRIPT` above, not retyped. A fixture whose
// identifiers I chose myself matches perfectly and proves nothing; these have to survive
// the same verbatim check a real report's quotes do.
const QUOTE_A = 'customers were finding the regressions before we did';
const QUOTE_B = 'deliberately vague';
const SENTENCE_A = 'It was so slow that customers were finding the regressions before we did.';

function report({ manifest = 'MANIFEST_PATH', defects = [QUOTE_A], advisory = [], pass = 2 } = {}) {
  const finding = (q, i) =>
    `  - [OBJ-0${i + 1}] script.md @ seg-${i}\n    QUOTE: ${q}\n    The line does not land. Fix: tighten it.`;
  return [
    `COACH REPORT \u2014 pass ${pass}`,
    '',
    'COACH-MODEL: gpt-6-sol',
    'AUTHOR-MODEL: claude-opus-5',
    'INDEPENDENCE-CHECK: pass',
    'RUBRIC: tools/SizzleCraft/coach/rubric.md',
    `MANIFEST: ${manifest}`,
    `COUNTS: defects ${defects.length} \u00b7 advisory ${advisory.length} \u00b7 not evaluated 0`,
    '',
    'DEFECTS:',
    defects.length ? defects.map(finding).join('\n') : '  - none',
    '',
    'ADVISORY:',
    advisory.length ? advisory.map(finding).join('\n') : '  - none',
    '',
    'NOT EVALUATED:',
    '  - [OBJ-19] no stills for this pass \u2014 covered by: pass 2',
    '',
    'FILES READ:',
    '  - script.md',
    '',
  ].join('\n');
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A project with a script, a manifest that binds it, and a coach report citing that
// manifest. Mirrors what coach-pack actually writes.
function projectWithReport(t, { scriptText = SCRIPT, rulings = null, reportOpts = {} } = {}) {
  const dir = makeProject(t, { 'script.md': scriptText });
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        pass: 2,
        rubric: 'tools/SizzleCraft/coach/rubric.md',
        files: [{ file: 'script.md', bytes: Buffer.byteLength(scriptText), sha256: sha(Buffer.from(scriptText)), role: 'script' }],
        audit: { issues: [] },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(dir, 'coach-report.md'), report({ manifest: 'manifest.json', ...reportOpts }));
  if (rulings) fs.writeFileSync(path.join(dir, 'coach-rulings.json'), `${JSON.stringify(rulings, null, 2)}\n`);
  return dir;
}

const run = (dir, args = []) => runScript('coach-rulings.mjs', ['--report', 'coach-report.md', ...args], dir);

// Reads the key the stage itself printed, so a test never has to recompute the hash rule.
// A test that recomputed it would pass even if the rule were wrong in both places.
const RULINGS = 'coach-rulings.json';
const keysIn = (output) => [...output.matchAll(/key: ([0-9a-f]{8,})/g)].map((m) => m[1]);

// Section-precise, because the crude version of these assertions was wrong in a way that
// looked right: `doesNotMatch(all, /waived/)` failed on correct output, since an orphaned
// waiver legitimately prints the word "waived" in its own section. An assertion that
// cannot tell NEW from ORPHANED is not testing the thing it claims to test.
//
// LINE-BASED. The regex version of this stopped at the first end-of-line, because `$` under
// the `m` flag matches there — the same defect that was in the parser, reproduced here in
// the helper written to check it. A section header is a line; find it by reading lines.
//
// Deliberately permissive about the header's prose: my first attempt required the count to
// follow the name directly and so never matched "COLLAPSED under a prior ruling (0):",
// which made countIn return -1 and two correct behaviours look broken. A header is any
// top-level line ending in "(<n>):".
const SECTION_HEAD = /^[A-Z][^\n]*\((\d+)\):$/;
const headerFor = (output, name) => output.split('\n').find((l) => SECTION_HEAD.test(l) && l.startsWith(name));
const section = (output, name) => {
  const lines = output.split('\n');
  const start = lines.indexOf(headerFor(output, name) ?? '\u0000');
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => SECTION_HEAD.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
};
const countIn = (output, name) => {
  const line = headerFor(output, name);
  return line ? Number(line.match(SECTION_HEAD)[1]) : -1;
};

describe('coach-rulings presents a report with prior rulings collapsed against it', () => {
  test('coachRulings_withNoRulingsFile_showsEveryFindingAsNew', (t) => {
    const dir = projectWithReport(t);

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /NEW/, r.all);
    assert.match(r.all, /OBJ-01/, r.all);
    assert.equal(keysIn(r.all).length, 1, `one finding, one key\n${r.all}`);
  });

  // THE REFUSAL THE MANIFEST EXISTS FOR.
  test('coachRulings_reportCitingAManifestWhoseInputsHaveChanged_refuses', (t) => {
    const dir = projectWithReport(t);
    fs.writeFileSync(path.join(dir, 'script.md'), `${SCRIPT}\nA sentence added after the review.\n`);

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, `a report about older bytes must not be presented as current\n${r.all}`);
    assert.match(r.all, /script\.md/, 'it must name which input moved');
    assert.doesNotMatch(r.all, /NEW/, 'and present nothing');
  });

  test('coachRulings_pass2ReportWithNoManifestLine_refusesRatherThanMatchingBlind', (t) => {
    const dir = projectWithReport(t, { reportOpts: { manifest: 'none' } });

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.match(r.all, /manifest/i, r.all);
  });

  // UNKEYABLE: shown as new AND flagged. Never dropped, never collapsed.
  test('coachRulings_quoteNotFoundVerbatimInItsInput_isFlaggedUnkeyableAndShownAsNew', (t) => {
    const dir = projectWithReport(t, { reportOpts: { defects: ['a quote the coach paraphrased instead of copying'] } });

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /UNKEYABLE/, `it must be flagged, not silently dropped\n${r.all}`);
    assert.match(r.all, /NEW/, 'and presented as new');
    assert.match(r.all, /paraphrased/, 'with its text still visible');
  });

  test('coachRulings_anUnkeyableFinding_cannotCollapseUnderAnyRuling', (t) => {
    const unkeyable = 'a quote the coach paraphrased instead of copying';
    const dir = projectWithReport(t, {
      reportOpts: { defects: [unkeyable] },
      // A ruling that tries to waive it by quoting the same unkeyable text.
      rulings: { version: 1, rulings: [{ key: sha(unkeyable).slice(0, 16), rule: 'OBJ-01', segment: 'seg-0', ruling: 'waived' }] },
    });

    const r = run(dir);

    assert.match(r.all, /UNKEYABLE/, r.all);
    assert.equal(countIn(r.all, 'COLLAPSED'), 0, `an unkeyable finding must not collapse under anything\n${r.all}`);
    assert.match(section(r.all, 'NEW'), /UNKEYABLE/, 'it belongs in NEW');
    // The waiver itself is correctly orphaned — it keys to nothing, which is the whole
    // point. Asserting it vanished entirely would have demanded the wrong behaviour.
    assert.equal(countIn(r.all, 'ORPHANED'), 1, r.all);
  });
});

describe('coach-rulings collapses only the three rulings that permit it', () => {
  // Obtains the real key by running the stage once, so the ruling is keyed the way the
  // stage keys it rather than the way a test guesses.
  function ruleFor(t, ruling, opts = {}) {
    const dir = projectWithReport(t, opts);
    const first = run(dir);
    const [key] = keysIn(first.all);
    assert.ok(key, `the stage must print a key to rule on\n${first.all}`);
    fs.writeFileSync(
      path.join(dir, 'coach-rulings.json'),
      `${JSON.stringify({ version: 1, rulings: [{ key, rule: 'OBJ-01', segment: 'seg-0', ruling, note: 'because' }] }, null, 2)}\n`,
    );
    return { dir, key };
  }

  // THE ONE THAT MATTERS MOST. Agreeing a defect is real must not make it go away.
  //
  // Asserted on the SECTION CONTENTS, not on the heading. My first version matched
  // /ruled valid, still unfixed/ against the whole output — which is the heading, printed
  // unconditionally — so it passed even when the section was empty. A mutant that made
  // "valid" collapse like a waiver SURVIVED it. The assertion was weaker than its claim.
  test('coachRulings_findingRuledValid_staysOpenAndSaysStillUnfixed', (t) => {
    const { dir } = ruleFor(t, 'valid');

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(countIn(r.all, 'OPEN'), 1, `a valid ruling must NOT suppress the finding\n${r.all}`);
    assert.match(section(r.all, 'OPEN'), /OBJ-01/, `and the finding itself must be in that section\n${r.all}`);
    assert.equal(countIn(r.all, 'COLLAPSED'), 0, 'it is emphatically not collapsed');
    assert.equal(countIn(r.all, 'NEW'), 0, 'nor new — it has been ruled on');
  });

  for (const ruling of ['waived', 'false-alarm', 'taste']) {
    test(`coachRulings_findingRuled_${ruling}_collapsesUnderItsRuling`, (t) => {
      const { dir } = ruleFor(t, ruling);

      const r = run(dir);

      assert.equal(r.code, EXIT.OK, r.all);
      assert.equal(countIn(r.all, 'COLLAPSED'), 1, `a ${ruling} finding collapses\n${r.all}`);
      assert.match(section(r.all, 'COLLAPSED'), new RegExp(ruling), 'under its own ruling');
      assert.equal(countIn(r.all, 'NEW'), 0, `a ${ruling} finding is not new\n${r.all}`);
      assert.equal(countIn(r.all, 'OPEN'), 0, 'and not open');
    });
  }

  // ANTI-SUPPRESSION: you cannot silence a finding by rewording the sentence it cites.
  test('coachRulings_sentenceRewordedAfterAWaiver_reopensTheFindingAsNew', (t) => {
    const { dir } = ruleFor(t, 'waived');
    // The quote still appears verbatim, so this is not an unkeyable case — it is the same
    // quote inside an EDITED sentence, which is exactly what must re-open.
    const edited = SCRIPT.replace('It was so slow that', 'It was so extremely slow that');
    fs.writeFileSync(path.join(dir, 'script.md'), edited);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.files[0] = { ...m.files[0], bytes: Buffer.byteLength(edited), sha256: sha(Buffer.from(edited)) };
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(countIn(r.all, 'NEW'), 1, `rewording the cited sentence must re-open it\n${r.all}`);
    assert.equal(countIn(r.all, 'COLLAPSED'), 0, `the old waiver must not reach the edited sentence\n${r.all}`);
    // And the stranded waiver surfaces rather than vanishing — that is the signal that
    // someone may have reworded the text instead of fixing it.
    assert.equal(countIn(r.all, 'ORPHANED'), 1, r.all);
  });

  // ORPHANED: a ruling that matches nothing is evidence either way — the defect was fixed,
  // or the sentence was reworded to evade it. Dropping it silently is the failure mode this
  // whole stage exists to prevent.
  test('coachRulings_rulingThatMatchesNothing_isReportedAsOrphanedNotDropped', (t) => {
    const dir = projectWithReport(t, {
      rulings: { version: 1, rulings: [{ key: 'deadbeefdeadbeef', rule: 'OBJ-99', segment: 'seg-7', ruling: 'waived' }] },
    });

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /ORPHANED/, `a ruling matching nothing must surface\n${r.all}`);
    assert.match(r.all, /OBJ-99/, 'and name itself');
  });
});

describe('coach-rulings records a ruling only on the user\u2019s word', () => {
  test('coachRulings_plan_doesNotWriteARulingsFile', (t) => {
    const dir = projectWithReport(t);
    const [key] = keysIn(run(dir).all);

    const r = run(dir, ['--rule', `${key}=waived`]);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.existsSync(path.join(dir, RULINGS)), false, 'a plan records nothing');
    assert.match(r.all, /plan/i, 'and says so');
  });

  test('coachRulings_apply_recordsTheRulingAgainstTheKeyTheStagePrinted', (t) => {
    const dir = projectWithReport(t);
    const [key] = keysIn(run(dir).all);

    const r = run(dir, ['--rule', `${key}=waived`, '--apply']);

    assert.equal(r.code, EXIT.OK, r.all);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'coach-rulings.json'), 'utf8'));
    assert.equal(saved.rulings.length, 1, JSON.stringify(saved));
    assert.equal(saved.rulings[0].key, key);
    assert.equal(saved.rulings[0].ruling, 'waived');
  });

  test('coachRulings_apply_refusesARulingWordItDoesNotKnow', (t) => {
    const dir = projectWithReport(t);
    const [key] = keysIn(run(dir).all);

    const r = run(dir, ['--rule', `${key}=probably-fine`, '--apply']);

    assert.notEqual(r.code, EXIT.OK, `an unknown ruling word must not be recorded\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'coach-rulings.json')), false);
  });

  test('coachRulings_apply_refusesARulingForAKeyNotInThisReport', (t) => {
    const dir = projectWithReport(t);

    const r = run(dir, ['--rule', 'deadbeefdeadbeef=waived', '--apply']);

    assert.notEqual(r.code, EXIT.OK, `a ruling must name a finding actually present\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'coach-rulings.json')), false);
  });
});

// --------------------------------------------------------------------------------------
// THE KEYING RULE, PINNED AGAINST REAL TEXT.
//
// A fixture whose identifiers I chose myself matches perfectly and proves nothing — my own
// rule, learned when a preview fixture used slide ids equal to segment ids and made a
// broken filter look correct. So these read the SHIPPED EvalLoopDemo script off disk and
// key against sentences copied out of it, markdown, decimals, en-dashes and all.
//
// The rule was MEASURED, not chosen: five normalisations were scored on whether they
// re-open the edits an author really makes and collapse the ones that are not edits.
// This matrix is that measurement, kept executable so the rule cannot drift silently.
// --------------------------------------------------------------------------------------
describe('the keying rule, against the shipped EvalLoopDemo script', () => {
  const SCRIPT_PATH = path.join(SRC_DIR, '..', '..', 'EvalLoopDemo', 'script.md');
  const realScript = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const keyOf = (s) => crypto.createHash('sha256').update(normaliseForKey(s)).digest('hex');

  // Copied out of the real file, not retyped. If the script is ever reworded this test
  // fails loudly rather than quietly testing nothing.
  const REAL_QUOTE = 'customers were finding the regressions before we did';

  test('realScript_stillContainsTheQuoteTheseTestsKeyOn', () => {
    assert.ok(
      realScript.includes(REAL_QUOTE),
      'the shipped script no longer contains the quote these tests are built on — update them deliberately',
    );
  });

  test('sentenceContaining_findsTheWholeSentenceAroundARealQuote_notTheWholeParagraph', () => {
    const s = sentenceContaining(realScript, REAL_QUOTE);

    assert.ok(s.includes(REAL_QUOTE), s);
    assert.ok(s.startsWith('It was so slow'), `it must start at the sentence boundary, got: ${s.slice(0, 60)}`);
    assert.ok(s.endsWith('.'), `and end at one, got: ${s.slice(-40)}`);
    assert.ok(!s.includes('A unit test is easy'), 'and must not swallow the preceding sentence');
  });

  test('sentenceContaining_doesNotSplitOnADecimalPointInRealMeasuredProse', () => {
    const s = sentenceContaining(realScript, 'lead-in 2.04s');

    assert.ok(s.includes('2.04s'), s);
    assert.ok(s.includes('2.0s target'), `the decimal must not end the sentence: ${s.slice(0, 120)}`);
  });

  test('sentenceContaining_returnsNullForAQuoteThatIsNotThere_ratherThanGuessing', () => {
    assert.equal(sentenceContaining(realScript, 'a sentence that was never in this script'), null);
  });

  // THE MEASURED MATRIX. want=true means the edit MUST re-open the finding.
  const BASE = sentenceContaining(realScript, REAL_QUOTE);
  const EDITS = [
    { label: 'identical', edit: (s) => s, reopens: false },
    { label: 'trailing whitespace', edit: (s) => `${s}   `, reopens: false },
    { label: 're-wrapped onto two lines', edit: (s) => s.replace(' so slow', '\nso slow'), reopens: false },
    { label: 'markdown emphasis added', edit: (s) => s.replace('slow', '**slow**'), reopens: false },
    { label: 'FIXED TYPO', edit: (s) => s.replace('regressions', 'regresions'), reopens: true },
    { label: 'REWORDED', edit: (s) => s.replace('so slow', 'so extremely slow'), reopens: true },
    { label: 'PUNCTUATION CHANGED', edit: (s) => s.replace('.', '!'), reopens: true },
  ];

  for (const { label, edit, reopens } of EDITS) {
    test(`normaliseForKey_${label.replace(/\W+/g, '_')}_${reopens ? 'reopens' : 'collapses'}`, () => {
      const changed = keyOf(edit(BASE)) !== keyOf(BASE);

      assert.equal(changed, reopens, `"${label}" should ${reopens ? 'RE-OPEN' : 'collapse'}\n  base: ${BASE}\n  edit: ${edit(BASE)}`);
    });
  }

  // The dash case needs a sentence that actually CONTAINS a dash. My first attempt appended
  // one to a dash-free sentence and called it a "swap" — that is an edit to the text, and it
  // correctly re-opened. The test was wrong, not the rule.
  test('normaliseForKey_emDashAndEnDashAreTheSameKey_onARealSentenceThatHasOne', () => {
    const withEm = sentenceContaining(realScript, 'that is the detail separating this');
    assert.ok(withEm && /[\u2013\u2014]/.test(withEm), `this test needs a real sentence carrying a dash, got: ${withEm}`);

    const swapped = withEm.replace(/[\u2014]/g, '\u2013');

    assert.notEqual(swapped, withEm, 'the swap must actually change the raw text');
    assert.equal(keyOf(swapped), keyOf(withEm), 'but it must not change the key');
  });

  // THE BLIND SPOT, PINNED AS A FAILING-BY-DESIGN EXPECTATION. Stripping markdown means a
  // finding ABOUT formatting does not re-open when the formatting is fixed. That is the
  // price of not re-opening every finding whenever someone bolds a word, and it is written
  // down here so the next person meets it as a decision rather than as a surprise.
  test('normaliseForKey_knownBlindSpot_aFormattingOnlyFixDoesNotReopen', () => {
    const bolded = BASE.replace('slow', '**slow**');

    assert.equal(keyOf(bolded), keyOf(BASE), 'documented blind spot: emphasis is invisible to this key');
  });

  test('normaliseForKey_knownBlindSpot_snakeCaseCollapsesWithItsStrippedForm', () => {
    assert.equal(keyOf('the field is snake_case here'), keyOf('the field is snakecase here'));
  });
});
// --------------------------------------------------------------------------------------
// THE G4/G5 INTERFACE SEAM. The agent contract's prose says a still-only finding names the
// still and "its hash is the key", but its REQUIRED output template shows `QUOTE:`
// unconditionally under DEFECTS and ADVISORY and tells the agent to emit exactly that.
// The two halves disagree, so a conforming agent will either omit the quote (prose) or
// invent one for an image (template). This parser tolerates the first and is honest about
// the second; the defect is in the pair, and the agent file is the orchestrator's.
// --------------------------------------------------------------------------------------
describe('coach-rulings keys a still-only finding on the still, not on a quote', () => {
  const STILL_BYTES = Buffer.from('fake png bytes for a still');
  const stillSha = crypto.createHash('sha256').update(STILL_BYTES).digest('hex');

  function projectWithStill(t, { quote = null } = {}) {
    const dir = makeProject(t, { 'script.md': SCRIPT });
    fs.mkdirSync(path.join(dir, 'preview'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'preview', 'big.png'), STILL_BYTES);
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          pass: 2,
          files: [
            { file: 'script.md', bytes: Buffer.byteLength(SCRIPT), sha256: sha(Buffer.from(SCRIPT)), role: 'script' },
            { file: 'preview/big.png', bytes: STILL_BYTES.length, sha256: stillSha, role: 'still' },
          ],
          audit: { issues: [] },
        },
        null,
        2,
      )}\n`,
    );
    const quoteLine = quote === null ? '' : `\n    QUOTE: ${quote}`;
    fs.writeFileSync(
      path.join(dir, 'coach-report.md'),
      [
        'COACH REPORT \u2014 pass 2',
        '',
        'MANIFEST: manifest.json',
        'COUNTS: defects 1 \u00b7 advisory 0 \u00b7 not evaluated 0',
        '',
        'DEFECTS:',
        `  - [OBJ-19] preview/big.png @ big${quoteLine}`,
        '    One element is drawn across another. Fix: raise the gap.',
        '',
        'FILES READ:',
        '  - preview/big.png',
        '',
      ].join('\n'),
    );
    return dir;
  }

  test('coachRulings_stillOnlyFindingWithNoQuote_isKeyedOnTheStillRatherThanFlaggedUnkeyable', (t) => {
    const dir = projectWithStill(t);

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(r.all, /UNKEYABLE/, `a still finding has no text to quote; that is not a defect\n${r.all}`);
    assert.match(r.all, /keyed on|still big\.png/, `and it must say what it keyed on\n${r.all}`);
    assert.equal(keysIn(r.all).length, 1, 'it is keyed');
  });

  // The still's hash IS the key, so re-shooting the still re-opens the finding — the same
  // anti-suppression property the sentence hash gives a text finding.
  test('coachRulings_stillChangedAfterTheRuling_reopensBecauseTheHashIsTheKey', (t) => {
    const dir = projectWithStill(t);
    const [key] = keysIn(run(dir).all);
    fs.writeFileSync(
      path.join(dir, RULINGS),
      `${JSON.stringify({ version: 1, rulings: [{ key, rule: 'OBJ-19', segment: 'big', ruling: 'waived' }] }, null, 2)}\n`,
    );
    assert.equal(countIn(run(dir).all, 'COLLAPSED'), 1, 'it collapses while the still is unchanged');

    // Re-shoot the still, and re-bind the manifest to the new bytes as preview would.
    const fresh = Buffer.from('DIFFERENT png bytes after a re-shoot');
    fs.writeFileSync(path.join(dir, 'preview', 'big.png'), fresh);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.files[1] = {
      ...m.files[1],
      bytes: fresh.length,
      sha256: crypto.createHash('sha256').update(fresh).digest('hex'),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);

    const r = run(dir);

    assert.equal(countIn(r.all, 'COLLAPSED'), 0, `a re-shot still must re-open the finding\n${r.all}`);
    assert.equal(countIn(r.all, 'NEW'), 1, r.all);
    assert.equal(countIn(r.all, 'ORPHANED'), 1, 'and the stranded waiver surfaces');
  });

  // A finding with neither a usable quote nor a still is the genuinely unkeyable case, and
  // it must still be shown. This is the one that must never become a silent drop.
  test('coachRulings_findingWithNoQuoteAndNoStill_isFlaggedUnkeyableAndStillShown', (t) => {
    const dir = projectWithReport(t, { reportOpts: { defects: [] } });
    const text = fs
      .readFileSync(path.join(dir, 'coach-report.md'), 'utf8')
      // COUNTS is fixed up too: the stage cross-checks the agent's declared total against
      // what it could read, and refuses a mismatch. This fixture originally injected a
      // finding without updating the count, and the check correctly refused it.
      .replace('COUNTS: defects 0', 'COUNTS: defects 1')
      .replace('DEFECTS:\n  - none', 'DEFECTS:\n  - [OBJ-02] script.md @ seg-1\n    A claim with no evidence. Fix: cite it.');
    fs.writeFileSync(path.join(dir, 'coach-report.md'), text);

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(countIn(r.all, 'NEW'), 1, `it must be shown, not dropped\n${r.all}`);
    assert.match(section(r.all, 'NEW'), /UNKEYABLE/, 'and flagged');
    assert.match(r.all, /OBJ-02/, 'and named');
  });
});
// --------------------------------------------------------------------------------------
// THE WAYS A FINDING COULD VANISH FOR A REASON THAT IS NOT ONE OF THE THREE RULINGS.
// Every test here was written because a reviewer found the hole, not because I predicted
// it. They are the stage's real contract: a finding leaves the report only via waived,
// false-alarm or taste.
// --------------------------------------------------------------------------------------
describe('coach-rulings refuses rather than letting a finding fall out of every section', () => {
  // THE SHARPEST ONE. A stored ruling with an unrecognised word matched a key, so the
  // finding was not new (a ruling existed), not open (not "valid"), not collapsed (not a
  // collapsing word) and not orphaned (its key matched). It disappeared at exit 0 — the
  // exact suppression this stage exists to prevent, inside the stage itself.
  test('coachRulings_storedRulingWithAnUnknownWord_refusesInsteadOfHidingTheFinding', (t) => {
    const dir = projectWithReport(t);
    const [key] = keysIn(run(dir).all);
    fs.writeFileSync(
      path.join(dir, RULINGS),
      `${JSON.stringify({ version: 1, rulings: [{ key, rule: 'OBJ-01', ruling: 'pending' }] }, null, 2)}\n`,
    );

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, `an unreadable ruling must refuse, not hide a finding\n${r.all}`);
    assert.match(r.all, /pending/, 'and name the word it could not read');
    assert.equal(countIn(r.all, 'NEW'), -1, 'nothing is presented at all');
  });

  test('coachRulings_rulingsFileWithNoRulingsArray_refuses', (t) => {
    const dir = projectWithReport(t);
    fs.writeFileSync(path.join(dir, RULINGS), `${JSON.stringify({ version: 1 }, null, 2)}\n`);

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.match(r.all, /rulings array/, r.all);
  });

  // A bullet the parser cannot read is a finding deleted from the report.
  test('coachRulings_findingLineItCannotParse_refusesRatherThanPresentingAShorterReport', (t) => {
    const dir = projectWithReport(t);
    const text = fs
      .readFileSync(path.join(dir, 'coach-report.md'), 'utf8')
      .replace('COUNTS: defects 1', 'COUNTS: defects 2')
      .replace('DEFECTS:\n', 'DEFECTS:\n  - this bullet has no rule id and no location\n');
    fs.writeFileSync(path.join(dir, 'coach-report.md'), text);

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, `an unreadable finding line must not be skipped\n${r.all}`);
    assert.match(r.all, /could not be read/, r.all);
  });

  // The agent's own COUNTS is a free cross-check on this parser.
  test('coachRulings_reportWhoseCountsDisagreeWithWhatWasRead_refuses', (t) => {
    const dir = projectWithReport(t);
    const text = fs.readFileSync(path.join(dir, 'coach-report.md'), 'utf8').replace('COUNTS: defects 1', 'COUNTS: defects 3');
    fs.writeFileSync(path.join(dir, 'coach-report.md'), text);

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.match(r.all, /declares 3 finding\(s\) but 1 could be read/, r.all);
  });

  test('coachRulings_manifestBindingNoFiles_refusesBecauseEveryCheckWouldBeVacuous', (t) => {
    const dir = projectWithReport(t);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.files = [];
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, `an empty manifest makes the rehash prove nothing\n${r.all}`);
    assert.match(r.all, /binds no files/, r.all);
  });

  // A finding keyed from a file the manifest never bound would be keyed to bytes nobody
  // proved the coach read.
  test('coachRulings_findingCitingAFileTheManifestNeverBound_isUnkeyableNotKeyed', (t) => {
    const dir = projectWithReport(t);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'customers were finding the regressions before we did.\n');
    const text = fs.readFileSync(path.join(dir, 'coach-report.md'), 'utf8').replace('script.md @ seg-0', 'notes.md @ seg-0');
    fs.writeFileSync(path.join(dir, 'coach-report.md'), text);

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(section(r.all, 'NEW'), /UNKEYABLE/, `an unbound input cannot key a finding\n${r.all}`);
    assert.match(r.all, /not bound by the manifest/, r.all);
  });

  // A quote appearing twice has no single owning sentence. Taking the first occurrence
  // means editing the LATER one leaves a prior waiver collapsing a finding whose evidence
  // moved — silent suppression by ambiguity.
  test('coachRulings_quoteAppearingTwiceInTheInput_isUnkeyableRatherThanKeyedToTheFirst', (t) => {
    const doubled = `${SCRIPT}\n> It was so slow that customers were finding the regressions before we did.\n`;
    const dir = projectWithReport(t, { scriptText: doubled });

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(section(r.all, 'NEW'), /UNKEYABLE/, r.all);
    assert.match(r.all, /appears more than once/, r.all);
  });

  test('coachRulings_rulingsFileIsALinkToAnotherInRootFile_refusesWithoutWritingThroughIt', (t) => {
    const dir = projectWithReport(t);
    fs.writeFileSync(path.join(dir, 'victim.md'), 'ORIGINAL');
    if (!tryMakeFileLink(path.join(dir, RULINGS), path.join(dir, 'victim.md'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = run(dir, ['--rule', 'deadbeefdeadbeef=waived', '--apply']);

    assert.notEqual(r.code, EXIT.OK, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'victim.md'), 'utf8'), 'ORIGINAL', 'the victim keeps its bytes');
  });
});

// --------------------------------------------------------------------------------------
// THE MANIFEST LIVES WHERE coach-pack PUTS IT, NOT WHERE MY FIXTURE FOUND IT CONVENIENT.
// My original fixture wrote the manifest into the project, so the stage passed every test
// while being unable to read the manifest from the only stage that produces one. A fixture
// that reproduces the symptom is not a fixture that represents the system.
// --------------------------------------------------------------------------------------
describe('coach-rulings reads the manifest from the coach pack folder', () => {
  test('coachRulings_manifestPublishedInThePackFolder_isFoundAndMatched', (t) => {
    const dir = makeProject(t, { 'script.md': SCRIPT });
    const packDir = fs.mkdtempSync(path.join(SRC_DIR, '..', 'coach', 'pack', 'ruling-test-'));
    t.after(() => fs.rmSync(packDir, { recursive: true, force: true }));
    const manifestPath = path.join(packDir, 'manifest.json');
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          pass: 2,
          files: [{ file: 'script.md', bytes: Buffer.byteLength(SCRIPT), sha256: sha(Buffer.from(SCRIPT)), role: 'script' }],
          audit: { issues: [] },
        },
        null,
        2,
      )}\n`,
    );
    // Cited the way a dispatcher would: the path coach-pack printed, not a project-local one.
    fs.writeFileSync(path.join(dir, 'coach-report.md'), report({ manifest: manifestPath.replace(/\\/g, '/') }));

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, `the stage must read its own upstream stage's manifest\n${r.all}`);
    assert.equal(countIn(r.all, 'NEW'), 1, r.all);
    assert.equal(keysIn(r.all).length, 1, 'and key the finding');
  });
});
// Round-2 holes: a malformed bullet AFTER a good finding was absorbed as its body, and a
// missing COUNTS line disabled the only cross-check that would have noticed.
describe('coach-rulings cannot lose a finding to the shape of the report', () => {
  test('coachRulings_malformedBulletAfterAGoodFinding_isNotAbsorbedIntoItsBody', (t) => {
    const dir = projectWithReport(t);
    const text = fs
      .readFileSync(path.join(dir, 'coach-report.md'), 'utf8')
      .replace(
        '    The line does not land. Fix: tighten it.',
        '    The line does not land. Fix: tighten it.\n  - a second finding whose head is malformed',
      );
    fs.writeFileSync(path.join(dir, 'coach-report.md'), text);

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, `the second bullet must not vanish into the first's body\n${r.all}`);
    assert.match(r.all, /could not be read/, r.all);
    assert.match(r.all, /second finding whose head is malformed/, 'and the line is quoted back');
  });

  // Without COUNTS there is nothing to check the parse against, and the report most likely
  // to be malformed would be the one checked least.
  test('coachRulings_reportWithNoCountsLine_refusesRatherThanSkippingTheCrossCheck', (t) => {
    const dir = projectWithReport(t);
    const text = fs
      .readFileSync(path.join(dir, 'coach-report.md'), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('COUNTS:'))
      .join('\n');
    fs.writeFileSync(path.join(dir, 'coach-report.md'), text);

    const r = run(dir);

    assert.equal(r.code, EXIT.FAILED, `a missing COUNTS disables the only cross-check\n${r.all}`);
    assert.match(r.all, /no readable COUNTS/, r.all);
  });

  // The exit code for a planted link is 2, not 1, because the shared write guard raises it
  // as a usage error. Asserted exactly, because USAGE now documents that split and a code
  // that is documented but not produced is its own defect.
  test('coachRulings_linkedRulingsFile_exitsWithTheCodeUsageDocuments', (t) => {
    const dir = projectWithReport(t);
    fs.writeFileSync(path.join(dir, 'victim.md'), 'ORIGINAL');
    if (!tryMakeFileLink(path.join(dir, RULINGS), path.join(dir, 'victim.md'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = run(dir, ['--rule', 'deadbeefdeadbeef=waived', '--apply']);

    assert.equal(r.code, EXIT.USAGE, `USAGE documents this as 2\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'victim.md'), 'utf8'), 'ORIGINAL');
  });
});
// Round-3 holes: two ways a finding could collapse under a waiver recorded for a DIFFERENT
// finding. Both are the same family as everything else here — a finding disappearing for a
// reason that is not one of the three rulings — reached by varying the data, not the code.
describe('coach-rulings never lets one waiver reach a different finding', () => {
  const STILL = Buffer.from('fake png bytes');
  const stillSha = crypto.createHash('sha256').update(STILL).digest('hex');

  // A quote-free finding on an UNBOUND file could borrow a bound still's hash just by
  // naming it in its location.
  test('coachRulings_quoteFreeFindingOnAnotherFile_cannotBorrowABoundStillsKey', (t) => {
    const dir = makeProject(t, { 'script.md': SCRIPT, 'notes.md': 'unrelated notes\n' });
    fs.mkdirSync(path.join(dir, 'preview'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'preview', 'big.png'), STILL);
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          pass: 2,
          files: [
            { file: 'script.md', bytes: Buffer.byteLength(SCRIPT), sha256: sha(Buffer.from(SCRIPT)), role: 'script' },
            { file: 'preview/big.png', bytes: STILL.length, sha256: stillSha, role: 'still' },
          ],
          audit: { issues: [] },
        },
        null,
        2,
      )}\n`,
    );
    const write = (file, location) =>
      fs.writeFileSync(
        path.join(dir, 'coach-report.md'),
        [
          'COACH REPORT \u2014 pass 2',
          'MANIFEST: manifest.json',
          'COUNTS: defects 1 \u00b7 advisory 0 \u00b7 not evaluated 0',
          '',
          'DEFECTS:',
          `  - [OBJ-19] ${file} @ ${location}`,
          '    One element over another. Fix: raise the gap.',
          '',
        ].join('\n'),
      );

    // Rule on the real still finding.
    write('preview/big.png', 'big.png');
    const [stillKey] = keysIn(run(dir).all);
    assert.ok(stillKey, 'the still finding must be keyed');
    fs.writeFileSync(
      path.join(dir, RULINGS),
      `${JSON.stringify({ version: 1, rulings: [{ key: stillKey, rule: 'OBJ-19', ruling: 'waived' }] }, null, 2)}\n`,
    );
    assert.equal(countIn(run(dir).all, 'COLLAPSED'), 1, 'the real still finding collapses under its own waiver');

    // Now a DIFFERENT finding, on an unbound file, merely mentioning that still.
    write('notes.md', 'big.png');
    const r = run(dir);

    assert.equal(countIn(r.all, 'COLLAPSED'), 0, `a different file must not inherit the still's waiver\n${r.all}`);
    assert.match(section(r.all, 'NEW'), /UNKEYABLE/, 'it is unkeyable, and shown');
  });

  // Two bound files carrying the SAME sentence are two different findings.
  test('coachRulings_sameSentenceInTwoBoundFiles_areDifferentFindingsWithDifferentKeys', (t) => {
    const dir = makeProject(t, { 'script.md': SCRIPT, 'alt-script.md': SCRIPT });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          pass: 2,
          files: [
            { file: 'script.md', bytes: Buffer.byteLength(SCRIPT), sha256: sha(Buffer.from(SCRIPT)), role: 'script' },
            { file: 'alt-script.md', bytes: Buffer.byteLength(SCRIPT), sha256: sha(Buffer.from(SCRIPT)), role: 'script' },
          ],
          audit: { issues: [] },
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'coach-report.md'),
      [
        'COACH REPORT \u2014 pass 2',
        'MANIFEST: manifest.json',
        'COUNTS: defects 2 \u00b7 advisory 0 \u00b7 not evaluated 0',
        '',
        'DEFECTS:',
        '  - [OBJ-01] script.md @ seg-0',
        `    QUOTE: ${QUOTE_A}`,
        '    The line does not land. Fix: tighten it.',
        '  - [OBJ-01] alt-script.md @ seg-0',
        `    QUOTE: ${QUOTE_A}`,
        '    The line does not land here either. Fix: tighten it.',
        '',
      ].join('\n'),
    );

    const keys = keysIn(run(dir).all);

    assert.equal(keys.length, 2, 'both findings are keyed');
    assert.notEqual(keys[0], keys[1], 'and the same sentence in two files is not one finding');

    // Waiving one must leave the other standing.
    fs.writeFileSync(
      path.join(dir, RULINGS),
      `${JSON.stringify({ version: 1, rulings: [{ key: keys[0], rule: 'OBJ-01', ruling: 'waived' }] }, null, 2)}\n`,
    );
    const r = run(dir);

    assert.equal(countIn(r.all, 'COLLAPSED'), 1, r.all);
    assert.equal(countIn(r.all, 'NEW'), 1, `the other file's finding must survive the waiver\n${r.all}`);
  });

  // Exactly the sequence the reviewer described: two distinct defects on ONE still.
  test('coachRulings_twoFindingsOnOneStillThatKeyIdentically_areBothUnkeyableNotCollapsible', (t) => {
    const dir = makeProject(t, { 'script.md': SCRIPT });
    fs.mkdirSync(path.join(dir, 'preview'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'preview', 'big.png'), STILL);
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          pass: 2,
          files: [
            { file: 'script.md', bytes: Buffer.byteLength(SCRIPT), sha256: sha(Buffer.from(SCRIPT)), role: 'script' },
            { file: 'preview/big.png', bytes: STILL.length, sha256: stillSha, role: 'still' },
          ],
          audit: { issues: [] },
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'coach-report.md'),
      [
        'COACH REPORT \u2014 pass 2',
        'MANIFEST: manifest.json',
        'COUNTS: defects 2 \u00b7 advisory 0 \u00b7 not evaluated 0',
        '',
        'DEFECTS:',
        '  - [OBJ-19] preview/big.png @ big.png \u00b7 top-left',
        '    The title overlaps the diagram. Fix: move it down.',
        '  - [OBJ-19] preview/big.png @ big.png \u00b7 bottom-right',
        '    The caption is clipped. Fix: shorten it.',
        '',
      ].join('\n'),
    );

    const r = run(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(keysIn(r.all).length, 0, `neither may be keyed, since the key cannot tell them apart\n${r.all}`);
    assert.equal(countIn(r.all, 'NEW'), 2, 'both are shown');
    assert.match(r.all, /key identically/, 'and the reason is given');
    assert.match(r.all, /top-left/, 'both defects remain legible');
    assert.match(r.all, /bottom-right/, r.all);
  });
});