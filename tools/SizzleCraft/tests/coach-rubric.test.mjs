// The graduated video-coach rubric, tools/SizzleCraft/coach/rubric.md, is a reviewed
// Markdown artifact that the video-coach agent reads at dispatch. This file is its parse
// contract: it reads the rubric the way an author must write it, and fails on anything
// it cannot read. The rubric states the same contract under "About this rubric".
//
// THE CONTRACT
//   - A rule is a heading `### <OBJ|CRAFT>-nn — <name>` (an em dash), followed by exactly
//     ten one-line bullets in this order: Rule, Class, Defect-eligible, Pass, Tag & source,
//     Inputs used, Check procedure, Evidence to cite, Not a defect, Blind spot.
//   - Class opens with `objective` for an OBJ id and `craft` for a CRAFT id.
//   - Defect-eligible is `yes` or `no`. An OBJ rule gives ` — <reason>`; a craft rule is
//     never `yes`.
//   - Pass is `1`, `2`, `both` or `none`, optionally followed by ` — <note>`. The first three
//     are the values the coach acts on (.github/agents/video-coach.agent.md, "Pass scope");
//     `none` marks a rule no input lets it run, so the coach evaluates it at neither pass
//     and reports it under NOT EVALUATED.
//   - Tag & source opens with exactly one of [VERIFIED], [PRACTICE], [HOUSE].
//   - Every number stated in a rule's Rule field appears in its Check procedure. That
//     guards a threshold against drifting between the two fields, which is how OBJ-07's
//     rule and procedure came to test different things. It cannot see a disagreement in
//     words; that stays the reviewer's job.
//   - The rubric's own criterion for defect-eligible ("About this rubric"), as far as a
//     reader without judgement can apply it:
//       · "Carried by no input" lists what the inputs lack. A rule evaluated at any pass
//         may not ask for one of those in its Rule, Inputs used, Check procedure or
//         Evidence to cite; a rule that needs one is `none`, says which in its Pass note,
//         and is never defect-eligible.
//       · A defect-eligible rule's Rule, Check procedure and Blind spot carry none of the
//         marks of an unsourced threshold: "judgement" (the mark the rubric's brief told
//         its author to write where no source gives a threshold), a figure written "~5",
//         "typically", "conventional", "roughly" or "approximately".
//       · Every figure in a defect-eligible rule's Check procedure, step numbers aside,
//         also appears in its Tag & source, where its source is given.
//     A threshold written in plain words with none of those marks gets past all three;
//     the reviewer still reads for it.
//   - A lane is a heading `### ENG-nn — <name>` with five bullets: Status, Audit,
//     On failure, Seen to fail, Owner. Only a lane whose audit has been seen to fail on
//     known-bad input may be `covered`, and only a covered lane may name the engine as
//     its owner. Every test a lane cites must exist in this suite.
//   - Every item under "Not evaluatable from these inputs" opens `- **NE-nn** ` and names
//     who checks it ("Checked by:").
//   - Every id is unique, and every id the text mentions is defined.
//   - The eligibility mark is `defect-eligible`. The older names survive only in the
//     backtest's records, never here.
//
// A check that cannot fire looks exactly like a check that passed, so each one has a
// negative control below that feeds it a broken rubric and asserts it reports the fault.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const RUBRIC_PATH = path.join(testsDir, "..", "coach", "rubric.md");

const RULE_FIELDS = [
  "Rule",
  "Class",
  "Defect-eligible",
  "Pass",
  "Tag & source",
  "Inputs used",
  "Check procedure",
  "Evidence to cite",
  "Not a defect",
  "Blind spot",
];
const LANE_FIELDS = ["Status", "Audit", "On failure", "Seen to fail", "Owner"];
const LANE_STATUSES = ["covered", "not run", "not covered"];
const OWNERS = ["engine: ", "pass 2", "user at draft review", "nobody"];
const TAGS = ["[VERIFIED]", "[PRACTICE]", "[HOUSE]"];
const NOT_EVALUATABLE = "Not evaluatable from these inputs";
const NOT_CARRIED = "Carried by no input";

const HEADING = /^### ((OBJ|CRAFT|ENG)-\d{2}) — (\S.*)$/;
const NE_ITEM = /^- \*\*(NE-\d{2})\*\* (\S.*)$/;
const NOT_CARRIED_ITEM = /^- \*\*([a-z][a-z -]*[a-z])\*\* — \S/;
const FIELD = /^- ([A-Z][A-Za-z &-]*): (.*)$/;
const ID_MENTION = /\b(?:OBJ|CRAFT|ENG|NE)-\d{2}\b/g;
// A test title in this suite's <Method>_<Scenario>_<ExpectedOutcome> shape, in backticks.
const CITED_TEST = /`([A-Za-z0-9]+_[A-Za-z0-9]+_[A-Za-z0-9_]+)`/g;
const COMMIT = /`[0-9a-f]{7,40}`/;
// The marks of a threshold no source gives. "judgement" is the one the rubric's brief told
// its author to write in that case; the others are how this rubric's text writes one.
const UNSOURCED_MARK =
  /\bjudge?ments?\b|~\s*\d|\b(?:typically|conventional|conventionally|roughly|approximately)\b/i;
// The fields that say what a rule uses, as opposed to what it cannot see.
const USES = ["Rule", "Inputs used", "Check procedure", "Evidence to cite"];

/** A matcher for a "Carried by no input" phrase, its last word singular or plural. */
function phraseMatcher(phrase) {
  const words = phrase.split(/[\s-]+/);
  const last = words.pop().replace(/s$/, "");
  return new RegExp(`\\b${[...words, last].join("[- ]")}s?\\b`, "i");
}

/**
 * Reads the rubric into rules and lanes (each with its field bullets, in order, and any
 * line that is not a field) and not-evaluatable items. Structural faults the reader can
 * see on its own are returned as problems.
 */
function parseRubric(text) {
  const entries = [];
  const notEvaluatable = [];
  const notCarried = [];
  const problems = [];
  let section = "";
  let current = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      current = null;
      return;
    }
    if (line.startsWith("### ")) {
      const m = HEADING.exec(line);
      if (!m) {
        problems.push(
          `line ${n}: a level-3 heading must read "### <OBJ|CRAFT|ENG>-nn — <name>"; got ${JSON.stringify(line)}`,
        );
        current = null;
        return;
      }
      current = {
        id: m[1],
        prefix: m[2],
        kind: m[2] === "ENG" ? "lane" : "rule",
        line: n,
        fields: [],
        stray: [],
      };
      entries.push(current);
      return;
    }
    if (section === NOT_EVALUATABLE && /^(- |\d+\. )/.test(line)) {
      const m = NE_ITEM.exec(line);
      if (m) notEvaluatable.push({ id: m[1], text: m[2], line: n });
      else
        problems.push(
          `line ${n}: every item under "${NOT_EVALUATABLE}" opens with its bold NE-nn id`,
        );
      return;
    }
    if (section === NOT_CARRIED && /^(- |\d+\. )/.test(line)) {
      const m = NOT_CARRIED_ITEM.exec(line);
      if (m) notCarried.push({ phrase: m[1], match: phraseMatcher(m[1]) });
      else
        problems.push(
          `line ${n}: every item under "${NOT_CARRIED}" reads "- **<what is missing>** — <why>"`,
        );
      return;
    }
    if (!current || !line.trim()) return;
    const f = FIELD.exec(line);
    if (f) current.fields.push({ name: f[1], value: f[2].trim(), line: n });
    else current.stray.push(n);
  });
  return { entries, notEvaluatable, notCarried, problems };
}

/** The value of the named field, or "" when it is absent. */
const field = (entry, name) =>
  entry.fields.find((f) => f.name === name)?.value ?? "";

// A unit's spellings, folded to one, so "1.5 s", "1.5 seconds" and a "1.5-second" window are
// one figure.
const UNIT_SPELLINGS = {
  s: "s",
  sec: "s",
  second: "s",
  ms: "ms",
  millisecond: "ms",
  min: "min",
  minute: "min",
  db: "db",
  decibel: "db",
  px: "px",
  pixel: "px",
  percent: "%",
};
// Words that can follow a number without being its unit: "does not show 3 and" states none.
const NOT_A_UNIT = new Set(
  "a an and are as at by for from if in is of on or than that the to when which with".split(
    " ",
  ),
);

/** A word as a unit: lower case, singular, one spelling. */
function unitOf(word) {
  let u = word.toLowerCase();
  if (u.length > 3 && /(?:ch|sh|x|ss)es$/.test(u)) u = u.slice(0, -2);
  else if (u.length > 2 && u.endsWith("s")) u = u.slice(0, -1);
  return UNIT_SPELLINGS[u] ?? u;
}

/**
 * Every figure written in `s`, with its unit: a number standing on its own, and the word or
 * "%" that follows it, if that is a unit. A dotted number such as a criterion's "1.4.1" is
 * one figure, so its digits cannot stand in for a threshold's "1 s"; a number glued to a word
 * ("R2", "WCAG22") is not a figure; a ratio ("4.5:1") is its own unit.
 */
function figuresIn(s) {
  const out = [];
  for (const m of s.matchAll(
    /(?<![\w.:])(\d+(?:\.\d+)*)(:\d+(?:\.\d+)?)?(?:\s*(%)|[ \u00a0-]+([A-Za-z]+))?/g,
  )) {
    const [whole, num, ratio, pct, word] = m;
    const figure = num + (ratio ?? "");
    let unit = "";
    if (ratio) unit = "ratio";
    else if (pct) unit = "%";
    else if (word && !NOT_A_UNIT.has(word.toLowerCase())) unit = unitOf(word);
    out.push({
      text: unit && !ratio ? whole.trim() : figure,
      key: ratio ? figure : `${figure} ${unit}`.trim(),
      hasUnit: unit !== "",
    });
  }
  return out;
}

// What only pass 2 has. Pass 1 has the script and, sometimes, a brief.
const PASS2_ONLY = /\b(?:timing|storyboard|stills?|audit)\b/i;

function checkRule(r, problems, notCarried) {
  const cls = field(r, "Class");
  const want = r.prefix === "OBJ" ? "objective" : "craft";
  if (!new RegExp(`^${want}\\b`).test(cls))
    problems.push(
      `${r.id}: Class must open with "${want}" for an ${r.prefix} id; got ${JSON.stringify(cls)}`,
    );

  const eligible = /^(yes|no)\b(.*)$/.exec(field(r, "Defect-eligible"));
  if (!eligible)
    problems.push(`${r.id}: Defect-eligible must open with "yes" or "no"`);
  else if (r.prefix === "CRAFT" && eligible[1] === "yes")
    problems.push(`${r.id}: a craft rule is never defect-eligible`);
  else if (r.prefix === "OBJ" && !/^ — \S/.test(eligible[2]))
    problems.push(`${r.id}: Defect-eligible must give " — <reason>"`);

  const pass = field(r, "Pass");
  const passValue = /^(1|2|both|none)( — \S.*)?$/.exec(pass)?.[1];
  if (!passValue)
    problems.push(
      `${r.id}: Pass must be 1, 2, both or none, optionally followed by " — <note>"; got ${JSON.stringify(pass)}`,
    );

  const tag = field(r, "Tag & source");
  if (!TAGS.some((t) => tag.startsWith(`${t} `)))
    problems.push(
      `${r.id}: Tag & source must open with one of ${TAGS.join(", ")}`,
    );

  // Step markers ("1)", "2)") are numbering, not thresholds: counted, a rule that drifted to
  // "2 s" would be matched by its procedure's second step.
  const procedure = field(r, "Check procedure").replace(
    /(^|\s)\d+\)(?=\s)/g,
    "$1",
  );
  // A figure is its number and its unit: "1.5 s" and "1.5 ms" are different thresholds.
  const inProcedure = new Set(figuresIn(procedure).map((f) => f.key));
  for (const f of figuresIn(field(r, "Rule")))
    if (!inProcedure.has(f.key))
      problems.push(
        `${r.id}: its Rule states "${f.text}", and its Check procedure does not state it with the same unit; the two must test the same thing`,
      );

  // Pass 1 has the script and the brief, and nothing else. A rule evaluated there may name a
  // pass-2 input only after "at pass 2", for what it adds then.
  if (passValue === "1" || passValue === "both") {
    const inputs = field(r, "Inputs used");
    const split = inputs.search(/\bat pass 2\b/i);
    const atPass1 = split < 0 ? inputs : inputs.slice(0, split);
    const early = PASS2_ONLY.exec(atPass1);
    if (early)
      problems.push(
        `${r.id}: Pass ${passValue}, but its Inputs used names ${early[0]} for pass 1, which has only the script and the brief; name it after "at pass 2", or mark the rule pass 2`,
      );
    if (passValue === "1" && split >= 0)
      problems.push(`${r.id}: a pass-1 rule has no pass 2 to read more at`);
    if (!/\b(?:script|brief)\b/i.test(atPass1))
      problems.push(
        `${r.id}: Pass ${passValue}, but its Inputs used names nothing pass 1 has (the script or the brief)`,
      );
  }

  // A rule no input lets run: evaluated at neither pass, never defect-eligible, and its
  // Pass note says what is missing.
  if (passValue === "none") {
    if (eligible?.[1] === "yes")
      problems.push(
        `${r.id}: a rule no input lets run (Pass none) cannot be defect-eligible`,
      );
    if (!notCarried.some((c) => c.match.test(pass)))
      problems.push(
        `${r.id}: Pass none must name, in its note, what is missing, as listed under "${NOT_CARRIED}"`,
      );
  } else
    for (const c of notCarried)
      for (const name of USES)
        if (c.match.test(field(r, name)))
          problems.push(
            `${r.id}: its ${name} asks for ${c.phrase}, which no input carries; a rule that needs it is Pass none`,
          );

  if (eligible?.[1] === "yes") {
    for (const name of ["Rule", "Check procedure", "Blind spot"]) {
      const mark = UNSOURCED_MARK.exec(field(r, name));
      if (mark)
        problems.push(
          `${r.id}: its ${name} says "${mark[0]}", the mark of a threshold no source gives, and a defect-eligible rule has none`,
        );
    }
    // Only a figure with its unit can be matched to its source, and only by the same
    // figure in the same unit: a criterion number such as 1.4.1 is one figure, and states
    // no unit, so it sources nothing.
    const sourced = new Set(
      figuresIn(tag)
        .filter((f) => f.hasUnit)
        .map((f) => f.key),
    );
    for (const f of figuresIn(procedure))
      if (!f.hasUnit)
        problems.push(
          `${r.id}: its Check procedure uses ${f.text} with no unit, and a figure without its unit cannot be matched to a source`,
        );
      else if (!sourced.has(f.key))
        problems.push(
          `${r.id}: its Check procedure uses "${f.text}", which its Tag & source does not state with the same unit; a defect-eligible rule's figures come from its source`,
        );
  }
}

function checkLane(l, problems, testNames) {
  const status = field(l, "Status");
  const seen = field(l, "Seen to fail");
  const owner = field(l, "Owner");
  if (!LANE_STATUSES.includes(status))
    problems.push(
      `${l.id}: Status must be one of ${LANE_STATUSES.join(", ")}; got ${JSON.stringify(status)}`,
    );
  if (!OWNERS.some((o) => owner.startsWith(o)))
    problems.push(
      `${l.id}: Owner must open with one of ${OWNERS.map((o) => o.trim()).join(", ")}`,
    );

  const cited = [...seen.matchAll(CITED_TEST)].map((m) => m[1]);
  for (const name of cited)
    if (!testNames.has(name))
      problems.push(
        `${l.id}: cites test ${name}, which is not in tools/SizzleCraft/tests; re-establish the evidence or change the lane`,
      );

  const covered = status === "covered";
  if (covered !== owner.startsWith("engine: "))
    problems.push(
      `${l.id}: only a covered lane may name the engine as its owner (Status ${JSON.stringify(status)}, Owner ${JSON.stringify(owner)})`,
    );
  if (status === "not covered" && !seen.startsWith("never"))
    problems.push(
      `${l.id}: a lane that is not covered was never seen to fail, so its Seen to fail field opens "never"`,
    );
  if (status !== "not covered") {
    const byHand = /\bby hand\b/.test(seen) && COMMIT.test(seen);
    if (seen.startsWith("never") || (!cited.length && !byHand))
      problems.push(
        `${l.id}: a ${status} lane needs evidence that its audit fails on known-bad input: a test in this suite, or a check made by hand at a named commit`,
      );
  }
}

/**
 * Every problem with the rubric's structure, as human-readable lines; [] when it is sound.
 * `testNames` is the set of test titles in the suite, against which lane evidence is read.
 */
function checkRubric(text, { testNames }) {
  const { entries, notEvaluatable, notCarried, problems } = parseRubric(text);
  const rules = entries.filter((e) => e.kind === "rule");
  if (!rules.length)
    problems.push(
      "no rule was found; a reader that finds nothing would pass every per-rule check",
    );
  if (!notCarried.length)
    problems.push(
      `no "${NOT_CARRIED}" item was found; without that list, no rule can be held to what the inputs carry`,
    );

  for (const e of entries) {
    const want = e.kind === "rule" ? RULE_FIELDS : LANE_FIELDS;
    const got = e.fields.map((f) => f.name);
    if (got.join("|") !== want.join("|"))
      problems.push(
        `${e.id} (line ${e.line}): its fields must be exactly ${want.join(", ")}, in that order; got ${got.join(", ") || "none"}`,
      );
    for (const f of e.fields)
      if (!f.value) problems.push(`${e.id}: ${f.name} is empty`);
    for (const n of e.stray)
      problems.push(
        `${e.id}: line ${n} is not a "- Field: value" bullet, and every field is one line`,
      );
    if (e.kind === "rule") checkRule(e, problems, notCarried);
    else checkLane(e, problems, testNames);
  }

  for (const item of notEvaluatable)
    if (!/Checked by: \S/.test(item.text))
      problems.push(`${item.id}: must say who checks it ("Checked by: ...")`);

  const defined = new Set();
  for (const { id } of [...entries, ...notEvaluatable]) {
    if (defined.has(id)) problems.push(`${id} is defined more than once`);
    defined.add(id);
  }
  for (const id of new Set(text.match(ID_MENTION) ?? []))
    if (!defined.has(id)) problems.push(`${id} is mentioned but never defined`);

  if (/block-eligible/i.test(text) || /\bBLOCKING\b/.test(text))
    problems.push(
      "the eligibility mark is defect-eligible, and the coach's section is DEFECTS; an older name is still here",
    );
  return problems;
}

/** Every literal test title in the suite (a title built from a template is skipped). */
function suiteTestNames() {
  const names = new Set();
  for (const file of fs.readdirSync(testsDir))
    if (file.endsWith(".test.mjs")) {
      const src = fs.readFileSync(path.join(testsDir, file), "utf8");
      for (const m of src.matchAll(/\btest\(\s*(['"`])((?:(?!\1)[^$\\])+)\1/g))
        names.add(m[2]);
    }
  return names;
}

// ---------------------------------------------------------------------------
// The checker, against a small rubric that is sound, then broken one way at a time.
// ---------------------------------------------------------------------------
const FIXTURE_TESTS = new Set(["audit_knownBadInput_fails"]);
const FIXTURE = [
  "# Fixture rubric",
  "",
  "### OBJ-01 — Narrated count contradicts the screen",
  "- Rule: It is a defect when the narration counts 3 items and the screen shows another count.",
  "- Class: objective",
  "- Defect-eligible: yes — tests the video against itself.",
  "- Pass: 2",
  "- Tag & source: [PRACTICE] a fixture whose source gives the count 3 items.",
  "- Inputs used: script, stills.",
  "- Check procedure: 1) Read the count. 2) Flag it when the screen does not show 3 items.",
  "- Evidence to cite: the quoted count.",
  "- Not a defect: two different quantities.",
  "- Blind spot: which count is right.",
  "",
  "### OBJ-02 — Trigger keyed to the wrong word",
  "- Rule: It is a defect when a trigger is keyed to a word the narration lacks.",
  "- Class: objective",
  "- Defect-eligible: no — it needs trigger words, which no input carries.",
  "- Pass: none — it needs trigger words, which no input carries.",
  "- Tag & source: [PRACTICE] a fixture.",
  "- Inputs used: timing (trigger words).",
  "- Check procedure: 1) Find each trigger word in the narration.",
  "- Evidence to cite: the trigger word.",
  "- Not a defect: a plural.",
  "- Blind spot: whether the word is apt.",
  "",
  "### CRAFT-01 — Weak opening",
  "- Rule: It is a defect-candidate (craft) when the opening has no hook.",
  "- Class: craft",
  "- Defect-eligible: no.",
  "- Pass: both — a note.",
  "- Tag & source: [HOUSE] a fixture; see OBJ-01.",
  "- Inputs used: script.",
  "- Check procedure: 1) Judge it.",
  "- Evidence to cite: the first line.",
  "- Not a defect: a plain opening.",
  "- Blind spot: whether it lands.",
  "",
  "## Not evaluatable from these inputs",
  "",
  "- **NE-01** Pronunciation. Checked by: the user at the draft review.",
  "",
  "## Carried by no input",
  "",
  "- **trigger words** — a trigger records only when it fires.",
  "",
  "## Covered by the pipeline",
  "",
  "### ENG-01 — A clipped block",
  "- Status: covered",
  "- Audit: the layout audit.",
  "- On failure: the stage exits 1.",
  "- Seen to fail: test `audit_knownBadInput_fails`.",
  "- Owner: engine: the layout audit",
  "",
  "### ENG-02 — Overlapping events",
  "- Status: not covered",
  "- Audit: none.",
  "- On failure: nothing runs.",
  "- Seen to fail: never; no audit exists.",
  "- Owner: nobody",
  "",
].join("\n");

const check = (text) => checkRubric(text, { testNames: FIXTURE_TESTS });

/** The fixture with `from` replaced by `to`, which must occur in it exactly once. */
function broken(from, to) {
  assert.equal(
    FIXTURE.split(from).length,
    2,
    `the fixture must contain ${JSON.stringify(from)} exactly once`,
  );
  return FIXTURE.replace(from, to);
}

/** The fixture with every [from, to] pair applied, each `from` occurring exactly once. */
function brokenAll(...pairs) {
  return pairs.reduce((text, [from, to]) => {
    assert.equal(
      text.split(from).length,
      2,
      `the fixture must contain ${JSON.stringify(from)} exactly once`,
    );
    return text.replace(from, to);
  }, FIXTURE);
}

/** Asserts that `problems` holds one that matches `pattern`. */
function assertReports(problems, pattern) {
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}; got ${JSON.stringify(problems, null, 2)}`,
  );
}

describe("the rubric checker", () => {
  test("checkRubric_soundFixture_reportsNoProblems", () => {
    assert.deepEqual(check(FIXTURE), []);
  });

  test("checkRubric_crlfLineEndings_readsTheSameAsLf", () => {
    assert.deepEqual(check(FIXTURE.replace(/\n/g, "\r\n")), []);
  });

  test("checkRubric_noRuleAtAll_reportsThatNothingWasFound", () => {
    assertReports(check("# Empty\n"), /no rule was found/);
  });

  test("checkRubric_ruleMissingAField_reportsItsFields", () => {
    assertReports(
      check(broken("- Blind spot: which count is right.\n", "")),
      /OBJ-01 .*fields must be exactly/,
    );
  });

  test("checkRubric_fieldsOutOfOrder_reportsItsFields", () => {
    assertReports(
      check(
        broken(
          "- Class: objective\n- Defect-eligible: yes — tests the video against itself.",
          "- Defect-eligible: yes — tests the video against itself.\n- Class: objective",
        ),
      ),
      /OBJ-01 .*fields must be exactly/,
    );
  });

  test("checkRubric_fieldWrappedOntoASecondLine_reportsTheStrayLine", () => {
    assertReports(
      check(
        broken(
          "- Evidence to cite: the quoted count.",
          "- Evidence to cite: the quoted\n  count.",
        ),
      ),
      /OBJ-01: line \d+ is not a "- Field: value" bullet/,
    );
  });

  test("checkRubric_malformedHeading_reportsTheHeading", () => {
    assertReports(
      check(
        broken("### CRAFT-01 — Weak opening", "### CRAFT-1 - Weak opening"),
      ),
      /level-3 heading must read/,
    );
  });

  test("checkRubric_duplicateId_reportsTheDuplicate", () => {
    assertReports(
      check(broken("### CRAFT-01 — Weak opening", "### OBJ-01 — Weak opening")),
      /OBJ-01 is defined more than once/,
    );
  });

  test("checkRubric_classDisagreesWithTheId_reportsTheClass", () => {
    assertReports(
      check(broken("- Class: craft", "- Class: objective")),
      /CRAFT-01: Class must open with "craft"/,
    );
  });

  test("checkRubric_craftRuleMarkedDefectEligible_reportsIt", () => {
    assertReports(
      check(
        broken("- Defect-eligible: no.", "- Defect-eligible: yes — emphatic."),
      ),
      /CRAFT-01: a craft rule is never defect-eligible/,
    );
  });

  test("checkRubric_objectiveRuleWithNoEligibilityReason_reportsIt", () => {
    assertReports(
      check(
        broken(
          "- Defect-eligible: yes — tests the video against itself.",
          "- Defect-eligible: yes",
        ),
      ),
      /OBJ-01: Defect-eligible must give/,
    );
  });

  test("checkRubric_passTheCoachCannotActOn_reportsThePass", () => {
    assertReports(
      check(broken("- Pass: 2", "- Pass: 1 or 2")),
      /OBJ-01: Pass must be 1, 2, both or none/,
    );
  });

  test("checkRubric_tagOutsideTheThree_reportsTheTag", () => {
    assertReports(
      check(
        broken(
          "- Tag & source: [PRACTICE] a fixture whose",
          "- Tag & source: [FOLKLORE] a fixture whose",
        ),
      ),
      /OBJ-01: Tag & source must open with one of/,
    );
  });

  test("checkRubric_ruleThresholdMissingFromItsProcedure_reportsTheThreshold", () => {
    assertReports(
      check(
        broken(
          "Flag it when the screen does not show 3 items.",
          "Flag it when the screen differs.",
        ),
      ),
      /OBJ-01: its Rule states "3 items", and its Check procedure does not state it with the same unit/,
    );
  });

  test("checkRubric_ruleThresholdMatchedOnlyByAStepNumber_reportsTheThreshold", () => {
    assertReports(
      check(broken("counts 3 items and", "counts 2 items and")),
      /OBJ-01: its Rule states "2 items", and its Check procedure does not state it with the same unit/,
    );
  });

  test("checkRubric_notEvaluatableItemWithoutAnId_reportsTheItem", () => {
    assertReports(
      check(broken("- **NE-01** Pronunciation.", "- Pronunciation.")),
      /opens with its bold NE-nn id/,
    );
  });

  test("checkRubric_notEvaluatableItemNamingNoChecker_reportsTheItem", () => {
    assertReports(
      check(broken(" Checked by: the user at the draft review.", "")),
      /NE-01: must say who checks it/,
    );
  });

  test("checkRubric_mentionOfAnUndefinedId_reportsTheId", () => {
    assertReports(
      check(broken("see OBJ-01.", "see OBJ-03.")),
      /OBJ-03 is mentioned but never defined/,
    );
  });

  test("checkRubric_olderEligibilityName_reportsTheVocabulary", () => {
    assertReports(
      check(
        broken(
          "- Defect-eligible: no.",
          "- Defect-eligible: no — never block-eligible.",
        ),
      ),
      /an older name is still here/,
    );
  });

  test("checkRubric_uncoveredLaneNamingTheEngine_reportsTheOwner", () => {
    assertReports(
      check(broken("- Owner: nobody", "- Owner: engine: the overlap audit")),
      /ENG-02: only a covered lane may name the engine/,
    );
  });

  test("checkRubric_coveredLaneCitingATestTheSuiteLacks_reportsTheTest", () => {
    assertReports(
      check(
        broken(
          "test `audit_knownBadInput_fails`",
          "test `audit_knownBadInput_isGone`",
        ),
      ),
      /ENG-01: cites test audit_knownBadInput_isGone, which is not in/,
    );
  });

  test("checkRubric_coveredLaneWithNoEvidence_reportsIt", () => {
    assertReports(
      check(
        broken(
          "- Seen to fail: test `audit_knownBadInput_fails`.",
          "- Seen to fail: it surely works.",
        ),
      ),
      /ENG-01: a covered lane needs evidence/,
    );
  });

  test("checkRubric_coveredLaneCheckedByHandWithoutACommit_reportsIt", () => {
    assertReports(
      check(
        broken(
          "- Seen to fail: test `audit_knownBadInput_fails`.",
          "- Seen to fail: once, by hand.",
        ),
      ),
      /ENG-01: a covered lane needs evidence/,
    );
  });

  test("checkRubric_coveredLaneCheckedByHandAtACommit_isAccepted", () => {
    assert.deepEqual(
      check(
        broken(
          "- Seen to fail: test `audit_knownBadInput_fails`.",
          "- Seen to fail: once, by hand, at `fe03a88`.",
        ),
      ),
      [],
    );
  });

  test("checkRubric_uncoveredLaneClaimingAFailure_reportsIt", () => {
    assertReports(
      check(
        broken(
          "- Seen to fail: never; no audit exists.",
          "- Seen to fail: test `audit_knownBadInput_fails`.",
        ),
      ),
      /ENG-02: a lane that is not covered was never seen to fail/,
    );
  });

  // The rubric's own criterion for defect-eligible, as far as it can be read mechanically.
  test("checkRubric_noCarriedByNoInputList_reportsThatNothingCanBeHeldToTheInputs", () => {
    assertReports(
      check(
        broken(
          "- **trigger words** — a trigger records only when it fires.\n",
          "",
        ),
      ),
      /no "Carried by no input" item was found/,
    );
  });

  test("checkRubric_carriedByNoInputItemWithoutItsReason_reportsTheItem", () => {
    assertReports(
      check(
        broken(
          "- **trigger words** — a trigger records only when it fires.",
          "- trigger words",
        ),
      ),
      /every item under "Carried by no input" reads/,
    );
  });

  test("checkRubric_evaluatedRuleAskingForWhatNoInputCarries_reportsTheInput", () => {
    assertReports(
      check(broken("- Pass: none — it needs", "- Pass: 2 — it needs")),
      /OBJ-02: its Inputs used asks for trigger words, which no input carries/,
    );
  });

  test("checkRubric_evaluatedRuleAskingForItInAHyphenatedForm_reportsTheInput", () => {
    assertReports(
      check(
        broken(
          "2) Flag it when the screen does not show 3 items.",
          "2) Flag it, per the trigger-word mapping, when the screen does not show 3 items.",
        ),
      ),
      /OBJ-01: its Check procedure asks for trigger words/,
    );
  });

  test("checkRubric_passNoneButDefectEligible_reportsIt", () => {
    assertReports(
      check(
        broken(
          "- Defect-eligible: no — it needs trigger words",
          "- Defect-eligible: yes — it needs trigger words",
        ),
      ),
      /OBJ-02: a rule no input lets run \(Pass none\) cannot be defect-eligible/,
    );
  });

  test("checkRubric_passNoneNamingNothingMissing_reportsIt", () => {
    assertReports(
      check(
        broken(
          "- Pass: none — it needs trigger words, which no input carries.",
          "- Pass: none — it cannot run.",
        ),
      ),
      /OBJ-02: Pass none must name, in its note, what is missing/,
    );
  });

  test("checkRubric_defectEligibleRuleLeavingAThresholdToJudgement_reportsTheMark", () => {
    assertReports(
      check(
        broken(
          "- Blind spot: which count is right.",
          "- Blind spot: close counts are left to reviewer judgement.",
        ),
      ),
      /OBJ-01: its Blind spot says "judgement", the mark of a threshold no source gives/,
    );
  });

  test("checkRubric_defectEligibleRuleWithAnApproximateFigure_reportsTheMark", () => {
    assertReports(
      check(
        broken(
          "1) Read the count.",
          "1) Read the count over a ~5-second window.",
        ),
      ),
      /OBJ-01: its Check procedure says "~5"/,
    );
  });

  test("checkRubric_defectEligibleRuleWithAConventionalRegion_reportsTheMark", () => {
    assertReports(
      check(
        broken(
          "1) Read the count.",
          "1) Read the count, typically in the lower third.",
        ),
      ),
      /OBJ-01: its Check procedure says "typically"/,
    );
  });

  test("checkRubric_defectEligibleRuleUsingAFigureItsSourceLacks_reportsTheFigure", () => {
    assertReports(
      check(broken("1) Read the count.", "1) Read the count 4 times.")),
      /OBJ-01: its Check procedure uses "4 times", which its Tag & source does not state with the same unit/,
    );
  });

  test("checkRubric_ruleThatIsNotDefectEligible_mayCarryAJudgement", () => {
    // The marks rule out defect-eligibility, not the rule: an advisory rule may say them.
    assert.deepEqual(
      check(
        broken(
          "- Blind spot: whether the word is apt.",
          "- Blind spot: whether the word is apt is a judgement, roughly ~5 s.",
        ),
      ),
      [],
    );
  });

  // A figure is sourced only by the same figure, with the same unit, in its source.
  test("checkRubric_thresholdWhoseDigitAppearsOnlyInItsCriterionNumber_reportsTheThreshold", () => {
    // OBJ-12's source is "WCAG 2.2, Success Criterion 1.4.1 Use of Color". Matched digit
    // by digit, a fabricated "1 s" threshold is "sourced" by the last 1 of 1.4.1.
    assertReports(
      check(
        brokenAll(
          [
            "- Tag & source: [PRACTICE] a fixture whose source",
            "- Tag & source: [VERIFIED] WCAG 2.2, Success Criterion 1.4.1 Use of Color; a fixture whose source",
          ],
          ["1) Read the count.", "1) Read the count within 1 s."],
        ),
      ),
      /OBJ-01: its Check procedure uses "1 s", which its Tag & source does not state/,
    );
  });

  test("checkRubric_thresholdWithoutAUnit_reportsTheFigure", () => {
    assertReports(
      check(broken("1) Read the count.", "1) Read the count, at most 5.")),
      /OBJ-01: its Check procedure uses 5 with no unit/,
    );
  });

  test("checkRubric_thresholdWhoseSourceStatesItInAnotherUnit_reportsTheThreshold", () => {
    assertReports(
      check(
        brokenAll(
          ["the count 3 items.", "the count 3 items and a gap of 1.5 ms."],
          ["1) Read the count.", "1) Read the count within 1.5 s."],
        ),
      ),
      /OBJ-01: its Check procedure uses "1.5 s", which its Tag & source does not state/,
    );
  });

  test("checkRubric_thresholdItsSourceStatesInTheSameUnit_isAccepted", () => {
    // "1.5 seconds" in the source and "1.5 s" in the procedure are one figure.
    assert.deepEqual(
      check(
        brokenAll(
          ["the count 3 items.", "the count 3 items and a gap of 1.5 seconds."],
          ["1) Read the count.", "1) Read the count within 1.5 s."],
        ),
      ),
      [],
    );
  });

  test("checkRubric_ruleAndProcedureGivingOneFigureDifferentUnits_reportsTheDrift", () => {
    assertReports(
      check(broken("does not show 3 items.", "does not show 3 rows.")),
      /OBJ-01: its Rule states "3 items", and its Check procedure does not/,
    );
  });

  // Pass 1 has the script and the brief, and nothing else.
  test("checkRubric_bothRuleReadingTheStoryboardAtPass1_reportsTheInput", () => {
    assertReports(
      check(
        broken("- Inputs used: script.", "- Inputs used: script, storyboard."),
      ),
      /CRAFT-01: Pass both, but its Inputs used names storyboard for pass 1/,
    );
  });

  test("checkRubric_bothRuleAddingStillsOnlyAtPass2_isAccepted", () => {
    assert.deepEqual(
      check(
        broken(
          "- Inputs used: script.",
          "- Inputs used: script; at pass 2 also stills.",
        ),
      ),
      [],
    );
  });

  test("checkRubric_bothRuleWithNothingToReadAtPass1_reportsIt", () => {
    assertReports(
      check(
        broken("- Inputs used: script.", "- Inputs used: at pass 2, stills."),
      ),
      /CRAFT-01: Pass both, but its Inputs used names nothing pass 1 has/,
    );
  });

  test("checkRubric_pass1RuleNamingWhatItReadsAtPass2_reportsIt", () => {
    assertReports(
      check(
        brokenAll(
          ["- Pass: both — a note.", "- Pass: 1"],
          [
            "- Inputs used: script.",
            "- Inputs used: script; at pass 2 also timing.",
          ],
        ),
      ),
      /CRAFT-01: a pass-1 rule has no pass 2 to read more at/,
    );
  });
});

// ---------------------------------------------------------------------------
// The graduated rubric itself.
// ---------------------------------------------------------------------------
const RULE_IDS = [
  ...Array.from(
    { length: 19 },
    (_, i) => `OBJ-${String(i + 1).padStart(2, "0")}`,
  ),
  ...Array.from(
    { length: 9 },
    (_, i) => `CRAFT-${String(i + 1).padStart(2, "0")}`,
  ),
];
const NE_IDS = Array.from(
  { length: 10 },
  (_, i) => `NE-${String(i + 1).padStart(2, "0")}`,
);
const ENG_IDS = Array.from(
  { length: 15 },
  (_, i) => `ENG-${String(i + 1).padStart(2, "0")}`,
);

describe("the graduated rubric", () => {
  const read = () => fs.readFileSync(RUBRIC_PATH, "utf8");
  const ruleById = (text, id) =>
    parseRubric(text).entries.find((e) => e.id === id) ??
    assert.fail(`${id} is not in the rubric`);

  test("checkRubric_graduatedRubric_reportsNoProblems", () => {
    assert.deepEqual(checkRubric(read(), { testNames: suiteTestNames() }), []);
  });

  test("parseRubric_graduatedRubric_holdsExactlyTheExpectedIds", () => {
    // Pinned, so a rule, lane or item that goes missing in an edit or a merge is caught
    // here rather than by a coach that quietly stops checking it.
    const { entries, notEvaluatable } = parseRubric(read());
    const sorted = (ids) => [...ids].sort();
    assert.deepEqual(
      sorted(entries.filter((e) => e.kind === "rule").map((e) => e.id)),
      sorted(RULE_IDS),
    );
    assert.deepEqual(
      sorted(entries.filter((e) => e.kind === "lane").map((e) => e.id)),
      sorted(ENG_IDS),
    );
    assert.deepEqual(sorted(notEvaluatable.map((x) => x.id)), sorted(NE_IDS));
  });

  test("parseRubric_graduatedRubric_everyRuleCarriesEveryRequiredFieldOnce", () => {
    for (const r of parseRubric(read()).entries.filter(
      (e) => e.kind === "rule",
    ))
      assert.deepEqual(
        r.fields.map((f) => f.name),
        RULE_FIELDS,
        `${r.id} at line ${r.line}`,
      );
  });

  test("parseRubric_graduatedRubric_everyIdIsUnique", () => {
    const { entries, notEvaluatable } = parseRubric(read());
    const ids = [...entries, ...notEvaluatable].map((x) => x.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `duplicates: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`,
    );
  });

  test("parseRubric_obj07_ruleAndProcedureTestTheSpokenMomentAgainstOneTolerance", () => {
    // The hole the backtest found: the rule asked whether the visual appears anywhere in
    // the segment, while the procedure looked at the moment it is spoken of.
    const r = ruleById(read(), "OBJ-07");
    const tolerance = /(\d+(?:\.\d+)?) s\b/.exec(field(r, "Rule"));
    assert.ok(
      tolerance,
      `OBJ-07's Rule must state its tolerance in seconds: ${field(r, "Rule")}`,
    );
    // Every figure in seconds that the procedure states must be that tolerance: a procedure
    // that quotes it once and applies another figure elsewhere is the hole again.
    const inProcedure = [
      ...field(r, "Check procedure").matchAll(/(\d+(?:\.\d+)?) s\b/g),
    ].map((m) => m[1]);
    assert.ok(
      inProcedure.length > 0,
      "OBJ-07's procedure must apply a tolerance in seconds",
    );
    assert.deepEqual(
      [...new Set(inProcedure)],
      [tolerance[1]],
      "and only the Rule's own",
    );
    assert.match(
      field(r, "Rule"),
      /after the word that makes the claim/,
      "the Rule times the claim from the word that makes it",
    );
    assert.match(
      field(r, "Check procedure"),
      /audio\.words\[\]\.startMs/,
      "the procedure reads the spoken moment from the timing file's words",
    );
    assert.equal(field(r, "Pass"), "2");
  });

  test("parseRubric_obj19_isAPass2RuleOnStillsAndStoryboardThatStatesItsStillBlindSpot", () => {
    const r = ruleById(read(), "OBJ-19");
    assert.equal(field(r, "Pass"), "2");
    assert.match(field(r, "Inputs used"), /\bstills\b/);
    assert.match(field(r, "Inputs used"), /\bstoryboard\b/);
    assert.match(
      field(r, "Blind spot"),
      /one still per segment, taken late in its window/,
    );
    assert.match(
      field(r, "Blind spot"),
      /resolves before that moment is invisible/,
    );
  });

  test("parseRubric_fittedRules_areDisclosedAsFittedAndUntestedInTheRubricItself", () => {
    const text = read();
    const section = /^## Fitted, not yet tested\r?\n([\s\S]*?)^## /m.exec(text);
    assert.ok(
      section,
      'the rubric must carry a "## Fitted, not yet tested" section',
    );
    for (const id of ["OBJ-07", "OBJ-19"]) {
      assert.match(
        section[1],
        new RegExp(`\\b${id}\\b`),
        `the disclosure must name ${id}`,
      );
      assert.match(
        field(ruleById(text, id), "Tag & source"),
        /Fitted, not yet tested/,
        `${id} must point at it`,
      );
    }
    assert.match(section[1], /not been tested on a fresh review round/);
    // The tolerance's bounds were measured, and its figure was selected inside them. To
    // call the figure itself measured would be the overclaim this rubric exists to catch.
    assert.doesNotMatch(section[1], /measured, not chosen/);
    assert.match(section[1], /bounds were measured/);
    assert.match(section[1], /selected (with)?in(side)? them/);
  });

  test("parseRubric_coveredLanes_eachRestsOnAFailureSeenOnKnownBadInput", () => {
    // checkRubric enforces the rule; this pins that the rubric still claims some coverage
    // and that every claim is one a test or a dated check stands behind.
    const lanes = parseRubric(read()).entries.filter((e) => e.kind === "lane");
    const covered = lanes.filter((l) => field(l, "Status") === "covered");
    assert.ok(
      covered.length > 0,
      "no lane is covered; that would be a claim worth checking too",
    );
    for (const l of covered)
      assert.doesNotMatch(field(l, "Seen to fail"), /^never/, l.id);
  });

  test("parseRubric_carriedByNoInput_namesWhatTheRulesAskedForAndNoInputHas", () => {
    const { notCarried } = parseRubric(read());
    assert.deepEqual(notCarried.map((c) => c.phrase).sort(), [
      "animation timing",
      "chapter marks",
      "trigger words",
    ]);
  });

  test("parseRubric_rulesThatCannotRun_areMarkedPassNoneAndNotDefectEligible", () => {
    // Their detection is unchanged; only their status says what is true of them here.
    const text = read();
    for (const id of ["OBJ-02", "OBJ-05", "OBJ-06", "OBJ-10", "OBJ-16"]) {
      const r = ruleById(text, id);
      assert.match(field(r, "Pass"), /^none — /, `${id} cannot run here`);
      assert.match(field(r, "Defect-eligible"), /^no — /, id);
    }
  });

  test("parseRubric_rulesWithAnUnsourcedThreshold_areNotDefectEligible", () => {
    // Each one's own text carries the mark: OBJ-09 a "~5-second" window, OBJ-14 a band
    // "typically" in the lower third, OBJ-15 "reviewer judgement" of what is essential.
    const text = read();
    for (const id of ["OBJ-09", "OBJ-14", "OBJ-15"]) {
      const r = ruleById(text, id);
      assert.match(field(r, "Defect-eligible"), /^no — /, id);
      assert.doesNotMatch(
        field(r, "Pass"),
        /^none/,
        `${id} still runs, as advice`,
      );
    }
  });

  test("parseRubric_rulesThatNeedTheStoryboard_runAtPass2NotPass1", () => {
    const text = read();
    for (const id of ["OBJ-03", "OBJ-13"])
      assert.match(field(ruleById(text, id), "Pass"), /^2 — not pass 1: /, id);
  });

  test("parseRubric_obj15_reportsAFactShownOnlyAsOnScreenTextAsAdvice", () => {
    // The user ruled on 2026-10-06: OBJ-15 detects what WCAG describes, and reports it as
    // advice. On-screen text is part of the visual, not an alternative to it.
    const r = ruleById(read(), "OBJ-15");
    assert.doesNotMatch(field(r, "Rule"), /not given as on-screen text/);
    assert.match(field(r, "Rule"), /on-screen text is part of the visual/);
    assert.match(
      field(r, "Rule"),
      /no separate text alternative to the video is supplied/,
    );
    assert.match(field(r, "Rule"), /advice/);
    assert.match(
      field(r, "Check procedure"),
      /the narration states it in words/,
    );
    assert.doesNotMatch(
      field(r, "Check procedure"),
      /on-screen text element states it/,
    );
    assert.match(field(r, "Defect-eligible"), /^no — /);
    // A disclosure that still described the old behaviour would be worse than none.
    assert.doesNotMatch(field(r, "Blind spot"), /passes this rule/);
    assert.match(field(r, "Blind spot"), /WCAG/);
  });

  test("parseRubric_obj08_readsTheScriptsOnScreenNotesAtPass1AndTheStoryboardOnlyAtPass2", () => {
    // Its defect is a contradiction the script can show by itself: its narration against its
    // own On-screen notes. The backtest's pass-1 run raised one such finding, and the user
    // judged it valid. OBJ-03 and OBJ-13 differ: their defect is an absence in the storyboard.
    const r = ruleById(read(), "OBJ-08");
    assert.match(field(r, "Pass"), /^both/);
    const [atPass1, atPass2 = ""] = field(r, "Inputs used").split(
      /\bat pass 2\b/i,
    );
    assert.match(atPass1, /On-screen notes/);
    assert.doesNotMatch(atPass1, /\b(?:storyboard|stills?|timing|audit)\b/i);
    assert.match(atPass2, /storyboard/);
  });
});
