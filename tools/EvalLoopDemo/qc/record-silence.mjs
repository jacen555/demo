/*
 * Records the DECODED silence profile of voiceover.mp3 into silence-observed.json.
 *
 * `silence-scan.mjs` prints; it does not write. So this record was being maintained by
 * hand, and a re-synthesis left it describing a voiceover that no longer existed —
 * durationMs 281712 against a timeline of 276528. The project test caught it, which is
 * the only reason it did not ship.
 *
 * Hand-maintained evidence goes stale silently, so it is generated here instead: run the
 * scan, parse its output, and write the record. The point of the file is that these are
 * MEASURED BY DECODING rather than read from synthesis metadata (bug-ledger 5) — msedge-tts
 * reported a 0 ms tail on all 8 clips and the decoder disproves it — and a stale
 * measurement is no better than a trusted input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(dir, '..', 'SizzleCraft', 'src', 'silence-scan.mjs');
const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));

const out = execFileSync(process.execPath, [scanner, 'voiceover.mp3'], { cwd: dir, encoding: 'utf8' });

const total = /voiceover\.mp3:\s*(\d+)ms total/.exec(out);
if (!total) throw new Error('silence-scan output did not report a total duration');
const durationMs = Number(total[1]);

if (durationMs !== timing.durationMs) {
  throw new Error(`decoded voiceover is ${durationMs}ms but the timeline is ${timing.durationMs}ms — `
    + 'regenerate the voiceover or the timeline before recording this');
}

const runs = [...out.matchAll(/(\d+):(\d{2})\.(\d{3})\s*->\s*(\d+):(\d{2})\.(\d{3})\s+([\d.]+)s/g)]
  .map(m => ({
    startMs: (+m[1] * 60 + +m[2]) * 1000 + +m[3],
    endMs: (+m[4] * 60 + +m[5]) * 1000 + +m[6],
    seconds: Number(m[7]),
  }));
if (runs.length === 0) throw new Error('silence-scan reported no silence runs — that cannot be right for this narration');


const leadIn = runs[0].startMs <= 50 ? runs[0] : null;

// Per-boundary decoded gaps. The expected shape is one measurement per segment JOIN
// (segments - 1), matched to the silence run that straddles it — a boundary sits INSIDE
// its gap, not at the start of it, which is what made a naive "run starts near a boundary"
// test classify every gap as an intra-segment pause.
const insertedMs = timing.segments.length > 1
  ? timing.segments[1].startMs - timing.segments[0].endMs
  : 0;

const decodedMs = [];
const afterSegment = [];
for (let i = 0; i < timing.segments.length - 1; i += 1) {
  const boundaryStart = timing.segments[i].endMs;
  const boundaryEnd = timing.segments[i + 1].startMs;
  const run = runs.find(r => r.endMs >= boundaryStart - 150 && r.startMs <= boundaryEnd + 150);
  if (!run) {
    throw new Error(`no decoded silence found around the join after "${timing.segments[i].id}" `
      + `(${boundaryStart}..${boundaryEnd}ms) — the narration may not have been re-synthesised`);
  }
  decodedMs.push(run.endMs - run.startMs);
  afterSegment.push(timing.segments[i].id);
}
const decodedMeanMs = Math.round(decodedMs.reduce((a, b) => a + b, 0) / decodedMs.length);

// Every run that is neither the lead-in nor a boundary gap is a pause inside a segment.
const boundaryRuns = new Set();
for (let i = 0; i < timing.segments.length - 1; i += 1) {
  const r = runs.find(x => x.endMs >= timing.segments[i].endMs - 150 && x.startMs <= timing.segments[i + 1].startMs + 150);
  if (r) boundaryRuns.add(r);
}

const record = {
  _readme: [
    'Decoded silence measurements for voiceover.mp3, from:',
    '  node qc/record-silence.mjs   (which runs ../SizzleCraft/src/silence-scan.mjs)',
    '',
    'These are MEASURED BY DECODING, not read from synthesis metadata (bug-ledger entry 5).',
    'They exist because voice.mjs solves the gap from msedge-tts word-boundary metadata, and',
    'that metadata reported a 0 ms tail on all 8 clips — which the decoder disproves:',
    'the decoded gap is consistently LONGER than the silence that was inserted.',
    '',
    'GENERATED. Do not hand-edit: a hand-maintained measurement goes stale silently, and this',
    'file already once described a voiceover that had been re-synthesised out of existence.',
  ],
  source: 'voiceover.mp3',
  method: 'ffmpeg silencedetect via silence-scan.mjs, threshold >= 400ms',
  scannedAtUtc: new Date().toISOString(),
  durationMs,
  leadIn,
  perceivedGaps: { insertedMs, decodedMs, decodedMeanMs, afterSegment },
  intraSegmentPauses: runs.filter(r => r !== leadIn && !boundaryRuns.has(r)),
};

fs.writeFileSync(path.join(dir, 'silence-observed.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(`silence-observed.json — ${durationMs}ms decoded, matches timeline`);
console.log(`  lead-in ${leadIn ? `${(leadIn.endMs - leadIn.startMs)}ms` : 'none'} · `
  + `${decodedMs.length} boundary gap(s), mean ${decodedMeanMs}ms decoded vs ${insertedMs}ms inserted · `
  + `${record.intraSegmentPauses.length} intra-segment pause(s)`);
