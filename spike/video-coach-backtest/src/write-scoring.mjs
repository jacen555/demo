#!/usr/bin/env node
// Scores the backtest under the README's "Scoring (defined before results)" and writes scoring.md.
//
// What each input is, and why it is trusted:
//   - README.md, answer-key.md, inputs.md, runs.md, r1-resolution.json and rubric.md are read from
//     HEAD, never from the working tree, so every number is traceable to a commit.
//   - The eight coach reports are read from --runs and must match runs.md byte for byte.
//   - The user's judgments come from the session event log (--events): the 25 ask_user exchanges
//     from "1 of 19" to "Q26, the last one". Each question is re-derived from the reports and the
//     key and compared with what was actually asked, so a question that offered the wrong items or
//     quoted the wrong finding stops the run instead of being scored.
//
// Nothing is corrected silently. A failed check stops the run with exit 1 and names the check.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import {
  EXIT,
  RECONSTRUCTED,
  ROUNDS,
  SPIKE_DIR,
  UsageError,
  canonical,
  gitText,
  main,
  pathExists,
  readBlobs,
  repoRoot,
  sha256,
} from './lib.mjs';

const USAGE = `
usage: node src/write-scoring.mjs --events <file> [--runs <dir>] [--apply [--replace]]

Scores the eight coach reports against the committed answer key, using the user's
judgments from the scoring exchanges, and writes scoring.md.

  --events <file>  the session event log (events.jsonl) that holds the scoring exchanges
  --runs <dir>     the coach reports, <round>-p<pass>.md (default: <tmp>/vcb/runs)
  --apply          write scoring.md (default: print it and write nothing)
  --replace        with --apply, overwrite an existing scoring.md
  --help           show this text

The protocol files are read from HEAD, so commit them first. Each report must match
runs.md byte for byte.

Exit codes: 0 success/plan · 1 failed · 2 bad usage
`.trimStart();

const OUT = path.join(SPIKE_DIR, 'scoring.md');
const CHECKS = [];
const SOURCES = [
  { key: 'readme', file: 'README.md' },
  { key: 'key', file: 'answer-key.md' },
  { key: 'inputs', file: 'inputs.md' },
  { key: 'runs', file: 'runs.md' },
  { key: 'r1', file: 'r1-resolution.json' },
  { key: 'rubric', file: 'rubric.md' },
];
// The coach's staging directory, as it appears in finding text. Used only with .replace.
const STAGE = /[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp\\coach\\[0-9a-f]{8}\\/g;
const CLASSES = [
  'objective',
  'craft',
  'not catchable before render',
  'not in these inputs',
  'not about this video',
];
const WHOLE = 'WHOLE';
const COACH_MODEL = 'gpt-6-sol';
const AUTHOR_MODEL = 'claude-opus-5';
const RUN_ORDER = ['r2p1', 'r2p2', 'r6p1', 'r6p2', 'r7p1', 'r7p2', 'r1p1', 'r1p2'];
const SECTIONS = ['BLOCKING', 'ADVISORY', 'NOT EVALUATED', 'FILES READ'];
const HEADER_FIELDS = ['COACH-MODEL', 'AUTHOR-MODEL', 'INDEPENDENCE-CHECK', 'RUBRIC', 'COUNTS'];
const LANE_ROWS = [
  { row: 1, name: 'text size', label: /text size/i, words: /text[ -]size/i },
  { row: 2, name: 'contrast of text', label: /contrast of text/i, words: /contrast/i },
  { row: 3, name: 'contrast of graphics', label: /contrast of graphics/i, words: /contrast/i },
  { row: 4, name: 'overflowing or clipped', label: /overflowing or clipped/i, words: /overflow|clipping/i },
  { row: 5, name: 'overlapping in time', label: /overlapping in time/i, words: /overlap/i },
];
const THROUGH_CHECK = 'OBJ-07, through its check procedure (see "Counts")';
const OBJECTIVE_EXPECTED = {
  'R2-06': { passes: [2], route: THROUGH_CHECK, lane: null },
  'R2-11': { passes: [1, 2], route: 'OBJ-07 (pass 2)', lane: null },
  'R6-10': { passes: [2], route: THROUGH_CHECK, lane: null },
  'R6-13': { passes: [2], route: 'none', lane: null },
  'R7-01': { passes: [1, 2], route: 'OBJ-08 (both passes)', lane: null },
};
const R1_EXPECTED = {
  'R1-04': { passes: [2], lane: 4 },
  'R1-11': { passes: [1, 2], lane: null },
};
// Each question: the findings it asked about, the segments it named, and the user's judgment.
const QUESTIONS = [
  { q: 1, findings: ['r2p2B1'], segments: ['many'], judged: 'valid' },
  { q: 2, findings: ['r2p2B2'], segments: ['blindspot'], judged: 'R2-11' },
  { q: 3, findings: ['r6p2B1'], segments: ['many'], judged: 'valid' },
  { q: 4, findings: ['r7p1B1', 'r7p2B2'], segments: ['many'], judged: 'valid' },
  { q: 5, findings: ['r7p2B1', 'r7p1A2'], segments: ['scenario'], judged: 'R7-01' },
  { q: 6, findings: ['r2p1A1', 'r2p2A1'], segments: ['scenario'], judged: 'typed' },
  { q: 7, findings: ['r2p1A2'], segments: ['twotier'], judged: 'typed' },
  { q: 8, findings: ['r2p1A3'], segments: [WHOLE], judged: 'false alarm' },
  { q: 9, findings: ['r2p2A2'], segments: ['loop'], judged: 'typed' },
  { q: 10, findings: ['r6p1A1'], segments: ['many', 'dimensions'], judged: 'typed' },
  { q: 11, findings: ['r6p1A2'], segments: [WHOLE], judged: 'taste' },
  { q: 12, findings: ['r6p2A1'], segments: ['blindspot'], judged: 'valid' },
  { q: 13, findings: ['r6p2A2'], segments: ['scenario'], judged: 'valid' },
  { q: 14, findings: ['r6p2A3'], segments: ['scenario'], judged: 'typed' },
  { q: 15, findings: ['r7p1A1'], segments: ['scenario'], judged: 'valid' },
  { q: 16, findings: ['r7p1A3'], segments: [WHOLE], judged: 'valid' },
  { q: 17, findings: ['r7p2A1'], segments: ['blindspot'], judged: 'valid' },
  { q: 18, findings: ['r7p2A3'], segments: ['scenario'], judged: 'false alarm' },
  { q: 19, findings: ['r7p2A2'], segments: ['loop'], judged: 'valid' },
  { q: 20, findings: ['r1p2B1'], segments: ['hard'], judged: 'valid' },
  { q: 21, findings: ['r1p2B2'], segments: ['many'], judged: 'valid' },
  { q: 22, findings: ['r1p2B3'], segments: ['blindspot'], judged: 'typed' },
  { q: 23, findings: ['r1p1A1'], segments: ['many'], judged: 'typed' },
  { q: 26, findings: ['r1p2A2'], segments: ['loop'], judged: 'valid' },
];
const LABELS = [...Array.from({ length: 19 }, (_, i) => i + 1), 'meta', 20, 21, 22, 23, 26];
const SELECTED_IDS = {
  2: 'R2-11 — can we add the webpage screenshots here?',
  5: `R7-01 — we're still saying "3 authored facts" when it's 4. We should update that part`,
};
// A typed answer is recorded by its opening words; the whole text is quoted in scoring.md.
const TYPED = {
  6: 'Unmatched and likely valid.',
  7: "Unmatched. It's something that is good to call out, but",
  9: 'Unmatched. Good feedback, but I would probably reject this one too.',
  10: 'This was something I changed that an earlier LLM pushed back on.',
  14: 'Unmatched: valid feedback, but',
  22: "I've already reviewed this one.",
  23: 'unmatched. Good callout, but too much detail for this one',
};
const UNMATCHED = [
  ['valid', 'Unmatched — valid (the review missed it)'],
  ['false alarm', 'Unmatched — false alarm'],
  ['taste', 'Unmatched — taste'],
];
const META = {
  firstLine: 'Scoring for the three scored rounds (r2, r6, r7) is complete.',
  choices: ["Yes — judge r1's findings too", "No — report r1's findings verbatim, unjudged"],
  answer: "User selected: Yes — judge r1's findings too",
};
// Q21 repeated the family Q1 had already judged.
const ASKED_IN_ERROR = { 21: 1 };
// Q22 was answered "already reviewed": its family had been asked as these questions.
const NOT_JUDGED = { 22: [2, 12, 17] };
const NOT_ASKED = {
  r1p1A2: { would: 24, repeats: [7] },
  r1p2A1: { would: 25, repeats: [8, 11, 16] },
};
// The first quoted phrase of each r1 BLOCKING finding, searched in Q1–19's findings.
const PHRASE_TEST = { 20: [], 21: [1], 22: [] };
const FAMILIES = [
  {
    id: 'count',
    re: /three different (grades|outputs)/,
    what: 'matches "three different grades" or "three different outputs"',
    members: ['r2p2B1', 'r6p2B1', 'r7p1B1', 'r7p2B2', 'r1p2B2'],
  },
  {
    id: 'interface',
    re: /Watch it drive the real (U I|interface)/,
    what: 'matches "Watch it drive the real U I" or "… interface"',
    members: ['r2p2B2', 'r6p2A1', 'r7p2A1', 'r1p2B3'],
  },
  {
    id: 'claims',
    re: /onedrive-data-loss/,
    what: 'names `onedrive-data-loss`',
    members: ['r2p1A1', 'r2p2A1', 'r6p2A2', 'r7p1A1'],
  },
  {
    id: 'craft-02',
    re: /^\[CRAFT-02\]/,
    what: 'rule CRAFT-02',
    members: ['r2p1A3', 'r6p1A2', 'r7p1A3', 'r1p2A1'],
  },
  { id: 'ids', re: /internal ids removed/, what: 'matches "internal ids removed"', members: ['r6p2A3', 'r7p2A3'] },
  {
    id: 'less-time',
    re: /less time than that/,
    what: 'matches "less time than that"',
    members: ['r2p1A2', 'r1p1A2'],
  },
];
const JUDGED_DIFFERENTLY = ['craft-02', 'ids'];
// Each probe's find string names one appendix bullet; its probe says which findings touch it.
const APPENDIX = [
  { find: 'land on three different grades', family: 'count' },
  { find: 'A filling bar, not a strobing grid.', re: /strobing|filling bar|authoring note/i, hits: [] },
  { find: 'the same lag as R6-10', re: /\b(lags?|reveal\w*|sooner|earlier)\b/i, hits: [] },
  { find: 'Then the panel below the totals slides in', re: /panel below the totals/i, hits: ['r1p2A2'] },
  {
    find: 'the same edge crossing as R6-13',
    re: /\b(cross\w*|collid\w*|overlap\w*|arrowheads?)\b/i,
    hits: [],
  },
  { find: 'Watch it drive the real U I', family: 'interface' },
  { find: 'onedrive-data-loss', family: 'claims' },
  { find: 'placed last', re: /placed last|\blast\b/i, hits: [] },
  {
    find: 'Defects that the README already discloses',
    re: /One line said less safe|c-caveat|\bNaN\b/i,
    hits: ['r7p2A2'],
  },
];
const CRAFT02_RULE =
  '- Rule: It is a defect-candidate (craft) when the number of top-level sections is so high, for a 3–6 minute video, that a viewer must track more top-level chunks than short-term memory comfortably holds at once.';
const CRAFT02_QUOTE = 'It is a defect-candidate (craft) when the number of top-level sections';
const CRAFT02_QUESTIONS = [8, 11, 16];
const WORD_CHECKS = [
  { name: '"type its ID"', re: /type its ID/i, expected: [3, 4] },
  { name: '"objective"', re: /\bobjective\b/i, expected: [22] },
  { name: '"(craft)"', re: /\(craft\)/, expected: CRAFT02_QUESTIONS },
];
// How a quoted finding is matched to the report, strictest first.
const LEVELS = [
  ['exact', (q, t) => q === t],
  ['excerpt', (q, t) => q.includes('…') && inOrder(t, q.split('…').map((s) => s.trim()))],
  ['folded', (q, t) => fold(q) === fold(t)],
  [
    'folded excerpt',
    (q, t) =>
      q.includes('…') &&
      inOrder(
        fold(t),
        fold(q)
          .split('…')
          .map((s) => s.trim()),
      ),
  ],
  ['tag and location', (q, t) => tagLoc(q) !== null && tagLoc(q) === tagLoc(t)],
];

await main(async () => {
  let cli;
  try {
    ({ values: cli } = parseArgs({
      options: {
        events: { type: 'string' },
        runs: { type: 'string' },
        apply: { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(`${err.message}\n\n${USAGE}`);
  }
  if (cli.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  if (cli.events === undefined) throw new UsageError(`--events is required\n\n${USAGE}`);
  if (cli.replace && !cli.apply) throw new UsageError(`--replace needs --apply\n\n${USAGE}`);
  const eventsFile = path.resolve(cli.events);
  const runsDir = path.resolve(cli.runs ?? path.join(os.tmpdir(), 'vcb', 'runs'));
  if (!(await pathExists(eventsFile))) throw new UsageError(`--events: no such file: ${eventsFile}`);
  if (!(await pathExists(runsDir))) throw new UsageError(`--runs: no such directory: ${runsDir}`);

  const repo = await repoRoot();
  const src = await readSources(repo);
  const readme = parseReadme(src.readme.lines);
  const key = parseKey(src.key.lines, readme);
  checkKinds(key);
  const r1 = parseR1(src.inputs.lines, src.r1.text, key);
  const runs = parseRuns(src.runs.lines);
  const F = await readReports(runsDir, runs, key, r1);
  const family = checkFamilies(F);
  const window = await readWindow(eventsFile);
  const X = checkExchanges(window, F, key, r1, family, src.rubric.lines);
  const S = scoreAll(key, r1, F, X, readme, runs, family);
  const text = render({ src, readme, key, r1, runs, F, family, window, X, S });
  guardPrivacy(text);

  if (!cli.apply) {
    console.log(text);
    console.log(`\nplan only — would write ${OUT}. Re-run with --apply.`);
    return EXIT.OK;
  }
  if ((await pathExists(OUT)) && !cli.replace) throw new UsageError(`${OUT} exists; pass --replace to overwrite it`);
  await fs.writeFile(OUT, text, 'utf8');
  console.log(`wrote ${OUT} · ${Buffer.byteLength(text)} bytes · sha256 ${sha256(text)}`);
  return EXIT.OK;
});

// Helpers are function declarations: the top-level await above runs before any const below it is initialised.

function check(label, cond, detail = '') {
  if (!cond) throw new Error(`check failed: ${label}${detail === '' ? '' : `: ${detail}`}`);
  CHECKS.push(label);
}

function same(label, actual, expected, where = '') {
  const a = canonical(actual);
  const e = canonical(expected);
  check(label, a === e, `${where === '' ? '' : `${where}: `}got ${a}, expected ${e}`);
}

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((s) => s.trim().replace(/\\\|/g, '|'));
}

function squash(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return squash(s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
}

function plain(s) {
  return s.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function inOrder(hay, pieces) {
  let at = 0;
  for (const p of pieces) {
    if (!p) continue;
    const i = hay.indexOf(p, at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return true;
}

function tagLoc(s) {
  return s.match(/^\[[^\]]+\] (.*?) — /)?.[0] ?? null;
}

function isSeparator(line) {
  return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line ?? '');
}

function onlyIndex(lines, pred, label) {
  const hits = [];
  lines.forEach((l, i) => {
    if (pred(l)) hits.push(i);
  });
  check(label, hits.length === 1, `${hits.length} matches`);
  return hits[0];
}

function classesOf(cell) {
  const text = cell.replace(/\*\*/g, '');
  return CLASSES.filter((c) => new RegExp(`\\b${c}\\b`).test(text));
}

function uniqSorted(xs) {
  return [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function bySegment(list, order) {
  return [...list].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

async function readSources(repo) {
  const spikeRel = path.relative(repo, SPIKE_DIR).split(path.sep).join('/');
  const rels = SOURCES.map((s) => `${spikeRel}/${s.file}`);
  const dirty = await gitText(repo, ['status', '--porcelain=v1', '--', ...rels]);
  if (dirty !== '') throw new UsageError(`commit the protocol files first; git status shows:\n${dirty}`);
  const oids = (await gitText(repo, ['rev-parse', ...rels.map((r) => `HEAD:${r}`)])).split(/\r?\n/);
  check(
    'sources: each protocol file is one blob at HEAD',
    oids.length === SOURCES.length && oids.every((o) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(o)),
    oids.join(' '),
  );
  const blobs = await readBlobs(repo, oids);
  const out = {};
  SOURCES.forEach((s, i) => {
    const buf = blobs.get(oids[i]);
    if (!buf) throw new Error(`blob ${oids[i]} (${s.file}) was not read`);
    const text = buf.toString('utf8');
    out[s.key] = { file: s.file, oid: oids[i], text, lines: text.split(/\r?\n/) };
  });
  return out;
}

function parseReadme(lines) {
  const start = onlyIndex(
    lines,
    (l) => l === '### Scoring (defined before results)',
    'README: the Scoring heading appears once',
  );
  const end = onlyIndex(
    lines,
    (l) => l === '### Contamination — disclosed, not eliminated',
    'README: the Contamination heading appears once',
  );
  check('README: Scoring ends where Contamination begins', start < end, `${start + 1} vs ${end + 1}`);
  const scoring = lines.slice(start, end);
  while (scoring.length > 0 && scoring.at(-1).trim() === '') scoring.pop();
  const flat = squash(scoring.join('\n'));
  const bar = /\*\*Bar\*\*: recall ≥ (\d+)\s*%\s+\*\*and\*\*\s+precision ≥ (\d+)\s*%/.exec(flat);
  check('README: Scoring states the bar', bar !== null);
  const recallPct = Number(bar[1]);
  const precisionPct = Number(bar[2]);
  same('README: the bar is recall ≥ 50 % and precision ≥ 80 %', [recallPct, precisionPct], [50, 80]);
  check(
    'README: Scoring says the commit-backed result governs a disagreement',
    flat.includes('If they disagree, the commit-backed result governs.'),
  );

  const at = onlyIndex(
    lines,
    (l) => l.startsWith('  | Lane, as the brief put it | At the r4–r7 engines |'),
    'README: the lane table appears once',
  );
  check('README: the lane table lies outside Scoring', at >= end || at < start);
  const lane = lines.slice(at, at + 8);
  check('README: the lane table is 8 lines', lane.length === 8 && lane.every((l) => l.startsWith('  |')));
  check('README: the lane table has a separator row', isSeparator(lane[1]));
  check('README: a blank line follows the lane table', lines[at + 8] === '');
  const laneRows = lane.slice(2).map((l) => cells(l));
  LANE_ROWS.forEach((r, i) =>
    check(`README: lane row ${r.row} is ${r.name}`, r.label.test(laneRows[i][0]), laneRows[i][0]),
  );
  check('README: lane row 6 is subtitles and loudness', /Subtitles; loudness/.test(laneRows[5][0]), laneRows[5][0]);
  return {
    recallPct,
    precisionPct,
    scoringLines: scoring.length,
    scoringHash: sha256(scoring.join('\n')),
    laneHash: sha256(lane.join('\n')),
  };
}

function parseKey(lines, readme) {
  const flat = squash(lines.join('\n'));
  const om = /From r2 on, the order is the same in every round: ((?:\d `[a-z]+`(?:, )?)+)\./.exec(flat);
  check('key: states the segment order from r2 on', om !== null);
  const order = [];
  for (const m of om[1].matchAll(/(\d) `([a-z]+)`/g)) {
    check('key: the segment order is numbered 1, 2, 3, …', Number(m[1]) === order.length + 1, m[0]);
    order.push(m[2]);
  }
  check('key: the order names eight segments, each once', order.length === 8 && new Set(order).size === 8);

  const heads = [];
  lines.forEach((l, i) => {
    if (l.startsWith('## ')) heads.push(i);
  });
  const rounds = [];
  heads.forEach((i, n) => {
    const m = /^## (r\d+): (.*) \((reconstructed|commit-backed|descriptive only)\)$/.exec(lines[i]);
    if (!m) return;
    const end = n + 1 < heads.length ? heads[n + 1] : lines.length;
    rounds.push({ id: m[1], kind: m[3], heading: lines[i].slice(3), section: lines.slice(i, end) });
  });
  same(
    'key: the round sections are r2, r6, r7 and r1, in that order',
    rounds.map((r) => r.id),
    ['r2', 'r6', 'r7', 'r1'],
  );

  for (const r of rounds) {
    const descriptive = r.kind === 'descriptive only';
    const hi = onlyIndex(
      r.section,
      (l) => /^\| ID \| Seg \| The user['’]s words \(excerpt\) \| Class \|/.test(l),
      `key: ${r.id} has one item table`,
    );
    const head = cells(r.section[hi]);
    check(
      'key: item tables are ID, Seg, words, Class and, in scored rounds, Fixed by',
      head.length === (descriptive ? 4 : 5) && (descriptive || head[4] === 'Fixed by'),
      head.join(' | '),
    );
    check('key: item tables have a separator row', isSeparator(r.section[hi + 1]));
    r.items = [];
    for (let i = hi + 2; i < r.section.length && r.section[i].startsWith('|'); i++) {
      const c = cells(r.section[i]);
      check('key: item rows have one cell per column', c.length === head.length, `${r.id} row ${r.items.length + 1}`);
      const idm = /^(\*\*)?(R\d+-\d\d)(\*\*)?$/.exec(c[0]);
      check('key: item IDs are R<round>-NN, bold or plain', idm !== null && (idm[1] ?? '') === (idm[3] ?? ''), c[0]);
      const id = idm[2];
      const want = `R${r.id.slice(1)}-${String(r.items.length + 1).padStart(2, '0')}`;
      check('key: item IDs are numbered in order within their round', id === want, `${id}, expected ${want}`);
      check('key: Seg is a digit from 1 to 8, or a dash', /^([1-8]|—)$/.test(c[1]), `${id}: ${c[1]}`);
      const classes = classesOf(c[3]);
      const bold = idm[1] === '**';
      check('key: every item has at least one class', classes.length > 0, id);
      check('key: an ID is bold exactly when objective is among its classes', bold === classes.includes('objective'), id);
      if (!descriptive) check('key: every scored item has exactly one class', classes.length === 1, id);
      r.items.push({
        id,
        round: r.id,
        seg: c[1] === '—' ? null : Number(c[1]),
        words: c[2],
        classes,
        objective: bold,
        passes: null,
        route: null,
        lane: null,
      });
    }
    check('key: every round has items', r.items.length > 0, r.id);
  }

  const pk = onlyIndex(lines, (l) => l === '**Keyed outside any round**', 'key: the outside-any-round table appears once');
  let ph = pk + 1;
  while (ph < lines.length && !lines[ph].startsWith('|')) ph++;
  check(
    'key: the outside-any-round table is ID, words and Class',
    /^\| ID \| The user['’]s words \(excerpt\) \| Class \|$/.test(lines[ph] ?? '') && isSeparator(lines[ph + 1]),
    lines[ph] ?? '(end of file)',
  );
  const pItems = [];
  for (let i = ph + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const c = cells(lines[i]);
    check('key: outside-any-round IDs are P-numbers', c.length === 3 && /^P\d+$/.test(c[0]), c[0]);
    const classes = classesOf(c[2]);
    check('key: every outside-any-round item has exactly one class', classes.length === 1, c[0]);
    pItems.push({ id: c[0], words: c[1], classes });
  }
  check(
    'key: every item outside any round is "not about this video"',
    pItems.length > 0 && pItems.every((p) => p.classes[0] === 'not about this video'),
  );

  const scored = rounds.filter((r) => r.kind !== 'descriptive only');
  const tally = (items) =>
    CLASSES.map((cl) => String(items.filter((it) => it.classes.length === 1 && it.classes[0] === cl).length));
  const expected = scored.map((r) => [r.id, r.kind, String(r.items.length), ...tally(r.items)]);
  const pooled = scored.flatMap((r) => r.items);
  expected.push(['Scored', '', String(pooled.length), ...tally(pooled)]);
  for (const r of rounds.filter((x) => x.kind === 'descriptive only')) {
    const range = CLASSES.map((cl) => {
      const min = r.items.filter((it) => it.classes.length === 1 && it.classes[0] === cl).length;
      const max = r.items.filter((it) => it.classes.includes(cl)).length;
      return min === max ? String(min) : `${min}–${max}`;
    });
    expected.push([r.id, r.kind, String(r.items.length), ...range]);
  }
  expected.push(['Outside any round', '—', String(pItems.length), ...tally(pItems)]);
  const ch = onlyIndex(
    lines,
    (l) =>
      l === '| Round | Set | Items | Objective | Craft | Not catchable | Not in these inputs | Not about this video |',
    'key: the counts table appears once',
  );
  check('key: the counts table has a separator row', isSeparator(lines[ch + 1]));
  const countRows = [];
  for (let i = ch + 2; i < lines.length && lines[i].startsWith('|'); i++) countRows.push(cells(lines[i]).map(plain));
  same('key: the counts table is what the item tables add up to', countRows, expected);

  const objectiveIds = (kind) =>
    scored.filter((r) => r.kind === kind).flatMap((r) => r.items.filter((it) => it.objective).map((it) => it.id));
  const cb = objectiveIds('commit-backed');
  const rc = objectiveIds('reconstructed');
  const needs = (d) => Math.ceil((readme.recallPct * d) / 100);
  const sentence =
    `Recall's denominator is ${cb.length} on the commit-backed set (${cb.join(', ')}), and ${rc.length} on the ` +
    `reconstructed set (${rc.join(', ')}). The bar, recall of at least ${readme.recallPct} %, needs ` +
    `${needs(cb.length)} of ${cb.length} and ${needs(rc.length)} of ${rc.length}.`;
  const folded = fold(flat);
  check('key: states the recall denominators its own tables produce', folded.includes(fold(sentence)), sentence);
  for (const phrase of ['R6-13 has no BLOCKING route', "R6-10 and R2-06 are reached only through OBJ-07's check procedure"])
    check(`key: says "${phrase}"`, folded.includes(fold(phrase)));

  const details = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\*\*(R\d+-\d\d)\*\* \(segment (\d), `([a-z]+)`\)$/.exec(lines[i]);
    if (!m) continue;
    check('key: a blank line follows each detail header', lines[i + 1] === '', m[1]);
    const bullets = [];
    let j = i + 2;
    for (; j < lines.length && lines[j] !== ''; j++) {
      const b = /^- \*([A-Za-z ]+):\* ?(.*)$/.exec(lines[j]);
      if (b) bullets.push({ name: b[1], text: b[2] });
      else {
        check('key: detail lines are bullets or 2-space continuations', /^ {2}\S/.test(lines[j]) && bullets.length > 0, m[1]);
        bullets.at(-1).text += ` ${lines[j].trim()}`;
      }
    }
    const names = bullets.map((b) => b.name);
    const want = ['Evidence', 'Passes', 'Route', 'Lane', ...(names.includes('Why objective') ? ['Why objective'] : []), 'Fixed'];
    same('key: a detail block is Evidence, Passes, Route, Lane, an optional Why objective, then Fixed', names, want);
    const get = (n) => bullets.find((b) => b.name === n).text;
    const pm = /^(\d)(?: and (\d))?\./.exec(get('Passes'));
    check('key: Passes reads "N." or "N and M."', pm !== null, m[1]);
    const rm = /^(.*?)[.:](?=\s|$)/.exec(get('Route'));
    check('key: Route ends its first clause with "." or ":"', rm !== null, m[1]);
    const laneText = get('Lane');
    const none = /^none\b/.test(laneText);
    const lm = /\brow (\d)\b/.exec(laneText);
    check('key: Lane is "none" or names a row', none || lm !== null, m[1]);
    check('key: each item has at most one detail block', !details.has(m[1]), m[1]);
    details.set(m[1], {
      seg: Number(m[2]),
      name: m[3],
      passes: pm[2] === undefined ? [Number(pm[1])] : [Number(pm[1]), Number(pm[2])],
      route: rm[1],
      lane: none ? null : Number(lm[1]),
    });
    i = j;
  }
  const scoredObjective = scored.flatMap((r) => r.items.filter((it) => it.objective));
  same(
    'key: the detail blocks are exactly the scored objective items',
    [...details.keys()].sort(),
    scoredObjective.map((it) => it.id).sort(),
  );
  same(
    'key: the declared objective items are the key’s',
    Object.keys(OBJECTIVE_EXPECTED).sort(),
    scoredObjective.map((it) => it.id).sort(),
  );
  for (const it of scoredObjective) {
    const d = details.get(it.id);
    check('key: a detail header names its table row’s segment', d.seg === it.seg && order[d.seg - 1] === d.name, it.id);
    same(`key: ${it.id}'s passes, route and lane`, { passes: d.passes, route: d.route, lane: d.lane }, OBJECTIVE_EXPECTED[it.id]);
    Object.assign(it, { passes: d.passes, route: d.route, lane: d.lane });
  }

  const ah = onlyIndex(
    lines,
    (l) => l === '## Appendix: seen while drafting, not keyed',
    'key: the appendix heading appears once',
  );
  check('key: the appendix runs to the end of the file', !lines.slice(ah + 1).some((l) => l.startsWith('## ')));
  const appendix = [];
  for (let i = ah + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('- ')) appendix.push(l.slice(2));
    else if (/^ {2}\S/.test(l) && appendix.length > 0) appendix[appendix.length - 1] += ` ${l.trim()}`;
    else check('key: after its first bullet the appendix is bullets only', l.trim() === '' || appendix.length === 0, l);
  }

  return { order, rounds, pItems, appendix: appendix.map(squash), cb, rc };
}

function asList(x) {
  if (Array.isArray(x)) return x;
  if (x instanceof Map) return [...x.values()];
  return Object.values(x);
}

function checkKinds(key) {
  const committed = asList(ROUNDS);
  const rebuilt = asList(RECONSTRUCTED);
  for (const r of key.rounds) {
    const c = committed.find((x) => x.id === r.id);
    const b = rebuilt.find((x) => x.id === r.id);
    if (r.kind === 'commit-backed')
      check(
        'key: a commit-backed round is one lib.mjs pins to a commit',
        c !== undefined && c.kind === 'commit-backed' && b === undefined,
        r.id,
      );
    else if (r.kind === 'reconstructed')
      check(
        'key: a reconstructed round is one lib.mjs rebuilds from recorded inputs',
        c === undefined && b !== undefined && b.method !== 'checkpoint',
        `${r.id}: ${b?.method ?? 'absent'}`,
      );
    else
      check(
        'key: a descriptive-only round is one lib.mjs rebuilds only from a checkpoint',
        c === undefined && b !== undefined && b.method === 'checkpoint',
        `${r.id}: ${b?.method ?? 'absent'}`,
      );
  }
}

function parseR1(inputLines, r1Text, key) {
  const at = onlyIndex(
    inputLines,
    (l) => /^\*\*Segment numbers\.\*\* The user['’]s segment numbers are the render['’]s order:/.test(l),
    'inputs: the segment-number table appears once',
  );
  check(
    'inputs: a blank line, then a Number | Segment table, follows',
    inputLines[at + 1] === '' && inputLines[at + 2] === '| Number | Segment |' && isSeparator(inputLines[at + 3]),
    inputLines[at + 2] ?? '(end of file)',
  );
  const order = [];
  for (let i = at + 4; i < inputLines.length && inputLines[i].startsWith('|'); i++) {
    const c = cells(inputLines[i]).map(plain);
    check(
      'inputs: segment rows are numbered 1, 2, 3, … and name one segment',
      c.length === 2 && c[0] === String(order.length + 1) && /^[a-z]+$/.test(c[1]),
      inputLines[i],
    );
    order.push(c[1]);
  }
  check('inputs: r1 has eight segments, each named once', order.length === 8 && new Set(order).size === 8, order.join());

  let res;
  try {
    res = JSON.parse(r1Text);
  } catch (err) {
    throw new Error(`r1-resolution.json does not parse: ${err.message}`);
  }
  check('r1-resolution: resolves round r1', res?.round === 'r1' && Array.isArray(res.items));
  const round = key.rounds.find((r) => r.id === 'r1');
  check(
    'key: no r1 item is objective by its table alone',
    !round.items.some((it) => it.classes.length === 1 && it.classes[0] === 'objective'),
  );
  same(
    'r1-resolution: resolves exactly the r1 items the key left with several candidate classes',
    res.items.map((x) => x.id).sort(),
    round.items
      .filter((it) => it.classes.length > 1)
      .map((it) => it.id)
      .sort(),
  );
  const got = {};
  for (const x of res.items) {
    const it = round.items.find((i) => i.id === x.id);
    check('r1-resolution: each item resolves to one of its candidate classes', it.classes.includes(x.class), x.id);
    const segName = typeof x.segment === 'number' ? order[x.segment - 1] : x.segment;
    check('r1-resolution: each item names the segment of its table row', segName === order[it.seg - 1], x.id);
    check('r1-resolution: each item cites evidence', Array.isArray(x.evidence) && x.evidence.length > 0, x.id);
    const passes = uniqSorted(
      x.evidence.map((e) => /^r1\/pass(\d)/.exec(String(e))?.[1]).filter((v) => v !== undefined),
    ).map(Number);
    const lm = /Lane row (\d)/.exec(String(x.shows ?? ''));
    Object.assign(it, { resolved: x.class, passes, lane: lm ? Number(lm[1]) : null });
    got[x.id] = { passes, lane: it.lane };
  }
  same('r1-resolution: R1-04 and R1-11 resolve with the declared passes and lanes', got, R1_EXPECTED);
  const objective = round.items.filter((it) => it.resolved === 'objective');
  same(
    'r1-resolution: both resolve to objective',
    objective.map((it) => it.id),
    Object.keys(R1_EXPECTED),
  );
  return { order, state: String(res.state ?? ''), objective };
}

function parseRuns(lines) {
  const hi = onlyIndex(
    lines,
    (l) =>
      l.startsWith('| Run | Round | Pass | Session | Model in log | Report bytes | Report SHA-256 | Prompt SHA-256 |'),
    'runs: the Runs table appears once',
  );
  const head = cells(lines[hi]);
  const iStatus = head.findIndex((h) => /status/i.test(h));
  check('runs: the Runs table has a status column', iStatus >= 0, head.join(' | '));
  check('runs: the Runs table has a separator row', isSeparator(lines[hi + 1]));
  const rows = [];
  for (let i = hi + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const c = cells(lines[i]).map(plain);
    check('runs: each row has one cell per column', c.length === head.length, lines[i]);
    const pm = /^(?:p|pass )?(\d)$/.exec(c[2]);
    const bytes = c[5].replace(/[,\s]/g, '');
    check(
      'runs: each row is a numbered run of one round and pass',
      c[0] === String(rows.length + 1) && /^r\d+$/.test(c[1]) && pm !== null,
      lines[i],
    );
    check('runs: the log records the coach model for every run', c[4] === COACH_MODEL, `run ${c[0]}: ${c[4]}`);
    check(
      'runs: each row records the report size and its full SHA-256',
      /^\d+$/.test(bytes) && /^[0-9a-f]{64}$/.test(c[6]),
      `run ${c[0]}: ${c[5]} · ${c[6]}`,
    );
    check('runs: every run is valid', /^valid\b/.test(c[iStatus]), `run ${c[0]}: ${c[iStatus]}`);
    rows.push({
      run: Number(c[0]),
      round: c[1],
      pass: Number(pm[1]),
      key: `${c[1]}p${pm[1]}`,
      bytes: Number(bytes),
      sha: c[6],
      status: c[iStatus],
    });
  }
  same(
    'runs: the eight runs are r2, r6, r7 and r1, pass 1 then pass 2',
    rows.map((r) => r.key),
    RUN_ORDER,
  );
  const amended = rows.filter((r) => /Amendment 9/.test(r.status));
  check(
    'runs: exactly one run, r6 pass 2, stands under Amendment 9',
    amended.length === 1 && amended[0].key === 'r6p2',
    amended.map((r) => r.key).join(),
  );
  return { rows, amended: amended[0] };
}

function parseReport(text, row) {
  const lines = text.split('\n');
  const at = (i) => `${row.key} line ${i + 1}`;
  check('reports: line 1 is "COACH REPORT — pass N" for the run’s pass', lines[0] === `COACH REPORT — pass ${row.pass}`, at(0));
  check('reports: a blank line follows line 1', lines[1] === '', at(1));
  const fields = new Map();
  const sections = new Map();
  let current = null;
  let afterBlank = false;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === '') {
      current = null;
      afterBlank = true;
      continue;
    }
    const header = /^([A-Z][A-Z ]*):$/.exec(l);
    if (header !== null && SECTIONS.includes(header[1])) {
      check('reports: a section header follows a blank line', afterBlank, at(i));
      check(
        'reports: each section appears once, in order',
        !sections.has(header[1]) && SECTIONS.indexOf(header[1]) === sections.size,
        at(i),
      );
      current = header[1];
      sections.set(current, []);
    } else if (current !== null) {
      check('reports: inside a section, every line is a "  - " item', l.startsWith('  - '), at(i));
      sections.get(current).push(l.slice(4));
    } else {
      const field = /^([A-Z][A-Z-]*): (.*)$/.exec(l);
      check(
        'reports: outside a section, every line is a header field',
        field !== null && HEADER_FIELDS.includes(field[1]),
        at(i),
      );
      check(
        'reports: header fields come before any section, once each',
        sections.size === 0 && !fields.has(field[1]),
        at(i),
      );
      fields.set(field[1], field[2]);
    }
    afterBlank = false;
  }
  same('reports: every report has each header field', [...fields.keys()].sort(), [...HEADER_FIELDS].sort(), row.key);
  same('reports: every report has every section', [...sections.keys()], SECTIONS, row.key);
  check(
    'reports: the coach and author models are the recorded ones, and independent',
    fields.get('COACH-MODEL') === COACH_MODEL &&
      fields.get('AUTHOR-MODEL') === AUTHOR_MODEL &&
      fields.get('INDEPENDENCE-CHECK') === 'pass',
    row.key,
  );
  const lists = {};
  for (const s of SECTIONS) {
    const items = sections.get(s);
    const empty = items.length === 1 && items[0] === 'none';
    check('reports: "none" appears only as the whole of an empty section', empty || !items.includes('none'), row.key);
    lists[s] = empty ? [] : items;
  }
  const counts = /^blocking (\d+) · advisory (\d+) · not evaluated (\d+)$/.exec(fields.get('COUNTS'));
  check('reports: COUNTS reads "blocking B · advisory A · not evaluated N"', counts !== null, row.key);
  same(
    'reports: COUNTS match the sections',
    counts.slice(1).map(Number),
    [lists.BLOCKING.length, lists.ADVISORY.length, lists['NOT EVALUATED'].length],
    row.key,
  );
  return {
    counts: fields.get('COUNTS'),
    blocking: lists.BLOCKING,
    advisory: lists.ADVISORY,
    ne: lists['NOT EVALUATED'],
    filesRead: lists['FILES READ'].length,
  };
}

async function readReports(runsDir, runs, key, r1) {
  const reports = new Map();
  const all = [];
  for (const row of runs.rows) {
    const name = `${row.round}-p${row.pass}.md`;
    let buf;
    try {
      buf = await fs.readFile(path.join(runsDir, name));
    } catch (err) {
      throw new UsageError(`--runs: cannot read ${name}: ${err.code ?? err.message}`);
    }
    check(
      'reports: each report matches runs.md byte for byte',
      buf.length === row.bytes && sha256(buf) === row.sha,
      `${name}: ${buf.length} bytes, sha256 ${sha256(buf)}`,
    );
    const text = buf.toString('utf8');
    check('reports: use LF line endings only', !text.includes('\r'), name);
    const rep = parseReport(text, row);
    const order = row.round === 'r1' ? r1.order : key.order;
    rep.run = row;
    rep.findings = [];
    for (const [sev, list] of [
      ['BLOCKING', rep.blocking],
      ['ADVISORY', rep.advisory],
    ]) {
      list.forEach((raw, i) => {
        const k = `${row.key}${sev[0]}${i + 1}`;
        const clean = raw.replace(STAGE, '');
        const m = /^\[([A-Z]+(?:-\d+)?)\] /.exec(clean);
        check('reports: every finding opens with a [RULE] tag', m !== null, k);
        const rest = clean.slice(m[0].length);
        const j = rest.indexOf(' — ');
        check('reports: every finding separates its location from its text with " — "', j >= 0, k);
        const loc = rest.slice(0, j);
        const segments =
          m[1] === 'CRAFT-02' ? [WHOLE] : order.filter((name) => new RegExp(`\\b${name}\\b`).test(loc));
        check('reports: every finding names a segment, or is CRAFT-02', segments.length > 0, k);
        const f = { key: k, run: row.run, round: row.round, pass: row.pass, sev, rule: m[1], clean, loc, segments };
        rep.findings.push(f);
        all.push(f);
      });
    }
    rep.laneNe = rep.ne
      .map((l) => l.replace(STAGE, ''))
      .filter((l) => /covered by: engine/.test(l) && LANE_ROWS.some((r) => r.words.test(l)));
    reports.set(row.key, rep);
  }
  const nB = all.filter((f) => f.sev === 'BLOCKING').length;
  same('reports: 29 findings, 9 BLOCKING and 20 ADVISORY', [all.length, nB, all.length - nB], [29, 9, 20]);
  check(
    'reports: every BLOCKING finding cites an objective rule',
    all.every((f) => f.sev !== 'BLOCKING' || /^OBJ-\d\d$/.test(f.rule)),
  );
  return { reports, all, byKey: new Map(all.map((f) => [f.key, f])) };
}

function checkFamilies(F) {
  const of = new Map();
  for (const fam of FAMILIES) {
    const hits = F.all.filter((f) => fam.re.test(f.clean)).map((f) => f.key);
    same('families: each family is exactly its declared findings', uniqSorted(hits), uniqSorted(fam.members), fam.id);
    for (const k of hits) {
      check('families: no finding belongs to two families', !of.has(k), k);
      of.set(k, fam.id);
    }
  }
  return of;
}

async function readWindow(eventsFile) {
  const starts = new Map();
  const order = [];
  const pending = new Set();
  const done = new Map();
  let badLine = null;
  let lineNo = 0;
  const rl = readline.createInterface({
    input: createReadStream(eventsFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lineNo++;
    if (badLine !== null) throw new Error(`events: line ${badLine} does not parse, and it is not the last line`);
    const maybeStart = line.includes('"tool.execution_start"') && line.includes('ask_user');
    const maybeDone =
      pending.size > 0 &&
      line.includes('"tool.execution_complete"') &&
      [...line.matchAll(/"toolCallId":"([^"]+)"/g)].some((m) => pending.has(m[1]));
    if (!maybeStart && !maybeDone) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      badLine = lineNo;
      continue;
    }
    if (e.type === 'tool.execution_start' && e.data?.toolName === 'ask_user') {
      const id = e.data.toolCallId;
      if (starts.has(id)) throw new Error(`events: ask_user call ${id} starts twice`);
      const args = typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments;
      starts.set(id, { id, ts: e.timestamp, question: args?.question, choices: args?.choices ?? null });
      order.push(id);
      pending.add(id);
    } else if (e.type === 'tool.execution_complete' && pending.has(e.data?.toolCallId)) {
      pending.delete(e.data.toolCallId);
      done.set(e.data.toolCallId, { success: e.data.success, content: e.data.result?.content });
    }
  }
  const all = order.map((id) => starts.get(id));
  const first = all.filter((c) => /^1 of 19 · /.test(c.question ?? ''));
  const last = all.filter((c) => /^r1 · Q26, the last one · /.test(c.question ?? ''));
  check('events: exactly one ask_user call opens the scoring ("1 of 19 · ")', first.length === 1, `${first.length}`);
  check('events: exactly one closes it ("r1 · Q26, the last one · ")', last.length === 1, `${last.length}`);
  const a = all.indexOf(first[0]);
  const b = all.indexOf(last[0]);
  check('events: the window opens before it closes', a < b);
  const calls = all.slice(a, b + 1).map((c) => ({ ...c, ...done.get(c.id) }));
  check('events: the window holds 25 ask_user calls', calls.length === 25, `${calls.length}`);
  for (const c of calls) {
    check(
      'events: every call in the window completed successfully, with text',
      c.success === true && typeof c.content === 'string',
      c.id,
    );
    check(
      'events: every question is text, and every choice list is text',
      typeof c.question === 'string' &&
        (c.choices === null || (Array.isArray(c.choices) && c.choices.every((x) => typeof x === 'string'))),
      c.id,
    );
  }
  check(
    'events: the window’s timestamps never decrease',
    calls.every((c, i) => i === 0 || Date.parse(calls[i - 1].ts) <= Date.parse(c.ts)),
  );
  const hash = sha256(canonical(calls.map((c) => ({ question: c.question, choices: c.choices, answer: c.content }))));
  return { calls, hash, first: calls[0].ts, last: calls.at(-1).ts };
}

function checkExchanges(window, F, key, r1, family, rubricLines) {
  const header = (c) => c.question.split('\n')[0];
  const labels = window.calls.map((c) => {
    const h = header(c);
    let m;
    if ((m = /^(\d+) of 19 · /.exec(h))) return Number(m[1]);
    if ((m = /^r1 · (\d) of 7 · /.exec(h))) return 19 + Number(m[1]);
    if ((m = /^r1 · Q(\d+)/.exec(h))) return Number(m[1]);
    if (h === META.firstLine) return 'meta';
    return null;
  });
  same('exchanges: the window is questions 1–19, the r1 decision, then 20–23 and 26', labels, LABELS);
  const rule = onlyIndex(rubricLines, (l) => l === CRAFT02_RULE, 'rubric: the CRAFT-02 rule line appears once');
  check('rubric: the quoted CRAFT-02 words are the rule’s', rubricLines[rule].includes(CRAFT02_QUOTE));

  const Q = new Map(QUESTIONS.map((d) => [d.q, d]));
  const judgment = new Map();
  const levels = [];
  const offered = new Map();
  const rows = [];
  window.calls.forEach((c, idx) => {
    const label = labels[idx];
    const h = header(c);
    check(
      'exchanges: no question or choice says "(Recommended)"',
      !c.question.includes('(Recommended)') && !(c.choices ?? []).some((x) => x.includes('(Recommended)')),
      `${label}`,
    );
    if (label === 'meta') {
      const r1f = F.all.filter((f) => f.round === 'r1');
      const nB = r1f.filter((f) => f.sev === 'BLOCKING').length;
      const said = `raised ${r1f.length} findings, ${nB} BLOCKING and ${r1f.length - nB} ADVISORY`;
      check('exchanges: the r1 decision states r1’s finding counts', c.question.includes(said), said);
      same('exchanges: the r1 decision offers judging r1, or reporting it unjudged', c.choices, META.choices);
      same('exchanges: the user chose to judge r1', c.content, META.answer);
      rows.push({ label, ts: c.ts, header: h, answer: c.content, findings: [], offered: [] });
      return;
    }
    const where = `Q${label}`;
    const d = Q.get(label);
    const fs_ = d.findings.map((k) => F.byKey.get(k));
    check('exchanges: every declared finding exists', fs_.every(Boolean), where);
    const round = fs_[0].round;
    check('exchanges: a question asks about one round', fs_.every((f) => f.round === round), where);
    const r = key.rounds.find((x) => x.id === round);
    const order = round === 'r1' ? r1.order : key.order;
    const rk =
      round === 'r1'
        ? /^r1 · (?:\d of 7|Q\d+(?:, the last one)?) · descriptive only \(counts toward neither bar\) · /.test(h)
          ? ['r1', 'descriptive only']
          : []
        : (/^\d+ of 19 · (r\d+) \((reconstructed|commit-backed)(?: set)?\) · /.exec(h) ?? []).slice(1, 3);
    same('exchanges: each header names its findings’ round, and that round’s set', rk, [round, r.kind], where);
    same(
      'exchanges: each header names its findings’ passes',
      uniqSorted([...h.matchAll(/\bpass (\d)\b/g)].map((m) => m[1])),
      uniqSorted(fs_.map((f) => String(f.pass))),
      where,
    );
    same(
      'exchanges: each header names its findings’ severities',
      uniqSorted([...h.matchAll(/\b(BLOCKING|ADVISORY)\b/g)].map((m) => m[1])),
      uniqSorted(fs_.map((f) => f.sev)),
      where,
    );
    same(
      'exchanges: each question’s segments are its findings’',
      bySegment(uniqSorted(fs_.flatMap((f) => f.segments)), [WHOLE, ...order]),
      d.segments,
      where,
    );
    if (d.segments[0] === WHOLE)
      check(
        'exchanges: a whole-video header says "whole video" and names no segment',
        /whole video/.test(h) && !order.some((n) => new RegExp(`\\b${n}\\b`).test(h)),
        where,
      );
    else
      for (const name of d.segments) {
        const k = order.indexOf(name) + 1;
        check(
          'exchanges: each header numbers its segments as its round does',
          new RegExp(`\\b${k}(?:, \`?| \\()${name}\\b`).test(h),
          `${where}: ${k} ${name}`,
        );
      }

    const quotes = c.question
      .split('\n')
      .slice(1)
      .filter((l) => /^"?\[(?:OBJ-\d\d|CRAFT-\d\d|UNLISTED)\] /.test(l))
      .map((l) => (/^".*"$/.test(l) ? l.slice(1, -1) : l));
    check(
      'exchanges: each question quotes as many findings as it asks about',
      quotes.length === fs_.length,
      `${where}: ${quotes.length} quotes, ${fs_.length} findings`,
    );
    const matched = quotes.map((qt) => {
      for (const [name, test] of LEVELS) {
        const hits = fs_.filter((f) => test(qt, f.clean));
        if (hits.length === 0) continue;
        check(
          'exchanges: a quote matches one finding, at the strictest level that matches any',
          hits.length === 1,
          `${where}: ${name}`,
        );
        levels.push({ q: label, level: name, key: hits[0].key });
        return hits[0].key;
      }
      check('exchanges: every quote matches one of its question’s findings', false, `${where}: ${qt.slice(0, 80)}`);
      return null;
    });
    same('exchanges: quotes and findings pair off one to one', uniqSorted(matched), uniqSorted(d.findings), where);
    if (CRAFT02_QUESTIONS.includes(label))
      check('exchanges: each CRAFT-02 question quotes the rubric’s rule', c.question.includes(CRAFT02_QUOTE), where);

    const nums = d.segments[0] === WHOLE ? [null] : d.segments.map((n) => order.indexOf(n) + 1);
    const items = r.items.filter((it) => nums.includes(it.seg));
    const expected = items.map((it, i) => {
      const full = `${it.id} — ${it.words}`;
      const bare = `${it.id} — ${it.words.replace(/^P\d+: /, '')}`;
      return round === 'r1' && c.choices?.[i] === bare ? bare : full;
    });
    same(
      'exchanges: each question offers its segments’ items in table order, then the three unmatched choices',
      c.choices,
      [...expected, ...UNMATCHED.map((u) => u[1])],
      where,
    );
    for (const it of items) offered.set(it.id, [...(offered.get(it.id) ?? []), label]);

    const sel = /^User selected: ([\s\S]*)$/.exec(c.content);
    const typ = /^User responded: ([\s\S]*)$/.exec(c.content);
    check('exchanges: every answer is a selection or a typed response', sel !== null || typ !== null, where);
    let judged;
    let typed = null;
    if (sel !== null) {
      const u = UNMATCHED.find(([, text]) => text === sel[1]);
      const i = expected.indexOf(sel[1]);
      check('exchanges: every selection is one of the choices offered', u !== undefined || i >= 0, where);
      judged = u !== undefined ? u[0] : items[i].id;
      if (u === undefined) same('exchanges: each item selected is the declared one', sel[1], SELECTED_IDS[label], where);
    } else {
      typed = typ[1];
      check(
        'exchanges: each typed answer opens with its declared words',
        TYPED[label] !== undefined && typed.startsWith(TYPED[label]),
        where,
      );
      check('exchanges: no typed answer names an item', !/\b(R\d+-\d\d|P\d+)\b/.test(typed), where);
      judged = 'typed';
    }
    same('exchanges: each judgment is the declared one', judged, d.judged, where);
    for (const k of d.findings) {
      check('exchanges: no finding is asked about twice', !judgment.has(k), k);
      judgment.set(k, { q: label, judged, typed });
    }
    rows.push({ label, ts: c.ts, header: h, answer: c.content, findings: d.findings, offered: items.map((it) => it.id) });
  });

  const notAsked = Object.keys(NOT_ASKED);
  check(
    'exchanges: the asked and the not-asked findings are all 29, each once',
    notAsked.every((k) => F.byKey.has(k) && !judgment.has(k)) && judgment.size + notAsked.length === F.all.length,
    `${judgment.size} asked, ${notAsked.length} not asked`,
  );
  const q26 = window.calls[labels.indexOf(26)].question;
  for (const [k, n] of Object.entries(NOT_ASKED)) {
    const m = new RegExp(`Q${n.would} \\(([^)]*)\\)`).exec(q26);
    check('exchanges: Q26 says which question each skipped finding would have been', m !== null, `Q${n.would}`);
    same(
      'exchanges: each skipped question repeats the declared ones',
      [...m[1].matchAll(/Q(\d+)/g)].map((x) => Number(x[1])),
      n.repeats,
      `Q${n.would}`,
    );
    const fam = family.get(k);
    check(
      'exchanges: each skipped finding shares a family with every question it repeats',
      fam !== undefined && n.repeats.every((q) => Q.get(q).findings.some((kk) => family.get(kk) === fam)),
      k,
    );
  }
  for (const [q, prior] of Object.entries(ASKED_IN_ERROR)) {
    const fam = family.get(Q.get(Number(q)).findings[0]);
    check(
      'exchanges: the question asked in error repeats a family already judged',
      fam !== undefined && Q.get(prior).findings.some((k) => family.get(k) === fam),
      `Q${q}`,
    );
  }
  for (const [q, before] of Object.entries(NOT_JUDGED)) {
    const n = Number(q);
    const fam = family.get(Q.get(n).findings[0]);
    const earlier = QUESTIONS.filter(
      (d) => labels.indexOf(d.q) < labels.indexOf(n) && d.findings.some((k) => family.get(k) === fam),
    ).map((d) => d.q);
    same('exchanges: the unjudged question’s family had been asked as the declared questions', earlier, before, `Q${q}`);
    check(
      'exchanges: the unjudged question was answered by typing',
      judgment.get(Q.get(n).findings[0]).judged === 'typed',
      `Q${q}`,
    );
  }
  const phrases = {};
  for (const [q, want] of Object.entries(PHRASE_TEST)) {
    const f = F.byKey.get(Q.get(Number(q)).findings[0]);
    const pm = /[“"]([^”"]+)[”"]/.exec(f.clean);
    check('exchanges: each r1 BLOCKING finding quotes a phrase', pm !== null, `Q${q}`);
    const phrase = fold(pm[1]).toLowerCase();
    const hits = QUESTIONS.filter(
      (d) => d.q <= 19 && d.findings.some((k) => fold(F.byKey.get(k).clean).toLowerCase().includes(phrase)),
    ).map((d) => d.q);
    same('exchanges: the phrase test finds what it was declared to find', hits, want, `Q${q}`);
    phrases[q] = { phrase: pm[1], hits };
  }
  const texts = window.calls.map((c, i) => ({
    label: labels[i],
    text: [c.question, ...(c.choices ?? [])].join('\n'),
  }));
  const words = WORD_CHECKS.map((w) => {
    const hits = texts.filter((t) => w.re.test(t.text)).map((t) => t.label);
    same(`exchanges: ${w.name} appears only where declared`, hits, w.expected);
    return { ...w, hits };
  });
  const loose = texts.flatMap((t) =>
    t.text
      .split('\n')
      .filter((l) => /\bcraft\b/.test(l.replaceAll(CRAFT02_QUOTE, '')))
      .map(() => t.label),
  );
  same('exchanges: lower-case "craft" appears only inside the quoted rubric rule', loose, []);
  return { labels, rows, judgment, levels, offered, phrases, words, Q };
}

function pct(n, d) {
  if (d === 0) return '—';
  const v = (100 * n) / d;
  return Number.isInteger(v) ? `${v} %` : `${v.toFixed(1)} %`;
}

function meets(n, d, bar) {
  if (d === 0) throw new Error('a bar cannot be judged on an empty denominator');
  return 100 * n >= bar * d;
}

function isId(j) {
  return /^R\d+-\d\d$/.test(j);
}

function agrees(j) {
  return j === 'valid' || isId(j);
}

function scoreAll(key, r1, F, X, readme, runs, family) {
  const scored = key.rounds.filter((r) => r.kind !== 'descriptive only');
  const ids = (kind) => scored.filter((r) => kind === undefined || r.kind === kind).map((r) => r.id);
  const runKey = (f) => `${f.round}p${f.pass}`;
  const itemsIn = (rounds) =>
    scored.filter((r) => rounds.includes(r.id)).flatMap((r) => r.items.filter((it) => it.objective));
  const catchers = (it, sevs, drop) =>
    F.all.filter(
      (f) =>
        f.round === it.round &&
        sevs.includes(f.sev) &&
        it.passes.includes(f.pass) &&
        runKey(f) !== drop &&
        X.judgment.get(f.key)?.judged === it.id,
    );
  const score = (name, rounds, drop = null) => {
    const blocking = F.all.filter((f) => f.sev === 'BLOCKING' && rounds.includes(f.round) && runKey(f) !== drop);
    for (const f of blocking) {
      const j = X.judgment.get(f.key);
      check('scoring: every scored BLOCKING finding was judged', j !== undefined && j.judged !== 'typed', f.key);
    }
    const agreed = blocking.filter((f) => agrees(X.judgment.get(f.key).judged));
    const items = itemsIn(rounds);
    const caught = items.filter((it) => catchers(it, ['BLOCKING'], drop).length > 0);
    const caughtAny = items.filter((it) => catchers(it, ['BLOCKING', 'ADVISORY'], drop).length > 0);
    const recall = { n: caught.length, d: items.length };
    const precision = { n: agreed.length, d: blocking.length };
    return {
      name,
      rounds,
      drop,
      recall,
      recallAny: { n: caughtAny.length, d: items.length },
      precision,
      met: meets(recall.n, recall.d, readme.recallPct) && meets(precision.n, precision.d, readme.precisionPct),
      caught: caught.map((it) => it.id),
    };
  };
  const sets = [
    score('Commit-backed (governs)', ids('commit-backed')),
    score('Reconstructed', ids('reconstructed')),
    score('Pooled', ids()),
    score(`Commit-backed without run ${runs.amended.run}`, ids('commit-backed'), runs.amended.key),
  ];
  const perRound = scored.map((r) => ({ ...score(r.id, [r.id]), kind: r.kind }));

  const allItems = key.rounds.flatMap((r) => r.items);
  const outside = F.all
    .filter((f) => {
      const j = X.judgment.get(f.key)?.judged;
      if (j === undefined || !isId(j)) return false;
      const it = allItems.find((i) => i.id === j);
      return it === undefined || it.round !== f.round || !(it.passes ?? []).includes(f.pass);
    })
    .map((f) => f.key);

  const r1B = F.all.filter((f) => f.round === 'r1' && f.sev === 'BLOCKING');
  const judgedB = r1B.filter((f) => {
    const j = X.judgment.get(f.key);
    return j !== undefined && j.judged !== 'typed';
  });
  const agreedB = judgedB.filter((f) => agrees(X.judgment.get(f.key).judged));
  const unjudgedB = r1B.filter((f) => !judgedB.includes(f));
  const certain = r1.objective.filter((it) => catchers(it, ['BLOCKING'], null).length > 0);
  const possible = r1.objective
    .filter((it) => !certain.includes(it))
    .map((it) => ({
      it,
      via: unjudgedB.filter(
        (f) =>
          it.passes.includes(f.pass) && (f.segments.includes(r1.order[it.seg - 1]) || f.segments.includes(WHOLE)),
      ),
    }))
    .filter((x) => x.via.length > 0);
  const r1s = {
    precisionJudged: { n: agreedB.length, d: judgedB.length },
    precisionRange: { lo: agreedB.length, hi: agreedB.length + unjudgedB.length, d: r1B.length },
    recallCertain: { n: certain.length, d: r1.objective.length },
    recallPossible: { n: certain.length + possible.length, d: r1.objective.length },
    possible,
    unjudged: unjudgedB.map((f) => f.key),
  };

  const laneMisses = (items, missed) =>
    items
      .filter((it) => it.lane !== null && missed(it))
      .flatMap((it) => {
        const row = LANE_ROWS.find((r) => r.row === it.lane);
        check('scoring: every lane an item names is one of the five engine lanes', row !== undefined, it.id);
        const lines = it.passes.flatMap((p) =>
          F.reports
            .get(`${it.round}p${p}`)
            .ne.map((l) => l.replace(STAGE, ''))
            .filter((l) => /covered by: engine/.test(l) && row.words.test(l))
            .map((line) => ({ pass: p, line })),
        );
        return lines.length > 0 ? [{ it, row, lines }] : [];
      });
  const scoredObjective = itemsIn(ids());
  const scoredLaneMisses = laneMisses(scoredObjective, (it) => !sets[2].caught.includes(it.id));
  const r1LaneMisses = laneMisses(
    r1.objective,
    (it) => !certain.includes(it) && !possible.some((x) => x.it === it),
  );

  const offered = [
    ...key.rounds.map((r) => ({
      round: r.id,
      n: r.items.filter((it) => X.offered.has(it.id)).length,
      d: r.items.length,
      never: r.items.filter((it) => !X.offered.has(it.id)).map((it) => it.id),
    })),
    {
      round: 'outside any round',
      n: key.pItems.filter((p) => X.offered.has(p.id)).length,
      d: key.pItems.length,
      never: key.pItems.filter((p) => !X.offered.has(p.id)).map((p) => p.id),
    },
  ];
  const typeId = X.words.find((w) => w.name === '"type its ID"').hits;
  const neverOffered = [...scoredObjective, ...r1.objective]
    .filter((it) => !X.offered.has(it.id))
    .map((it) => ({
      it,
      blocking: F.all
        .filter((f) => f.round === it.round && f.sev === 'BLOCKING' && it.passes.includes(f.pass))
        .map((f) => {
          const j = X.judgment.get(f.key);
          return {
            key: f.key,
            q: j?.q ?? null,
            judged: j?.judged ?? 'not asked',
            invited: j !== undefined && typeId.includes(j.q),
          };
        }),
    }));
  const caughtBy = new Map(
    [...scoredObjective, ...r1.objective].map((it) => [
      it.id,
      catchers(it, ['BLOCKING'], null).map((f) => ({ key: f.key, q: X.judgment.get(f.key).q })),
    ]),
  );

  const families = FAMILIES.map((fam) => {
    const members = fam.members.map((k) => {
      const f = F.byKey.get(k);
      const j = X.judgment.get(k);
      return { key: k, round: f.round, sev: f.sev, q: j?.q ?? null, judged: j?.judged ?? 'not asked' };
    });
    const asked = members.filter((m) => m.q !== null);
    const distinct = uniqSorted(asked.map((m) => m.judged));
    const differently =
      asked.some((m) => m.judged === 'false alarm' || m.judged === 'taste') && distinct.length >= 2;
    return { fam, members, distinct, differently };
  });
  same(
    'scoring: the families judged differently are the declared ones',
    families.filter((x) => x.differently).map((x) => x.fam.id),
    JUDGED_DIFFERENTLY,
  );

  const probes = APPENDIX.map((p) => {
    const bullets = key.appendix.map((b, i) => (b.includes(p.find) ? i : -1)).filter((i) => i >= 0);
    check('appendix: each probe names exactly one bullet', bullets.length === 1, p.find);
    const hits =
      p.family !== undefined
        ? F.all.filter((f) => family.get(f.key) === p.family).map((f) => f.key)
        : F.all.filter((f) => p.re.test(f.clean)).map((f) => f.key);
    const want = p.family !== undefined ? FAMILIES.find((x) => x.id === p.family).members : p.hits;
    same('appendix: each probe hits the declared findings', uniqSorted(hits), uniqSorted(want), p.find);
    return { ...p, bullet: bullets[0], hits };
  });
  same(
    'appendix: the probes and the bullets pair off one to one',
    uniqSorted(probes.map((p) => p.bullet)),
    key.appendix.map((_, i) => i),
  );

  const scoredRound = (k) => ids().includes(F.byKey.get(k).round);
  const typedQs = QUESTIONS.filter((d) => d.judged === 'typed').map((d) => d.q);
  return {
    sets,
    perRound,
    outside,
    r1: r1s,
    scoredObjective,
    scoredLaneMisses,
    r1LaneMisses,
    offered,
    neverOffered,
    caughtBy,
    families,
    probes,
    typeId,
    levelCounts: LEVELS.map(([name]) => ({ name, n: X.levels.filter((l) => l.level === name).length })),
    typedQs,
    typedOnScoredBlocking: typedQs.filter((q) =>
      X.Q.get(q).findings.some((k) => F.byKey.get(k).sev === 'BLOCKING' && scoredRound(k)),
    ),
    groups: QUESTIONS.filter((d) => d.findings.length > 1).map((d) => d.q),
    mixed: QUESTIONS.filter((d) => new Set(d.findings.map((k) => F.byKey.get(k).sev)).size > 1).map((d) => d.q),
  };
}

function code(s) {
  return s === undefined || s === null || s === '' ? '—' : `\`${s}\``;
}

function cell(s) {
  return String(s)
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');
}

function table(head, rows) {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
}

function frac(x) {
  return `${x.n}/${x.d} (${pct(x.n, x.d)})`;
}

function list(xs) {
  const s = xs.map(String);
  if (s.length === 0) return 'none';
  return s.length === 1 ? s[0] : `${s.slice(0, -1).join(', ')} and ${s.at(-1)}`;
}

function quoteBlock(text, indent = '') {
  return text.split('\n').map((l) => `${indent}> ${l}`.trimEnd());
}

function render({ src, readme, key, r1, runs, F, family, window, X, S }) {
  const out = [];
  const add = (...ls) => out.push(...ls);
  const gov = S.sets[0];
  const qs = (xs) => list(xs.map((q) => `Q${q}`));
  const qOf = (k) => X.judgment.get(k)?.q ?? '—';
  const segText = (f) => (f.segments[0] === WHOLE ? 'whole video' : f.segments.map(code).join(', '));
  const segOf = (it) => (it.round === 'r1' ? r1.order : key.order)[it.seg - 1];
  const laneText = (lane) =>
    lane === null ? 'none' : `row ${lane} (${LANE_ROWS.find((r) => r.row === lane)?.name ?? 'not an engine lane'})`;
  const judgedWord = (j) =>
    j === 'typed' ? 'a typed answer' : j === 'not asked' ? 'not asked' : isId(j) ? `matched ${j}` : `unmatched, ${j}`;
  const judgedText = (k) => {
    const j = X.judgment.get(k);
    if (j === undefined) return `not asked (it would have been Q${NOT_ASKED[k].would})`;
    return `Q${j.q}, ${judgedWord(j.judged)}${ASKED_IN_ERROR[j.q] === undefined ? '' : ' (asked in error)'}`;
  };
  const agreedText = (k) => {
    const j = X.judgment.get(k);
    if (j === undefined) return '—';
    if (j.judged === 'typed') return 'not judged';
    return agrees(j.judged) ? 'yes' : 'no';
  };
  const under = (s) =>
    [
      meets(s.recall.n, s.recall.d, readme.recallPct) ? null : `recall ${frac(s.recall)} is under ${readme.recallPct} %`,
      meets(s.precision.n, s.precision.d, readme.precisionPct)
        ? null
        : `precision ${frac(s.precision)} is under ${readme.precisionPct} %`,
    ].filter((x) => x !== null);

  add(
    '# Video-coach backtest: scoring',
    '',
    'Written by `src/write-scoring.mjs`. Do not edit it by hand; re-run the script.',
    '',
    "It scores the eight coach reports against the committed answer key, using the user's answers to the scoring " +
      'questions, under the README\'s "Scoring (defined before results)". Every number here is computed. Every ' +
      'declaration the script relies on is checked, and the checks it passed are listed at the end.',
    '',
    '## Result',
    '',
    `**The answer is ${gov.met ? 'Yes' : 'No'}.** The commit-backed set governs, and ` +
      `${gov.met ? 'it meets the bar' : `it misses the bar: ${list(under(gov))}`}.`,
    '',
    ...table(
      ['Set', 'Rounds', 'Recall (BLOCKING)', 'Recall (any severity)', 'Precision', 'Bar'],
      S.sets.map((s) => [
        s.name,
        s.rounds.join(', '),
        frac(s.recall),
        frac(s.recallAny),
        frac(s.precision),
        s.met ? 'met' : 'not met',
      ]),
    ),
    '',
    `The bar, from the README: recall ≥ ${readme.recallPct} % **and** precision ≥ ${readme.precisionPct} %. ` +
      'The README also says: "If they disagree, the commit-backed result governs."',
    '',
    'As this script computes them: an objective item is caught when a BLOCKING finding from its round, in a pass ' +
      'that could see it, was judged to be that item. The user agrees with a BLOCKING finding when they judged it ' +
      'valid or matched it to an item; a false alarm or taste is disagreement. Recall at any severity lets ADVISORY ' +
      'findings catch too.',
    '',
  );
  const [cb, rc, pooled] = S.sets;
  add(
    cb.met === rc.met
      ? `The commit-backed and reconstructed sets agree: both ${cb.met ? 'meet' : 'miss'} the bar.`
      : `The sets disagree: the reconstructed set ${rc.met ? 'meets' : 'misses'} the bar, and the commit-backed ` +
          `set ${cb.met ? 'meets' : 'misses'} it. The commit-backed result governs.`,
    '',
    'The README also says the bar is "pooled over all scored rounds and both passes". Pooled over ' +
      `${list(pooled.rounds)}, the bar is ${pooled.met ? 'met' : 'not met'}, so the answer ` +
      `${pooled.met === cb.met ? 'is the same under either reading' : 'DEPENDS on which reading governs'}.`,
    '',
  );
  const w = S.sets[3];
  add(
    `Run ${runs.amended.run} (${runs.amended.round} pass ${runs.amended.pass}) stands under Amendment 9. Without ` +
      `it, the commit-backed set scores recall ${frac(w.recall)} and precision ${frac(w.precision)}, keeping every ` +
      `objective item in the denominator. The bar is ${w.met ? 'met' : 'not met'}, so the answer ` +
      `${w.met === gov.met ? 'does not depend on that run' : 'DEPENDS on that run'}.`,
    '',
    ...table(
      ['Round', 'Set', 'Recall (BLOCKING)', 'Precision'],
      S.perRound.map((s) => [s.name, s.kind, frac(s.recall), frac(s.precision)]),
    ),
    '',
    '## Objective items',
    '',
    "Recall's denominator. r1's two come from `r1-resolution.json` and count toward neither bar.",
    '',
    ...table(
      ['Round', 'Item', 'Seg', 'Passes', 'Route', 'Lane', 'Offered in', 'Caught'],
      [...S.scoredObjective, ...r1.objective].map((it) => {
        const by = S.caughtBy.get(it.id);
        const maybe = S.r1.possible.find((x) => x.it === it);
        const caught =
          by.length > 0
            ? `yes: ${by.map((b) => `${b.key} (Q${b.q})`).join(', ')}`
            : maybe !== undefined
              ? `possibly: ${maybe.via.map((f) => `${f.key} (Q${qOf(f.key)}, not judged)`).join(', ')}`
              : 'no';
        const off = X.offered.get(it.id);
        return [
          it.round,
          it.id,
          `${it.seg} ${code(segOf(it))}`,
          list(it.passes),
          it.route ?? '—',
          laneText(it.lane),
          off === undefined ? 'never' : off.map((q) => `Q${q}`).join(', '),
          caught,
        ];
      }),
    ),
    '',
  );
  for (const n of S.neverOffered)
    add(
      `- ${n.it.id} was never offered as a choice. ` +
        (n.blocking.length === 0
          ? 'No BLOCKING finding came from its passes.'
          : `BLOCKING findings from its passes: ${n.blocking
              .map(
                (b) =>
                  `${b.key} (${b.q === null ? 'not asked' : `Q${b.q}, ${judgedWord(b.judged)}`}` +
                  `${b.invited ? '; the question invited typing an item ID' : ''})`,
              )
              .join('; ')}.`),
    );
  add(
    '',
    `ID judgments outside the item's round or passes: ${list(S.outside)}.`,
    '',
    '## BLOCKING findings',
    '',
    "Precision counts these. r1's count toward neither bar.",
    '',
    ...table(
      ['Run', 'Finding', 'Rule', 'Segments', 'Judgment', 'Agreed'],
      F.all
        .filter((f) => f.sev === 'BLOCKING')
        .map((f) => [f.run, f.key, f.rule, segText(f), judgedText(f.key), agreedText(f.key)]),
    ),
    '',
    '## Every finding, by run',
    '',
    "The coach's words, with its staging directory removed. Not-evaluated lines are shown only where they leave " +
      "one of the README's engine lanes to the engine.",
    '',
  );
  for (const row of runs.rows) {
    const rep = F.reports.get(row.key);
    add(`### Run ${row.run}: ${row.round} pass ${row.pass}`, '', `\`COUNTS: ${rep.counts}\` · files read: ${rep.filesRead}`, '');
    for (const f of rep.findings) {
      const fam = family.get(f.key);
      add(
        `**${f.key}** · ${f.sev} · ${f.rule} · ${segText(f)}${fam === undefined ? '' : ` · family ${fam}`} · ` +
          judgedText(f.key),
        '',
        ...quoteBlock(f.clean),
        '',
      );
    }
    if (rep.laneNe.length > 0)
      add('Not evaluated, left to the engine:', '', ...rep.laneNe.flatMap((l) => [...quoteBlock(l), '']));
  }
  add(
    '## The answers',
    '',
    `The ${window.calls.length} scoring exchanges, in order: each question's first line and the answer, verbatim. ` +
      "The rest of each question (its quoted findings, rubric lines and context) is not reproduced; the window " +
      'hash under "Sources" fixes it.',
    '',
  );
  for (const r of X.rows) {
    const bits = [r.ts];
    if (r.label !== 'meta') {
      bits.push(`asks about ${list(r.findings)}`);
      bits.push(r.offered.length > 0 ? `offers ${list(r.offered)}` : 'offers no item, only the unmatched choices');
    }
    add(
      `### ${r.label === 'meta' ? 'The r1 decision' : `Q${r.label}`}`,
      '',
      bits.join(' · '),
      '',
      ...quoteBlock(r.header),
      '>',
      ...quoteBlock(r.answer),
      '',
    );
  }

  const r1s = S.r1;
  const pr = r1s.precisionRange;
  add(
    '## r1 (descriptive only)',
    '',
    `r1 counts toward neither bar. Its two objective items were resolved from its inputs in ` +
      `\`r1-resolution.json\`, against state ${code(r1.state)}. The user chose to judge its findings anyway.`,
    '',
    `- Precision: ${frac(r1s.precisionJudged)} of the BLOCKING findings that were judged. ` +
      (r1s.unjudged.length === 0
        ? 'Every BLOCKING finding was judged.'
        : `Over all ${pr.d}, between ${pr.lo}/${pr.d} and ${pr.hi}/${pr.d}, because ${list(r1s.unjudged)} ` +
          `${r1s.unjudged.length === 1 ? 'was' : 'were'} not judged.`),
    `- Recall: ${frac(r1s.recallCertain)} certain, at most ${frac(r1s.recallPossible)}` +
      (r1s.possible.length === 0
        ? '.'
        : `. ${r1s.possible
            .map(
              (x) =>
                `${x.it.id} could have been caught by ${list(
                  x.via.map((f) => `${f.key} (Q${qOf(f.key)}, not judged)`),
                )}, which names its segment`,
            )
            .join('; ')}.`),
    '',
  );
  for (const m of S.r1LaneMisses)
    add(
      `${m.it.id} falls in row ${m.row.row} of the README's lane table (${m.row.name}). No finding caught it, and ` +
        `${list(m.lines.map((l) => `pass ${l.pass}`))} left that lane to the engine:`,
      '',
      ...m.lines.flatMap((l) => [...quoteBlock(l.line), '']),
    );
  for (const [q, prior] of Object.entries(ASKED_IN_ERROR)) {
    const k = X.Q.get(Number(q)).findings[0];
    add(
      `- Q${q} was asked in error: ${k} is in family ${family.get(k)}, which Q${prior} had already judged. ` +
        `It was answered ${judgedWord(X.judgment.get(k).judged)}.`,
    );
  }
  for (const [q, before] of Object.entries(NOT_JUDGED)) {
    const k = X.Q.get(Number(q)).findings[0];
    add(
      `- Q${q} was not judged. ${k} is in family ${family.get(k)}, asked before as ${qs(before)}, and the answer ` +
        `was typed: "${X.judgment.get(k).typed}".`,
    );
  }
  for (const [k, n] of Object.entries(NOT_ASKED))
    add(
      `- ${k} (${F.byKey.get(k).sev}) was not asked. It would have been Q${n.would}, and its family, ` +
        `${family.get(k)}, had been asked as ${qs(n.repeats)}.`,
    );
  add('');

  add(
    '## Families',
    '',
    'Findings from different runs that make the same observation, grouped by a declared pattern. The script checks ' +
      'that each pattern matches exactly its declared findings, and that no finding is in two families. A family is ' +
      'judged differently when one of its members was judged a false alarm or taste and its asked members drew at ' +
      'least two different answers.',
    '',
  );
  for (const x of S.families)
    add(
      `### ${x.fam.id}`,
      '',
      `${x.fam.what[0].toUpperCase()}${x.fam.what.slice(1)}.${x.differently ? ' **Judged differently.**' : ''}`,
      '',
      ...table(
        ['Finding', 'Round', 'Severity', 'Question', 'Judgment'],
        x.members.map((m) => [
          m.key,
          m.round,
          m.sev,
          m.q === null ? 'not asked' : `Q${m.q}`,
          m.q === null ? '—' : judgedWord(m.judged),
        ]),
      ),
      '',
    );
  const splits = S.families.filter((x) => new Set(x.members.map((m) => m.sev)).size > 1);
  add(
    `Judged differently: ${list(S.families.filter((x) => x.differently).map((x) => x.fam.id))}.`,
    '',
    ...splits.flatMap((x) => {
      const rounds = (sev) => [...new Set(x.members.filter((m) => m.sev === sev).map((m) => m.round))];
      return [
        `The coach's severity differs within ${x.fam.id}: BLOCKING in ${list(rounds('BLOCKING'))}, ADVISORY in ` +
          `${list(rounds('ADVISORY'))}.`,
        '',
      ];
    }),
  );

  add(
    "## The key's appendix",
    '',
    `The answer key's appendix lists ${key.appendix.length} things seen while drafting it and not keyed. Each probe ` +
      'names one bullet by a string it contains, then says which findings touch it: a family, or a pattern searched ' +
      'in every finding. The probes were written after the findings had been read.',
    '',
    ...table(
      ['#', 'Bullet containing', 'Probe', 'Findings'],
      [...S.probes]
        .sort((a, b) => a.bullet - b.bullet)
        .map((p) => [
          p.bullet + 1,
          `"${p.find}"`,
          p.family !== undefined ? `family ${p.family}` : code(`/${p.re.source}/${p.re.flags}`),
          list(p.hits),
        ]),
    ),
    '',
  );
  const [errQ, errPrior] = Object.entries(ASKED_IN_ERROR)[0];
  const [njQ, njBefore] = Object.entries(NOT_JUDGED)[0];
  const outsideP = S.offered.find((o) => o.round === 'outside any round');
  const differently = S.families.filter((x) => x.differently).map((x) => x.fam.id);
  const laneItems = S.scoredObjective.filter((it) => it.lane !== null);
  const touched = S.probes.filter((p) => p.hits.length > 0).length;
  const disclosures = [
    '**The questioner knew the key.** The orchestrator wrote every question with the answer key open, and chose ' +
      "the context each one showed. It did not choose the options: each question offered the items of its findings' " +
      'segments, in table order, then the three unmatched choices, and the script checks that for every question.',
    "**Only a finding's own segments were offered.** An item was offered only when a question's findings named its " +
      `segment. Items offered: ${S.offered.map((o) => `${o.round} ${o.n}/${o.d}`).join(', ')}. Objective items ` +
      `never offered: ${list(S.neverOffered.map((n) => n.it.id))}. Only ${qs(S.typeId)} invited typing an item ID ` +
      `that was not offered. The ${outsideP.d} items outside any round are in no round's denominator, so offering ` +
      'them could not have changed a score.',
    '**How each quote was matched.** Each quoted finding matched its report at the strictest level that matched ' +
      `any: ${list(S.levelCounts.map((l) => `${l.n} ${l.name}`))}. The question bodies around the quotes are fixed ` +
      'only by the window hash.',
    `**Grouped questions were never split.** ${qs(S.groups)} each asked about two findings and took one answer for ` +
      `both. ${qs(S.mixed)} paired a BLOCKING finding with an ADVISORY one, so its one answer counts at both ` +
      'severities.',
    `**Typed answers.** ${S.typedQs.length} answers were typed: ${qs(S.typedQs)}. The script checks that no typed ` +
      'answer names an item, so none can catch one. ' +
      (S.typedOnScoredBlocking.length === 0
        ? 'None was on a scored BLOCKING finding, so none changes precision.'
        : `${qs(S.typedOnScoredBlocking)} answered a scored BLOCKING finding.`),
    `**Q${errQ} was asked in error, and that was not reported when it happened.** Its finding is in family ` +
      `${family.get(X.Q.get(Number(errQ)).findings[0])}, which Q${errPrior} had already judged. A phrase test run by ` +
      'this script (the first quoted phrase of each r1 BLOCKING finding, searched in the findings of Q1–19) gives: ' +
      `${Object.entries(X.phrases)
        .map(([q, p]) => `Q${q} hits ${p.hits.length === 0 ? 'nothing' : qs(p.hits)}`)
        .join('; ')}. So it finds Q${errQ}'s repeat but not Q${njQ}'s, whose family had been asked as ` +
      `${qs(njBefore)}.`,
    `**Not judged, and not asked.** Q${njQ} was not judged. ` +
      `${list(Object.entries(NOT_ASKED).map(([k, n]) => `Q${n.would} (${k})`))} were not asked, because each ` +
      "repeats a family already asked. All of them are r1's, which counts toward neither bar.",
    `**Words that could lead the judge.** ${X.words
      .map((wc) => `${wc.name} appears in ${wc.hits.length === 0 ? 'no question' : qs(wc.hits)}`)
      .join('; ')}. The question with "objective" is the one question not judged. The ones with "(craft)" are ` +
      "the CRAFT-02 questions, quoting the rubric's own rule. Lower-case \"craft\" appears nowhere else. That last " +
      'check was first written to excuse any line starting "• rubric.md". Q8 and Q11 quote the rule on a line of ' +
      "their own, so it failed on its first run. It now excuses only the rule's quoted words, wherever they appear. " +
      'It is the only declaration changed after a check failed.',
    `**The same observation drew different answers.** ${list(differently)} ` +
      `${differently.length === 1 ? 'was' : 'were'} judged differently from round to round` +
      (splits.length === 0
        ? '.'
        : `, and the coach's own severity varies within ${list(splits.map((x) => x.fam.id))}.`) +
      " One round's score cannot show either.",
    `**Amendment 9.** Run ${runs.amended.run} (${runs.amended.round} pass ${runs.amended.pass}) stands under ` +
      `Amendment 9. Without it, the governing set scores recall ${frac(w.recall)} and precision ` +
      `${frac(w.precision)}, and the answer ${w.met === gov.met ? 'is the same' : 'changes'}.`,
    `**The appendix probes came after the findings.** ${touched} of the key's ${S.probes.length} appendix bullets ` +
      'are touched by at least one finding. The probes that show it were written after the findings had been ' +
      'read, so they describe the overlap; they do not measure it.',
    '**No "(Recommended)".** No question or choice said "(Recommended)"; the script checks every one.',
    "**What is left out.** The coach's staging directory is removed from every quoted finding. The reports' " +
      'RUBRIC field, their FILES READ lists and the question bodies are not reproduced. The script refuses to ' +
      "write this file if it would contain a profile path, a URL or the user's name.",
    '**Engine lanes.** ' +
      (laneItems.length === 0
        ? 'No scored objective item falls in an engine lane, so the lane rule cannot move the result.'
        : `${list(laneItems.map((it) => it.id))} ${laneItems.length === 1 ? 'falls' : 'fall'} in an engine lane; ` +
          `lane misses among them: ${list(S.scoredLaneMisses.map((m) => m.it.id))}.`) +
      (S.r1LaneMisses.length === 0
        ? ''
        : ` In r1, ${list(S.r1LaneMisses.map((m) => m.it.id))} ${S.r1LaneMisses.length === 1 ? 'does' : 'do'}, ` +
          'and a pass that could see it left the lane to the engine (see "r1").'),
    "**One judge.** Every judgment is the user's, given once. Nothing here measures how a second judge would " +
      'have answered.',
    "**The script came after the answers.** The README's Scoring rules were fixed before any coach run. This " +
      'script was written after the answers were collected. Its declarations (the questions, families, typed ' +
      'answers and probes) record what the session shows, and each one is checked against its source.',
  ];
  add('## Disclosures', '', ...disclosures.map((d, i) => `${i + 1}. ${d}`), '');

  add(
    '## Sources',
    '',
    'Protocol files, read from HEAD:',
    '',
    ...table(
      ['File', 'Blob'],
      SOURCES.filter((s) => s.key !== 'readme').map((s) => [s.file, code(src[s.key].oid)]),
    ),
    '',
    'README.md is not pinned by blob, because its Answer section is written after this file. Its Scoring part ' +
      `(${readme.scoringLines} lines) has sha256 ${code(readme.scoringHash)}, and its lane table has sha256 ` +
      `${code(readme.laneHash)}.`,
    '',
    'Coach reports, each matched byte for byte:',
    '',
    ...table(
      ['Run', 'Round', 'Pass', 'Bytes', 'SHA-256', 'Status'],
      runs.rows.map((r) => [r.run, r.round, r.pass, r.bytes, code(r.sha), r.status]),
    ),
    '',
    `Scoring exchanges: ${window.calls.length} ask_user calls, from ${window.first} to ${window.last}. The sha256 ` +
      `of their canonical questions, choices and answers is ${code(window.hash)}.`,
    '',
    '## Declared, and checked',
    '',
    'Every check below passed on this run. A failed check stops the script, and it writes nothing.',
    '',
    ...[...new Set(CHECKS)].map((c) => `- ${c}`),
  );
  return `${out.join('\n')}\n`;
}

function guardPrivacy(text) {
  const lines = text.split('\n');
  const user = os.userInfo().username.toLowerCase();
  const tests = [
    ['a profile path', (l) => /\\Users\\/i.test(l) || /[A-Za-z]:[\\/]Users[\\/]/i.test(l)],
    ['a URL', (l) => /https?:\/\//i.test(l)],
    ["the user's name", (l) => user.length >= 3 && l.toLowerCase().includes(user)],
  ];
  const found = tests.flatMap(([what, test]) => {
    const at = lines.findIndex(test);
    return at < 0 ? [] : [`${what} (line ${at + 1})`];
  });
  if (found.length > 0) throw new Error(`privacy: the output would contain ${list(found)}; nothing was written`);
}