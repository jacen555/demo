/**
 * S1 — script projection for the `eval-loop-demo` video.
 *
 * `write-script.mjs` is the ONE pipeline stage tools/SizzleCraft deliberately does not
 * ship (see its README, "Not done"): it diverged ~120% between the two earlier projects
 * and has not been reviewed for extraction. This is this project's copy.
 *
 * Two things here are deliberate departures from the earlier copies, and they are the
 * reason this file is worth reading before the next extraction attempt:
 *
 *   1. The on-screen description is read from `segment.visual.note` in timing.json.
 *      The earlier copies carried a hardcoded `NOTES` map keyed by segment id, which is
 *      per-video DATA living in what is otherwise per-pipeline LOGIC — and is exactly
 *      the kind of difference that made the two copies look like different scripts.
 *   2. It exports a pure function and only runs when invoked directly. 8 of the engine's
 *      scripts execute on import and therefore cannot be unit-tested at all; this one can.
 *
 * Usage:
 *   node src/write-script.mjs                 # timing.json -> script.md
 *   node src/write-script.mjs --check         # render to stdout, write nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const KIND_LABEL = {
  direct: 'direct',
  derived: '**derived**',
  hypothesis: '_hypothesis_',
  aspirational: '_aspirational_',
};

/**
 * ms -> `m:ss`.
 *
 * Floors, to match `write-storyboard.mjs` exactly. The engine owns the storyboard, and
 * the two artifacts quoting different totals for the same timeline (4:16 vs 4:17) reads
 * as a bug in review. Note the earlier projects' copies rounded, which is a third variant.
 */
export function clock(ms) {
  const safe = Math.max(0, ms);
  return `${Math.floor(safe / 60000)}:${String(Math.floor((safe % 60000) / 1000)).padStart(2, '0')}`;
}

/** Word count used for the rate estimate. Matches validate-timing's whitespace split. */
export function wordCount(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Renders script.md from a timing document.
 *
 * `calibration` is optional: when a real render has happened it carries the measured
 * rate, and the header reports measured rather than estimated values.
 */
export function renderScript(timing, calibration = null, observed = null) {
  if (!timing || !Array.isArray(timing.segments) || timing.segments.length === 0) {
    throw new Error('renderScript: timing.segments must be a non-empty array');
  }

  const project = timing.project ?? {};
  const intake = timing.intake ?? {};
  const endCardOn = timing.endCard?.enabled === true;
  const words = timing.segments.reduce((n, s) => n + wordCount(s.voiceoverText), 0);
  const measured = calibration?.aggregate?.observedEffWps ?? null;
  const rate = measured ?? intake.wordsPerSecond ?? 3.0;
  const rateLabel = measured
    ? `**Measured rate:** ${measured} words/sec`
    : `**Estimated rate:** ${rate} words/sec _(not yet measured — see the calibration note)_`;

  // Pacing: prefer DECODED values over targets (SKILL.md §6). Fall back to the inserted
  // silence in timing.json, and only then to the intake targets.
  const insertedGapMs = timing.segments.length > 1
    ? timing.segments[1].startMs - timing.segments[0].endMs
    : null;
  const pacing = observed
    ? `> **Measured pacing** (decoded, not metadata): lead-in ${(observed.leadIn.decodedMs / 1000).toFixed(2)}s ` +
      `against a ${(observed.leadIn.targetMs / 1000).toFixed(1)}s target; perceived inter-segment gaps ` +
      `${(observed.perceivedGaps.decodedMinMs / 1000).toFixed(2)}–${(observed.perceivedGaps.decodedMaxMs / 1000).toFixed(2)}s ` +
      `(mean ${(observed.perceivedGaps.decodedMeanMs / 1000).toFixed(2)}s) against a ` +
      `${(observed.perceivedGaps.targetMs / 1000).toFixed(1)}s target — see render-log.md.`
    : `> Perceived inter-segment gap: ${(intake.perceivedGapMs ?? 0) / 1000}s target, lead-in ` +
      `${(intake.leadInMs ?? 0) / 1000}s target${insertedGapMs ? ` (${insertedGapMs}ms inserted)` : ''}. Not yet decoded.`;

  const endCardBlock = endCardOn
    ? `> End card is ON — revealed at ${clock(timing.contentMs)} and held for ${(timing.outroMs / 1000).toFixed(1)}s.`
    : `> **End card is OFF** — the canonical disabled form, in which \`builderVersion\`, \`contentMs\` and\n` +
      `> \`outroMs\` are all **absent** and \`durationMs\` (${timing.durationMs} ms) is the last segment's \`endMs\`.\n` +
      `> Nothing is padded or appended.`;

  const lines = [
    `# ${project.title ?? 'Untitled'}`,
    '',
    `**Audience:** ${intake.audience ?? 'engineering leadership / partner-level'}`,
    `**${measured ? 'Final' : 'Estimated'} length:** ${clock(timing.durationMs)}` +
      `${endCardOn ? ` (${clock(timing.contentMs)} narration + ${(timing.outroMs / 1000).toFixed(1)}s end-card)` : ' · no end card'}` +
      ` · ${timing.aspectRatio} · ${project.width}×${project.height} @ ${project.fps}fps (${project.mode})`,
    `**Voice:** ${intake.voice} @ ${intake.speed}× · **Engagement:** ${project.engagementLevel} · **Background:** ${project.background}`,
    `**Approval owner:** ${intake.approvalOwner ?? 'unassigned'} · **Words:** ${words} · ${rateLabel}`,
    '',
    `> ${project.lede ?? ''}`,
    '>',
    endCardBlock,
    '>',
    pacing,
    measured
      ? '> **Timings below are measured** — each segment was synthesised, the real audio measured, and the timeline reflowed onto it.'
      : '> **Timings below are ESTIMATED**, not measured. Nothing has been synthesised. Synthesis (S3) settles them.',
    '',
    'Claim types: `direct` = read straight from a source · `derived` = computed from sources.',
    '',
    '---',
    '',
  ];

  timing.segments.forEach((segment, index) => {
    const visual = segment.visual ?? {};
    const measuredMs = segment.audio?.durationMs ?? null;
    const spoken = measuredMs
      ? `${(measuredMs / 1000).toFixed(1)}s`
      : `${((segment.endMs - segment.startMs) / 1000).toFixed(1)}s est.`;
    const claims = (segment.claims ?? [])
      .map((c) => `\`${c.claimId}\` ${KIND_LABEL[c.type] ?? c.type} (${c.provenanceIds.join(' · ')})`)
      .join('<br>');

    lines.push(
      `### ${index + 1} · \`${segment.id}\` — ${visual.title ?? segment.title ?? segment.id}` +
        ` · ${clock(segment.startMs)}–${clock(segment.endMs)} · ${spoken} · ${wordCount(segment.voiceoverText)} words`,
      '',
      `> ${segment.voiceoverText}`,
      '',
      `**On screen:** ${visual.note ?? '_no on-screen description recorded_'}`,
      '',
      `**Claims:** ${claims || '_none — no figure is spoken in this segment_'}`,
      '',
      '---',
      ''
    );
  });

  if (!measured) {
    const SAFE_WPS = 2.81;
    const nonSpeechMs =
      (intake.leadInMs ?? 0) + (timing.segments.length - 1) * (intake.perceivedGapMs ?? 0);
    const pessimisticMs = (words / SAFE_WPS) * 1000 + nonSpeechMs;
    lines.push(
      '## Calibration note',
      '',
      `Durations above are projected at **${rate} words/sec**, the rate the sibling video`,
      '`interviewer-qna-delta` actually measured for this voice at 1.2× (`calibration-observed.json`,',
      `\`observedEffWps\`). Its conservative counterpart, \`observedSafeWps\` ${SAFE_WPS}, is the pessimistic`,
      `bound — at that rate this script would run about **${clock(pessimisticMs)}** rather than the`,
      `**${clock(timing.durationMs)}** projected above.`,
      '',
      'This script is markedly more number-dense than the one that produced the measurement, and',
      'number-dense text reads slower, so the true value probably sits between the two. **Synthesis',
      '(S3) is cheap and settles it exactly** — run it, then `validate-timing.mjs`, before committing',
      'to anything below S4.',
      ''
    );
  }

  return lines.join('\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const timing = readJson(path.join(root, 'timing.json'));

  const calibrationPath = path.join(root, 'calibration-observed.json');
  const calibration = fs.existsSync(calibrationPath) ? readJson(calibrationPath) : null;

  const observedPath = path.join(root, 'silence-observed.json');
  const observed = fs.existsSync(observedPath) ? readJson(observedPath) : null;

  const markdown = renderScript(timing, calibration, observed);

  if (argv.includes('--check')) {
    process.stdout.write(markdown);
    return 0;
  }

  const out = path.join(root, 'script.md');
  fs.writeFileSync(out, markdown);
  process.stderr.write(
    `wrote script.md — ${timing.segments.length} segments, ${clock(timing.durationMs)}, ` +
      `${calibration ? 'measured' : 'estimated'} timings\n`
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`write-script failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
