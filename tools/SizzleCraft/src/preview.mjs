import { chromium } from 'playwright';
import fs from 'fs';
const t = JSON.parse(fs.readFileSync('timing.json','utf8'));
const W = t.project.width, H = t.project.height;
// Which segments to preview. Previously a hardcoded per-project list, which is why this
// script diverged between projects. Defaults to every segment; pass ids to narrow:
//   node preview.mjs                    -> all segments
//   node preview.mjs flywheel explorer  -> just those two
const requested = process.argv.slice(2);
const known = new Set(t.segments.map(s => s.id));
const unknown = requested.filter(id => !known.has(id));
if (unknown.length) {
  console.error(`unknown segment id(s): ${unknown.join(', ')}`);
  console.error(`available: ${[...known].join(', ')}`);
  process.exitCode = 1;
  process.exit();
}
const picks = (requested.length ? requested : t.segments.map(s => s.id)).map(id => [id, id]);
const b = await chromium.launch({headless:true, args:['--disable-dev-shm-usage','--force-color-profile=srgb']});
const p = await b.newPage({viewport:{width:W,height:H}, deviceScaleFactor:1});
await p.goto('file:///'+process.cwd().replace(/\\/g,'/')+'/video-auto.html',{waitUntil:'load'});
await p.waitForTimeout(500);
fs.mkdirSync('preview',{recursive:true});
for (const [name,id] of picks) {
  const s = t.segments.find(x=>x.id===id);
  const time = (s.startMs + (s.endMs-s.startMs)*0.86)/1000;   // late in the segment: everything revealed
  await p.evaluate(tm=>{ if(window.masterTimeline){window.masterTimeline.seek(tm);window.masterTimeline.pause();} if(window.fireTriggersUpTo)window.fireTriggersUpTo(tm); }, time);
  await p.waitForTimeout(180);
  const issues = await p.evaluate(()=>window.auditLayout?window.auditLayout():[]);
  await p.screenshot({path:`preview/${name}.png`});
  console.log(`${name.padEnd(10)} t=${time.toFixed(1)}s  layout issues: ${issues.length? JSON.stringify(issues):'none'}`);
}
// end-card
const ec = (t.contentMs + 1200)/1000;
await p.evaluate(tm=>{ if(window.masterTimeline){window.masterTimeline.seek(tm);window.masterTimeline.pause();} if(window.fireTriggersUpTo)window.fireTriggersUpTo(tm); }, ec);
await p.waitForTimeout(180);
await p.screenshot({path:'preview/endcard.png'});
console.log('endcard    t='+ec.toFixed(1)+'s');
await b.close();
