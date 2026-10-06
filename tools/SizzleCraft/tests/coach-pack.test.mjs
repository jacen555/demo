/*
 * preview's layout audit attributes each issue to the slide it belongs to — and the binding
 * record that lets `coach-pack` prove what the coach was shown.
 *
 * WHY THE ATTRIBUTION COMES FIRST. `window.auditLayout` walks `document.querySelectorAll('.sl')`
 * — EVERY slide, not the one on screen (write-build-html.mjs). preview called it once per
 * segment and filed the whole-document result under that segment's id, so one slide's overflow
 * was reported under every segment previewed. Measured before this was written: with only the
 * second slide overflowing, both segments reported `[{"id":"seg-1",...}]` and the failure line
 * read `layout issues in 2 segment(s): ok, big`.
 *
 * That matters here more than it looks. G2 binds each still TO ITS AUDIT TRANSCRIPT. Binding a
 * still to a transcript describing a different slide would produce a record that is
 * cryptographically sound and semantically false — its hash would prove the wrong thing was
 * checked, which is worse than having no record at all.
 *
 * THE FIXTURE CARRIES THE REAL ID FORMAT, AND THAT IS NOT A DETAIL. Slides are `seg-${index}`
 * (write-build-html.mjs), NOT the segment's id. A first probe used a scene whose slide ids were
 * the segment ids; it reproduced the symptom and would have made the fix look like a one-line
 * filter on `issue.id === segmentId`, which matches nothing against a real build. Verified
 * against a genuine `write-build-html --apply`: its slides are `seg-0, seg-1` while the
 * segments are `ok, big`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EXIT } from '../src/cli-support.mjs';
import { makeProject, runScript } from './_helpers.mjs';

// --------------------------------------------------------------------------------------
// A scene with the shipped audit's shape: it reports EVERY overflowing slide, whichever is
// on screen, and names each by its `seg-<index>` id.
// --------------------------------------------------------------------------------------

const scene = (overflowing) => `<!doctype html><html><head><meta charset="utf-8"><style>
.sl{position:absolute;inset:0;display:none}
.sl.on{display:block}
.safe{width:200px;height:100px;overflow:hidden}
.tall{height:400px}
</style></head><body>
<section id="seg-0" class="sl on"><div class="safe"><p${overflowing.includes(0) ? ' class="tall"' : ''}>one</p></div></section>
<section id="seg-1" class="sl"><div class="safe"><p${overflowing.includes(1) ? ' class="tall"' : ''}>two</p></div></section>
<section id="seg-2" class="sl"><div class="safe"><p${overflowing.includes(2) ? ' class="tall"' : ''}>end card</p></div></section>
<script>
function safeOverflow(el){return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;}
window.auditLayout=function(){const out=[];document.querySelectorAll('.sl').forEach(sl=>{
  const safe=sl.querySelector('.safe');if(!safe)return;
  const on=sl.classList.contains('on');sl.classList.add('on');
  if(safeOverflow(safe))out.push({id:sl.id,reason:'overflow-after-fit'});
  if(!on)sl.classList.remove('on');});return out;};
window.masterTimeline={seek(){},pause(){}};
window.fireTriggersUpTo=function(){};
</script></body></html>`;

const timing = (extra = {}) => JSON.stringify({
  project: { name: 'demo', fps: 30, width: 320, height: 200 },
  durationMs: 2000,
  contentMs: 2000,
  segments: [
    { id: 'ok', startMs: 0, endMs: 1000, voiceoverText: 'first' },
    { id: 'big', startMs: 1000, endMs: 2000, voiceoverText: 'second' },
  ],
  ...extra,
});

const previewIn = (t, { overflowing = [], timingExtra = {}, args = ['--apply'] } = {}) => {
  const dir = makeProject(t, {
    'video-auto.html': scene(overflowing),
    'timing.json': timing(timingExtra),
  });
  return { ...runScript('preview.mjs', args, dir), dir };
};

describe('preview attributes a layout issue to the slide it belongs to', () => {
  // THE CONTROL. Nothing overflows, so nothing is reported and the run succeeds. Without it
  // a fix that reported nothing at all would satisfy every assertion below.
  test('preview_noSlideOverflows_succeedsAndReportsNothing', (t) => {
    const r = previewIn(t);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(r.all, /FAILED/, r.all);
  });

  test('preview_oneSlideOverflows_namesOnlyThatSegment', (t) => {
    const r = previewIn(t, { overflowing: [1] });

    assert.equal(r.code, EXIT.FAILED, `an overflow is still a failure\n${r.all}`);
    assert.match(r.all, /\bbig\b/, `the segment that actually overflows must be named\n${r.all}`);
    assert.doesNotMatch(
      r.all,
      /segment\(s\): .*\bok\b/,
      `a clean segment must not be named as having layout issues\n${r.all}`,
    );
    assert.match(r.all, /1 segment\(s\)/, `one slide overflows, so one segment is named\n${r.all}`);
  });

  // COVERAGE IS NOT TRADED FOR CORRECTNESS. preview audits the whole document but may be
  // asked for a subset. Attributing issues strictly to the previewed segment would make an
  // overflow on an unpicked slide vanish — a silent coverage loss hidden inside a
  // correctness fix. It is still reported, and still named for the segment that owns it.
  test('preview_overflowOnASlideNotPreviewed_isStillReportedAndNamedForItsOwnSegment', (t) => {
    const r = previewIn(t, { overflowing: [1], args: ['--apply', '--id', 'ok'] });

    assert.equal(r.code, EXIT.FAILED, `an overflow anywhere is still a failure\n${r.all}`);
    assert.match(r.all, /\bbig\b/, `the owning segment is named even though it was not previewed\n${r.all}`);
  });

  // THE END CARD HAS A SLIDE AND NO SEGMENT OWNS IT. It is `seg-<segments.length>`, so
  // without its own mapping it would fall through to the raw slide id, or worse be
  // attributed to whichever segment happened to be last. Exercised with a real overflowing
  // end-card slide, because the mapping branch is otherwise never reached.
  test('preview_endCardSlideOverflows_isAttributedToTheEndCardAndCountedOnce', (t) => {
    const r = previewIn(t, { overflowing: [2] });

    assert.equal(r.code, EXIT.FAILED, `an overflow anywhere is a failure\n${r.all}`);
    assert.match(r.all, /segment\(s\): endcard/, `the end card is named as itself\n${r.all}`);
    assert.match(r.all, /1 segment\(s\)/, `and counted once\n${r.all}`);
    assert.match(r.all, /^endcard\s+layout issue:/m, `the issue line is labelled by owner\n${r.all}`);
    // The issue OBJECT carries its slide id as data, which is useful and stays. What must
    // never appear is a raw slide id in the OWNER list, where a reader looks for a segment.
    assert.doesNotMatch(r.all, /segment\(s\): .*seg-\d/, `never a raw slide id as an owner\n${r.all}`);
  });

  // `contentMs` decides the end card's seek time. `Number(null)` and `Number('')` are both
  // ZERO, so a guard built on Number() accepts them and seeks to 1.2s — a still that claims
  // to show the end card and shows the opening instead, at exit 0. The `||` idiom guards
  // ABSENCE and not TYPE; `Number()` guards neither.
  for (const [label, contentMs] of [
    ['absent', undefined],
    ['null', null],
    ['anEmptyString', ''],
    ['aString', '2000'],
    ['notANumber', 'soon'],
  ]) {
    test(`preview_endCardSeekWith_${label}_contentMs_isRefusedRatherThanSeekingToAGuess`, (t) => {
      const r = previewIn(t, { timingExtra: { contentMs } });

      assert.doesNotMatch(r.all, /t=NaNs/, `a seek target that is not a number must not be used\n${r.all}`);
      assert.notEqual(r.code, EXIT.OK, `and the run must not report success\n${r.all}`);
      assert.match(r.all, /contentMs/, `the refusal must name the field\n${r.all}`);
      // REFUSED BEFORE ANYTHING IS WRITTEN. Checked after the segment shots, this left
      // partial output, and the retry was then blocked by the very files the failed run
      // had just written — a refusal that makes itself harder to act on.
      assert.equal(
        fs.existsSync(path.join(r.dir, 'preview')),
        false,
        `a refusal must leave no partial output\n${r.all}`,
      );
    });
  }

  // THE CONTROL FOR THAT GUARD. A real contentMs still produces an end-card shot, so the
  // refusal cannot have been written as "always refuse".
  test('preview_endCardSeekWithAFiniteContentMs_takesTheShot', (t) => {
    const r = previewIn(t);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /^endcard\s+t=3\.2s$/m, `2000ms content + 1.2s\n${r.all}`);
    assert.equal(fs.existsSync(path.join(r.dir, 'preview', 'endcard.png')), true, 'and writes the still');
  });
});
