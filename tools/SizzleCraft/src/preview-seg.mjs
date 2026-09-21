import { chromium } from 'playwright';
import fs from 'fs';

const t = JSON.parse(fs.readFileSync('timing.json', 'utf8'));
const W = t.project.width, H = t.project.height;
const id = process.argv[2] || 'flywheel';
const fracs = (process.argv[3] || '0.5,0.75,0.9,0.98').split(',').map(Number);

const s = t.segments.find(x => x.id === id);
const b = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--force-color-profile=srgb'] });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await p.goto('file:///' + process.cwd().replace(/\\/g, '/') + '/video-auto.html', { waitUntil: 'load' });
await p.waitForTimeout(500);
fs.mkdirSync('preview', { recursive: true });

for (const fr of fracs) {
  const time = (s.startMs + (s.endMs - s.startMs) * fr) / 1000;
  await p.evaluate(tm => {
    if (window.masterTimeline) { window.masterTimeline.seek(tm); window.masterTimeline.pause(); }
    if (window.fireTriggersUpTo) window.fireTriggersUpTo(tm);
  }, time);
  await p.waitForTimeout(900);            // let any in-flight draw finish
  await p.screenshot({ path: `preview/${id}-${Math.round(fr * 100)}.png` });
  console.log(`${id} @ ${(fr * 100).toFixed(0)}%  t=${time.toFixed(1)}s`);
}
await b.close();
