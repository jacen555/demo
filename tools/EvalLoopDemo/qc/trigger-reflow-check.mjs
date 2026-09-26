// Checks every segment's authored triggers against its MEASURED window. voice.mjs reflows
// segment windows from the real audio but does not reflow trigger times, so a trigger
// authored past the measured end never fires - silently, because a trigger that never runs
// looks exactly like one that ran early. This already cost a card on an earlier round.
import fs from 'node:fs';

const timing = JSON.parse(fs.readFileSync('timing.json', 'utf8'));
let problems = 0;

console.log('segment        window(ms)  triggers  last trigger  tail idle  status');
for (const s of timing.segments) {
  const span = s.endMs - s.startMs;
  const tr = s.triggers || [];
  const last = tr.length ? Math.max(...tr.map(t => t.atMs ?? 0)) : 0;
  const idle = span - last;
  const past = tr.filter(t => (t.atMs ?? 0) >= span);
  let status = 'ok';
  if (past.length) { status = `${past.length} PAST END - will never fire`; problems += 1; }
  else if (tr.length === 0) status = 'auto-derived';
  else if (idle > span * 0.35) status = `holds ${(idle / 1000).toFixed(1)}s (${Math.round(idle / span * 100)}%)`;

  console.log(
    `${s.id.padEnd(13)} ${String(span).padStart(10)} ${String(tr.length).padStart(9)} ` +
    `${String(last).padStart(13)} ${String(idle).padStart(10)}  ${status}`);
  for (const p of past) console.log(`    -> "${p.target}" at ${p.atMs}ms is ${p.atMs - span}ms past the end`);
}

console.log(problems === 0
  ? '\nOK: no trigger is authored past its measured segment end.'
  : `\nFAILED: ${problems} segment(s) carry triggers that can never fire.`);
process.exitCode = problems === 0 ? 0 : 1;
