import fs from 'fs';
import Ajv from 'ajv/dist/2020.js';
const schema = JSON.parse(fs.readFileSync('timing-schema.json','utf8'));
const t = JSON.parse(fs.readFileSync('timing.json','utf8'));
const ajv = new Ajv({allErrors:true, strict:false});
const ok = ajv.compile(schema)(t);
console.log('SCHEMA VALID:', ok);
if(!ok) console.log(JSON.stringify(ajv.errors,null,2).slice(0,3000));
// invariants
const segs=t.segments;
console.log('lastSeg.endMs',segs.at(-1).endMs,'contentMs',t.contentMs,'durationMs',t.durationMs);
let prev=0, bad=[];
for(const s of segs){ if(s.startMs!==prev) bad.push(`${s.id} gap/overlap at ${s.startMs} (expected ${prev})`); prev=s.endMs; }
console.log('contiguity:', bad.length? bad : 'OK');
// Effective speech rate used for the word-budget check.
// This is the ONLY thing that diverged between projects (3.43*0.97 vs 3.00*0.95), which
// is calibration data, not logic — so it is read from the project rather than hardcoded.
// Set `intake.wordsPerSecond` / `intake.wpsSafetyMargin` in timing.json, or drop a
// calibration-observed.json next to it. Falls back to a conservative default.
function resolveWps(timing) {
  let observed = null;
  try {
    observed = JSON.parse(fs.readFileSync('calibration-observed.json', 'utf8'));
  } catch {
    // No calibration file — expected for a new project, not an error.
  }

  const intake = timing.intake || {};
  const rate = observed?.wordsPerSecond ?? intake.wordsPerSecond ?? 3.00;
  const margin = observed?.wpsSafetyMargin ?? intake.wpsSafetyMargin ?? 0.95;
  const source = observed?.wordsPerSecond
    ? 'calibration-observed.json'
    : intake.wordsPerSecond
      ? 'timing.json intake'
      : 'default';

  return { wps: rate * margin, rate, margin, source };
}

const { wps: WPS, rate, margin, source } = resolveWps(t);
console.log(`\nword rate: ${rate} wps x ${margin} margin = ${WPS.toFixed(2)} effective (source: ${source})`);
console.log('\nsegment            window(s)  words  budget  headroom');
let tw=0;
for(const s of segs){
  const win=(s.endMs-s.startMs)/1000;
  const w=s.voiceoverText.trim().split(/\s+/).length; tw+=w;
  const budget=Math.floor(win*WPS);
  const flag = w>budget ? '  <-- OVER' : '';
  console.log(`${s.id.padEnd(18)} ${String(win).padStart(7)}  ${String(w).padStart(5)}  ${String(budget).padStart(6)}  ${String(budget-w).padStart(8)}${flag}`);
}
console.log(`\ntotal words ${tw}, total window ${(t.contentMs/1000)}s, implied wps ${(tw/(t.contentMs/1000)).toFixed(2)} (ceiling ${WPS.toFixed(2)})`);


