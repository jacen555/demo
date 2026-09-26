import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { clock, renderScript, wordCount } from '../src/write-script.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timing = JSON.parse(fs.readFileSync(path.join(root, 'timing.json'), 'utf8'));
const knobs = JSON.parse(fs.readFileSync(path.join(root, 'knobs.json'), 'utf8'));
const observed = JSON.parse(fs.readFileSync(path.join(root, 'silence-observed.json'), 'utf8'));

const minimal = () => ({
  durationMs: 10000,
  contentMs: 10000,
  outroMs: 0,
  aspectRatio: '16:9',
  endCard: { enabled: false },
  project: { title: 'T', width: 1920, height: 1080, fps: 30, mode: 'live', background: 'white', engagementLevel: 'rich' },
  intake: { voice: 'en-US-AndrewNeural', speed: 1.2, leadInMs: 2000, perceivedGapMs: 1500, wordsPerSecond: 3.372 },
  segments: [
    {
      id: 'only',
      startMs: 2000,
      endMs: 10000,
      voiceoverText: 'one two three',
      visual: { title: 'A title', note: 'ON-SCREEN-SENTINEL' },
      claims: [{ claimId: 'c-x', type: 'derived', provenanceIds: ['src:row'] }],
    },
  ],
});

test('clock_floorsToMatchTheEngineStoryboardRenderer', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(9000), '0:09');
  assert.equal(clock(9999), '0:09');
  assert.equal(clock(256700), '4:16');
});

test('clock_agreesWithWriteStoryboardOnThisTimeline', () => {
  // Both artifacts quote a total for the same timeline; a rounding divergence between
  // them reads as a bug in review. write-storyboard.mjs floors.
  const engineClock = (ms) =>
    `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  for (const ms of [timing.durationMs, ...timing.segments.flatMap((s) => [s.startMs, s.endMs])]) {
    assert.equal(clock(ms), engineClock(ms), `disagreement at ${ms} ms`);
  }
});

test('wordCount_ignoresSurroundingAndRepeatedWhitespace', () => {
  assert.equal(wordCount('  a   b \n c '), 3);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount(undefined), 0);
});

test('renderScript_emptySegments_throws', () => {
  assert.throws(() => renderScript({ segments: [] }), /non-empty/);
});

test('renderScript_onScreenText_readsVisualNoteRatherThanAHardcodedMap', () => {
  // The whole point of this project's copy: on-screen copy is DATA in timing.json,
  // not a per-segment map baked into the script. Regressing this re-creates the
  // divergence that kept write-script.mjs out of tools/SizzleCraft.
  assert.match(renderScript(minimal()), /\*\*On screen:\*\* ON-SCREEN-SENTINEL/);
});

test('renderScript_derivedClaim_isMarkedDistinctlyFromDirect', () => {
  const out = renderScript(minimal());
  assert.match(out, /`c-x` \*\*derived\*\* \(src:row\)/);
});

test('renderScript_endCardDisabled_describesTheCanonicalAbsentForm', () => {
  const out = renderScript(minimal());
  assert.match(out, /· no end card/);
  assert.match(out, /`builderVersion`, `contentMs` and/);
  assert.doesNotMatch(out, /`outroMs` is 0/);
});

test('renderScript_withoutObservedSilence_labelsPacingAsTargetNotMeasurement', () => {
  const out = renderScript(minimal(), null, null);
  assert.match(out, /Not yet decoded/);
  assert.doesNotMatch(out, /Measured pacing/);
});

test('renderScript_withObservedSilence_reportsDecodedPacingRatherThanTargets', () => {
  // SKILL.md §6: report measured values, not targets. The decoded gap here is materially
  // longer than the target, and the header must not quietly print the target instead.
  const out = renderScript(minimal(), null, {
    leadIn: { targetMs: 2000, decodedMs: 2040 },
    perceivedGaps: { targetMs: 1500, decodedMinMs: 1800, decodedMaxMs: 1900, decodedMeanMs: 1837 },
  });
  assert.match(out, /Measured pacing/);
  assert.match(out, /lead-in 2\.04s/);
  assert.match(out, /1\.80–1\.90s \(mean 1\.84s\)/);
});

test('renderScript_withoutCalibration_labelsTimingsEstimatedAndKeepsTheCalibrationNote', () => {
  const out = renderScript(minimal(), null);
  assert.match(out, /Timings below are ESTIMATED/);
  assert.match(out, /## Calibration note/);
  assert.match(out, /8\.0s est\./);
});

test('renderScript_withCalibration_reportsMeasuredRateAndDropsTheEstimateCaveat', () => {
  const doc = minimal();
  doc.segments[0].audio = { durationMs: 7500 };
  const out = renderScript(doc, { aggregate: { observedEffWps: 3.372 } });
  assert.match(out, /\*\*Measured rate:\*\* 3\.372 words\/sec/);
  assert.match(out, /7\.5s/);
  assert.doesNotMatch(out, /ESTIMATED/);
  assert.doesNotMatch(out, /## Calibration note/);
});

test('timingJson_endCardDisabled_usesTheCanonicalDisabledForm', () => {
  // timing-schema.json allOf[1]: enabled:false requires builderVersion, contentMs AND
  // outroMs to be ABSENT — not present-and-zero, which is what this project shipped until
  // the first validate-timing run caught it. durationMs is the last segment's endMs.
  assert.equal(timing.endCard.enabled, false);
  assert.ok(!('builderVersion' in timing), 'builderVersion must be absent');
  assert.ok(!('contentMs' in timing), 'contentMs must be absent');
  assert.ok(!('outroMs' in timing), 'outroMs must be absent');
  assert.equal(timing.durationMs, timing.segments.at(-1).endMs);
});

test('timingJson_segments_areOrderedAndUniformlySpaced', () => {
  // Before S3 the spacing is the authored perceivedGapMs; after S3 voice.mjs reflows onto
  // measured audio and the spacing is the SOLVED inserted silence, which is smaller. Both
  // are valid — what must hold either way is ordering and uniformity.
  assert.equal(timing.segments[0].startMs, timing.leadInMs ?? timing.intake.leadInMs);
  const spacing = timing.segments
    .slice(1)
    .map((s, i) => s.startMs - timing.segments[i].endMs);
  assert.ok(spacing.every((ms) => ms > 0), 'segments must not overlap');
  assert.equal(new Set(spacing).size, 1, `inserted gap is not uniform: ${[...new Set(spacing)].join('/')}`);
  assert.ok(
    spacing[0] <= timing.intake.perceivedGapMs,
    'inserted silence must not exceed the perceived-gap target — the clip tails make up the rest'
  );
});

test('timingJson_afterSynthesis_everySegmentCarriesMeasuredAudio', () => {
  for (const segment of timing.segments) {
    assert.ok(segment.audio?.durationMs > 0, `${segment.id} has no measured audio`);
    assert.equal(
      segment.endMs - segment.startMs,
      segment.audio.durationMs,
      `${segment.id} window does not match its measured clip`
    );
    assert.ok(segment.audio.words?.length, `${segment.id} has no word boundaries`);
  }
});

test('silenceObserved_recordsDecodedPacing_notSynthesisMetadata', () => {
  // bug-ledger entry 5. voice.mjs reported a 0 ms tail on all 8 clips from word-boundary
  // metadata; the decoder disagrees, and this file is the evidence.
  const g = observed.perceivedGaps;
  assert.equal(g.decodedMs.length, timing.segments.length - 1);
  assert.equal(g.afterSegment.length, g.decodedMs.length);
  assert.ok(g.decodedMeanMs > g.insertedMs, 'decoded gap must exceed the inserted silence');
  assert.equal(observed.durationMs, timing.durationMs, 'decoded duration must match the timeline');
});

test('timingJson_everySegment_carriesAnOnScreenNoteAndAtLeastOneSourcedClaim', () => {
  for (const segment of timing.segments) {
    assert.ok(segment.visual?.note, `${segment.id} has no visual.note`);
    assert.ok(segment.claims?.length, `${segment.id} has no claims`);
    for (const claim of segment.claims) {
      assert.ok(claim.provenanceIds?.length, `${segment.id}/${claim.claimId} has no provenance`);
    }
  }
});

/**
 * Everything that reaches a rendered frame: narration, and every string
 * write-build-html draws. Deliberately EXCLUDES `visual.note` and `claims`, which are
 * authoring prose and provenance — those are allowed to cite the source report by name.
 */
function renderedText(doc) {
  return doc.segments
    .flatMap((s) => {
      const v = s.visual ?? {};
      return [
        s.voiceoverText ?? '',
        v.title ?? '',
        v.subtitle ?? '',
        v.kicker ?? '',
        ...(v.nodes ?? []).map((n) => n.label ?? ''),
        ...(v.items ?? []).flatMap((i) => [i.label ?? '', i.value ?? '', i.text ?? '']),
        ...(v.fields ?? []).flatMap((f) => [f.label ?? '', f.text ?? '']),
        ...(v.shots ?? []).map((sh) => sh.label ?? ''),
      ];
    })
    .join('\n');
}

test('renderedFrames_neverNameAnEnvironmentEndpointOrPullRequestId', () => {
  // knobs.json project.noGo, enforced rather than merely described. The source report
  // contains BOTH a deployment hostname and Azure DevOps pull-request ids in its own
  // markup, so anything derived from it has to be checked rather than trusted.
  //
  // NARROWED 2026-09-25 AT EXPLICIT USER REQUEST: the bare release-stage word `PPE` is
  // approved and spoken in segment 1. It is a release stage, not an endpoint. The guard
  // was narrowed by TIGHTENING THE PATTERN, not by adding a blanket exception — a rule
  // that allowed any string containing "PPE" would also allow a hostname containing it,
  // which is the exact thing this test exists to catch.
  const forbidden = [
    /cortex-supportgraph/i,
    // hostname-shaped PPE only: a dash or dot on either side. Bare `PPE` passes.
    /[-.]ppe\b/i,
    /\bppe[-.]/i,
    /\btest[12]\b/i,
    /microsoft-ppe\.com/i,
    /frontieragentcatalog/i,
    /https?:\/\//i,
    /\b[a-z0-9-]+\.(com|net|io|azure|microsoft)\b/i,
    /\b!?16\d{5}\b/,
    /\bPR\s*!/i,
  ];
  const text = renderedText(timing);
  for (const pattern of forbidden) {
    assert.doesNotMatch(text, pattern, `rendered copy matches forbidden pattern ${pattern}`);
  }
  assert.ok(knobs.project.noGo.length > 0);
});

test('theNarrowedPpeGuard_allowsTheStageWordButStillBlocksHostnames', () => {
  // Both sides pinned, so a future session cannot widen this back into a blanket exception.
  const check = (s) => {
    const forbidden = [/[-.]ppe\b/i, /\bppe[-.]/i, /microsoft-ppe\.com/i, /https?:\/\//i,
      /\b[a-z0-9-]+\.(com|net|io|azure|microsoft)\b/i, /\btest[12]\b/i];
    return forbidden.some((p) => p.test(s));
  };

  // allowed — the bare release stage, as spoken in segment 1
  assert.equal(check('Or deploy it all the way to PPE and test the larger interface by hand.'), false);
  assert.equal(check('promoted to PPE'), false);

  // still blocked — hostnames, endpoints, URLs, slots
  assert.equal(check('frontieragentcatalog.microsoft-ppe.com'), true);
  assert.equal(check('cortex-supportgraph-ppe-test2-gef7hhgwhqaycdek'), true);
  assert.equal(check('core-ainative-agentservices-v2-ppe-wus2'), true);
  assert.equal(check('https://example.microsoft-ppe.com/playground'), true);
  assert.equal(check('deployed to test2'), true);
});

test('everyTriggerTarget_resolvesToAnElementTheBuilderActuallyEmits', () => {
  // write-build-html.mjs emits SEGMENT-QUALIFIED DOM ids:
  //   cards  `${seg.id}-item-${index}`
  //   nodes  `${seg.id}-node-${node.id}`
  //   edges  `${seg.id}-edge-${edge.id ?? index}`
  // A trigger targeting a bare id silently resolves to null, the element is never revealed,
  // and the segment renders as a bare title over an empty stage. Nothing errors. This
  // project lost a full draft capture/encode cycle to exactly that, so it is pinned here.
  const emitted = new Set();
  for (const s of timing.segments) {
    const v = s.visual ?? {};
    (v.items ?? []).forEach((_, i) => emitted.add(`${s.id}-item-${i}`));
    (v.nodes ?? []).forEach((n) => emitted.add(`${s.id}-node-${n.id}`));
    (v.edges ?? []).forEach((e, i) => emitted.add(`${s.id}-edge-${e.id ?? i}`));
    (v.fields ?? []).forEach((f, i) => emitted.add(`${s.id}-field-${f.id ?? i}`));
    (v.shots ?? []).forEach((_, i) => emitted.add(`${s.id}-shot-${i}`));
  }

  for (const s of timing.segments) {
    for (const tr of s.triggers ?? []) {
      // `progress` drives a single global bar and ignores its target.
      if (tr.action === 'progress') continue;
      assert.ok(emitted.has(tr.target), `${s.id}/${tr.id}: target "${tr.target}" is not emitted by the builder`);
      for (const link of tr.payload?.chain ?? []) {
        assert.ok(emitted.has(link), `${s.id}/${tr.id}: chain link "${link}" is not emitted by the builder`);
      }
    }
  }
});

test('flowEdgeTriggers_targetAnEdgeNotANode', () => {
  // flowEdge animates particles ALONG an edge path. Pointed at a node it silently does
  // nothing, which looks identical to a correctly-wired segment that simply has no motion.
  for (const s of timing.segments) {
    for (const tr of (s.triggers ?? []).filter((x) => x.action === 'flowEdge')) {
      assert.match(tr.target, new RegExp(`^${s.id}-edge-`), `${s.id}/${tr.id} must target an edge`);
    }
  }
});

test('everySegment_revealsEveryElementItDeclares', () => {
  // An element the builder emits but no trigger ever reveals stays hidden for the whole
  // segment — authored content that never appears, and never errors. Edges are the easiest
  // to miss: `revealNode` does not draw them, and a diagram of disconnected boxes still
  // looks plausible in a storyboard.
  for (const s of timing.segments) {
    const v = s.visual ?? {};
    const revealed = new Set(
      (s.triggers ?? []).flatMap((tr) => [tr.target, ...(tr.payload?.chain ?? [])])
    );
    (v.items ?? []).forEach((_, i) =>
      assert.ok(revealed.has(`${s.id}-item-${i}`), `${s.id}: card ${i} is never revealed`)
    );
    (v.nodes ?? []).forEach((n) =>
      assert.ok(revealed.has(`${s.id}-node-${n.id}`), `${s.id}: node "${n.id}" is never revealed`)
    );
    (v.edges ?? []).forEach((e, i) => {
      const id = `${s.id}-edge-${e.id ?? i}`;
      const drawn = (s.triggers ?? []).some(
        (tr) => tr.target === id && (tr.action === 'drawEdge' || tr.action === 'flowEdge')
      );
      assert.ok(drawn, `${s.id}: edge "${e.id ?? i}" (${e.from}->${e.to}) is never drawn`);
    });
  }
});

test('everyEdge_isDrawnOnlyAfterBothOfItsEndpointsExist', () => {
  // An edge drawn before its nodes appear animates into empty space.
  for (const s of timing.segments.filter((x) => x.visual?.edges?.length)) {
    const revealAt = new Map();
    for (const tr of s.triggers ?? []) {
      const m = /-node-(.+)$/.exec(tr.target);
      if (m && tr.action === 'revealNode') revealAt.set(m[1], tr.atMs);
    }
    s.visual.edges.forEach((e, i) => {
      const id = `${s.id}-edge-${e.id ?? i}`;
      const tr = (s.triggers ?? []).find(
        (x) => x.target === id && (x.action === 'drawEdge' || x.action === 'flowEdge')
      );
      const latest = Math.max(revealAt.get(e.from) ?? 0, revealAt.get(e.to) ?? 0);
      assert.ok(tr.atMs >= latest, `${s.id}: edge ${e.from}->${e.to} draws at ${tr.atMs} before its endpoints at ${latest}`);
    });
  }
});

test('noTriggerFiresPastItsSegmentEnd', () => {
  // Segment-relative atMs is compared against the MEASURED window. voice.mjs reflows
  // segment windows onto real audio but leaves trigger times alone, so anything authored
  // against an estimate drifts — and a trigger past the end simply never fires. That cost
  // this project the sixth card of the hero segment, silently.
  for (const s of timing.segments) {
    const duration = s.endMs - s.startMs;
    for (const tr of s.triggers ?? []) {
      assert.ok(
        tr.atMs < duration,
        `${s.id}/${tr.id}: atMs ${tr.atMs} >= measured duration ${duration} — it will never fire`
      );
    }
  }
});

test('diagramViewBoxes_matchTheBandTheBuilderGivesThem', () => {
  // .diagram-svg is width:100% with max-height:58vh and preserveAspectRatio="xMidYMid meet".
  // A viewBox taller than ~2.8:1 letterboxes to height, shrinking the whole diagram and its
  // labels to roughly a third of the available width.
  for (const s of timing.segments.filter((x) => x.visual?.nodes?.length)) {
    const [, , w, h] = (s.visual.viewBox ?? '0 0 1600 900').split(/\s+/).map(Number);
    assert.ok(w / h >= 2.8, `${s.id}: viewBox aspect ${(w / h).toFixed(2)} is too tall — it will letterbox`);
  }
});

test('diagramNodes_stayInsideTheirViewBox', () => {
  for (const s of timing.segments.filter((x) => x.visual?.nodes?.length)) {
    const [, , w, h] = s.visual.viewBox.split(/\s+/).map(Number);
    for (const n of s.visual.nodes) {
      assert.ok(n.x >= 0 && n.x + n.w <= w, `${s.id}/${n.id} overflows horizontally`);
      assert.ok(n.y >= 0 && n.y + n.h <= h, `${s.id}/${n.id} overflows vertically`);
    }
  }
});

test('musicAttribution_nonNull_requiresAnEndCardToCreditIt', () => {
  // The end card is this video's only credit surface. A later swap to a track whose
  // licence requires attribution must not be able to land while the card is disabled —
  // that would ship an uncredited work silently.
  const music = knobs.audio.music;
  if (music.attribution !== null && music.attribution !== undefined) {
    assert.equal(
      knobs.endCard.enabled,
      true,
      `music.attribution is set (${music.attribution}) but endCard.enabled is false — there is nowhere to credit it`
    );
  }
});

test('musicSource_isInternallyConsistent', () => {
  const music = knobs.audio.music;
  if (music.generated === false) {
    assert.equal(music.source, 'file');
    assert.ok(music.file, 'a file-sourced bed must name its file');
    assert.ok(music.licence, 'a file-sourced bed must record its licence');
    assert.ok(music.sourceUrl, 'a file-sourced bed must record where it came from');
    assert.equal(music.preset, null, 'preset applies only to a generated bed');
  } else {
    assert.ok(music.preset, 'a generated bed must name its preset');
  }
});

test('shortMusicTrack_isFlaggedForLooping', () => {
  // amix duration=longest does NOT extend a short input — it leaves the tail with no bed
  // and reports nothing (bug-ledger entry 15). If the track is shorter than the video,
  // knobs must say so and require looping.
  const music = knobs.audio.music;
  if (music.generated === false && Number.isFinite(music.durationSeconds)) {
    const fps = timing.project.fps;
    const videoSeconds = Math.ceil(((timing.durationMs + 1000) / 1000) * fps) / fps;
    if (music.durationSeconds < videoSeconds) {
      assert.equal(music.loop?.required, true, 'a short track must be marked loop.required');
      assert.ok(music.loop.crossfadeSeconds > 0, 'looping a bed needs a crossfade or the seam clicks');
      const copies = Math.max(
        2,
        Math.ceil((videoSeconds - music.loop.crossfadeSeconds) / (music.durationSeconds - music.loop.crossfadeSeconds))
      );
      assert.equal(music.loop.copies, copies, `recorded copies should be ${copies} for this track and video length`);
    }
  }
});

test('renderedFrames_avoidTheJargonThePronunciationGlossaryRetires', () => {
  // knobs.narration.pronunciations marks these "avoid" — say "support category",
  // "the most specific level", "right support area". Spoken OR on screen, they break
  // the video for an audience assumed to know nothing about the interview.
  const text = renderedText(timing);
  for (const pattern of [/\bSAP path\b/i, /\bL[1-5]\b/, /\bNO_PATH\b/, /\bSSE\b/]) {
    assert.doesNotMatch(text, pattern, `rendered copy uses retired jargon ${pattern}`);
  }
});

test('knobs_continuityValues_matchTheSiblingVideosRenderedSettings', () => {
  assert.equal(knobs.voice.name, 'en-US-AndrewNeural');
  assert.equal(knobs.voice.speed, 1.2);
  assert.equal(knobs.timing.perceivedGapMs, 1500);
  assert.equal(knobs.timing.leadInMs, 2000);
  assert.equal(knobs.theme.background, 'white');
  assert.equal(knobs.endCard.enabled, false);
  // fades.inMs shorter than leadInMs, or the music bed arrives under the narration.
  assert.ok(knobs.audio.fades.inMs < knobs.timing.leadInMs);
  // alimiter level=true silently gain-rides the whole mix.
  assert.equal(knobs.audio.limiter.autoLevel, false);
});

test('knobs_andTiming_agreeOnEveryValueThatAppearsInBoth', () => {
  assert.equal(knobs.voice.name, timing.intake.voice);
  assert.equal(knobs.voice.speed, timing.intake.speed);
  assert.equal(knobs.timing.perceivedGapMs, timing.intake.perceivedGapMs);
  assert.equal(knobs.endCard.enabled, timing.endCard.enabled);
  assert.equal(knobs.output.fps, timing.project.fps);
  assert.equal(knobs.output.width, timing.project.width);
  assert.equal(knobs.output.height, timing.project.height);
  assert.equal(knobs.output.frameFormat, timing.project.frameFormat);
  assert.equal(knobs.output.jpegQuality, timing.project.jpegQuality);
  // timing.leadInMs is overwritten by voice.mjs with the SOLVED inserted silence, so it is
  // no longer the knob's target. intake.leadInMs keeps the target.
  assert.equal(knobs.timing.leadInMs, timing.intake.leadInMs);
});

test('renderTarget_keepsThe16by9AspectTheDiagramViewBoxesAssume', () => {
  // The 0 0 1600 520 viewBoxes were laid out against a 16:9 stage. A resolution change that
  // altered the aspect would silently letterbox every diagram.
  assert.equal(timing.project.width / timing.project.height, 16 / 9);
  assert.equal(timing.aspectRatio, '16:9');
});
