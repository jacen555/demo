// Storyboard preview — derived from timing.json so it can never drift from the approved timeline.
import fs from 'node:fs';
import { EXIT, guard, parseCli, requireExistingFile, resolveOutput, describeWrite, planFooter } from './cli-support.mjs';

const USAGE = `
write-storyboard — render storyboard.html from timing.json (pipeline stage S2).

  node write-storyboard.mjs                      plan only (default)
  node write-storyboard.mjs --apply              write storyboard.html
  node write-storyboard.mjs --apply --replace    overwrite an existing storyboard.html

Options
  --out <file>      output path (default: storyboard.html)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing --out
  --help            show this message

Exit codes: 0 success/plan · 1 write failed · 2 bad usage or refused overwrite
`.trimStart();

const { values, projectDir, apply, replace } = guard(() => parseCli({ usage: USAGE, options: { out: { type: 'string' } } }));
const t = JSON.parse(fs.readFileSync(guard(() => requireExistingFile(projectDir, 'timing.json', 'timing file')), 'utf8'));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAL = ['#0078D4', '#00B7C3', '#8661C5', '#E3008C', '#107C10', '#F7630C'];
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;

const panel = (s, i) => {
  const v = s.visual || {}, ca = PAL[i % PAL.length];
  const win = ((s.endMs - s.startMs) / 1000).toFixed(1);
  const words = s.voiceoverText.trim().split(/\s+/).length;

  const cards = (v.items || []).map((it, j) => `
    <div class="card" style="border-top:4px solid ${PAL[j % PAL.length]}">
      <div class="k">${esc(it.label || '')}</div>
      ${it.value ? `<div class="v" style="color:${PAL[j % PAL.length]}">${esc(it.value)}</div>` : ''}
      <div class="b">${esc(it.text || '')}</div>
    </div>`).join('');

  const shots = (v.shots || []).map(s => `
    <figure class="shot"><img src="${esc(s.src)}" alt="${esc(s.label||'')}"/>
    ${s.label ? `<figcaption>${esc(s.label)}</figcaption>` : ''}</figure>`).join('');

  const diagram = v.nodes ? `
    <svg viewBox="${esc(v.viewBox || '0 0 1600 900')}" class="dg">
      ${(v.edges || []).map((e, j) => {
        const a = (v.nodes || []).find(n => n.id === e.from) || {}, b = (v.nodes || []).find(n => n.id === e.to) || {};
        const ax = (+a.x || 0) + (+a.w || 240) / 2, ay = (+a.y || 0) + (+a.h || 96) / 2;
        const bx = (+b.x || 0) + (+b.w || 240) / 2, by = (+b.y || 0) + (+b.h || 96) / 2;
        return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${PAL[j % PAL.length]}" stroke-width="5" opacity=".75"/>`;
      }).join('')}
      ${(v.nodes || []).map((n, j) => `
        <g>
          <rect x="${+n.x || 0}" y="${+n.y || 0}" width="${+n.w || 240}" height="${+n.h || 96}" rx="14"
                fill="#fff" stroke="${PAL[j % PAL.length]}" stroke-width="4"/>
          <foreignObject x="${+n.x || 0}" y="${+n.y || 0}" width="${+n.w || 240}" height="${+n.h || 96}">
            <div xmlns="http://www.w3.org/1999/xhtml" class="nl">${esc(n.label || n.id)}</div>
          </foreignObject>
          <circle cx="${(+n.x || 0) + 22}" cy="${(+n.y || 0) + 22}" r="20" fill="${PAL[j % PAL.length]}"/>
          <text x="${(+n.x || 0) + 22}" y="${(+n.y || 0) + 30}" text-anchor="middle" fill="#fff" font-size="24" font-weight="700">${j + 1}</text>
        </g>`).join('')}
    </svg>` : '';

  const claims = (s.claims || []).map(c =>
    `<span class="claim ${esc(c.type)}">${esc(c.claimId)} · ${esc(c.type)} · ${esc(c.provenanceIds.join(', '))}</span>`).join('');

  return `
  <section class="seg">
    <header style="--ca:${ca}">
      <span class="num">${String(i + 1).padStart(2, '0')}</span>
      <div>
        <div class="kick">${esc(v.kicker || '')}</div>
        <h2>${esc(v.title || s.title || s.id)}</h2>
        <div class="sub">${esc(v.subtitle || '')}</div>
      </div>
      <div class="meta">
        <b>${clock(s.startMs)} – ${clock(s.endMs)}</b>
        <span>${win}s · ${words} words</span>
        <span class="mode">${esc(v.mode || 'narrative')}${v.layout ? ' / ' + esc(v.layout) : ''}</span>
      </div>
    </header>
    <div class="grid2">
      <div class="vo"><div class="volabel">VOICEOVER</div><p>${esc(s.voiceoverText)}</p><div class="claims">${claims}</div></div>
      <div class="viz">${diagram || shots || `<div class="cards">${cards}</div>`}</div>
    </div>
  </section>`;
};

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Storyboard — ${esc(t.project.title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#F5F8FC;color:#201F1E;font:15px/1.55 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:30px;margin:0 0 6px}
.lede{color:#5b5a58;margin:0 0 8px}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 30px}
.badges span{background:#fff;border:1px solid #dfe3ea;border-radius:999px;padding:5px 13px;font-size:12.5px}
.seg{background:#fff;border:1px solid #e3e7ee;border-radius:14px;margin-bottom:18px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05)}
header{display:flex;gap:16px;align-items:flex-start;padding:16px 20px;border-bottom:1px solid #eef1f6;border-left:6px solid var(--ca)}
.num{font-size:26px;font-weight:800;color:var(--ca);min-width:38px}
header h2{margin:2px 0 3px;font-size:20px}
.kick{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--ca);font-weight:700}
.sub{color:#5b5a58;font-size:13.5px}
.meta{margin-left:auto;text-align:right;font-size:12px;color:#5b5a58;display:flex;flex-direction:column;gap:3px;white-space:nowrap}
.meta b{font-size:14px;color:#201F1E}
.mode{background:#eef3fb;color:#0078D4;border-radius:5px;padding:2px 8px;font-weight:600}
.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:20px;padding:18px 20px 20px}
.volabel{font-size:10.5px;letter-spacing:.14em;color:#8a8886;font-weight:700;margin-bottom:6px}
.vo p{margin:0 0 12px;font-size:16px;line-height:1.62}
.claims{display:flex;flex-direction:column;gap:5px}
.claim{font-size:11px;font-family:ui-monospace,Consolas,monospace;background:#f2f7f2;border-left:3px solid #107C10;padding:4px 8px;border-radius:0 4px 4px 0;color:#3b3a39;word-break:break-word}
.claim.derived{background:#fff8ee;border-left-color:#F7630C}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:#fff;border:1px solid #e6eaf1;border-radius:9px;padding:11px 13px}
.k{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#605e5c;font-weight:700}
.v{font-size:23px;font-weight:800;margin:3px 0 5px;letter-spacing:-.5px}
.b{font-size:12.5px;color:#4a4948;line-height:1.45}
.dg{width:100%;background:#fbfcfe;border:1px solid #e6eaf1;border-radius:9px}
.shot{margin:0}.shot img{width:100%;border:1px solid #e6eaf1;border-radius:9px;display:block}
.shot figcaption{font-size:12px;color:#605e5c;margin-top:6px;text-align:center}
.nl{width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:8px 12px 8px 42px;font:600 26px/1.25 "Segoe UI",sans-serif;color:#201F1E}
footer{margin-top:26px;color:#8a8886;font-size:12.5px;text-align:center}
</style></head><body><div class="wrap">
<h1>${esc(t.project.title)} — storyboard</h1>
<p class="lede">${esc(t.project.lede || t.project.subtitle || '')}</p>
<div class="badges">
  <span><b>${clock(t.durationMs)}</b> total (${clock(t.contentMs)} narration + ${(t.outroMs / 1000).toFixed(1)}s end-card)</span>
  <span>${t.segments.length} segments</span>
  <span>${t.aspectRatio} · ${t.project.width}×${t.project.height} @ ${t.project.fps}fps (${t.project.mode})</span>
  <span>${esc(t.intake.voice)} @ ${t.intake.speed}×</span>
  <span>engagement: ${esc(t.project.engagementLevel)}</span>
  <span>background: ${esc(t.project.background)}</span>
</div>
${t.segments.map(panel).join('')}
<footer>Preview only — final frames are rendered by the Builder from this same timing.json. Step numbers show reveal order; motion (edge draw, flowing particles, active-path pulse) is applied at render.</footer>
</div></body></html>`;

const outPath = guard(() => resolveOutput(projectDir, values.out ?? 'storyboard.html', { apply, replace, label: 'output' }));
if (!apply) {
  console.log(`plan: render a storyboard for ${t.segments?.length ?? 0} segment(s)`);
  console.log(`  source ${projectDir}/timing.json`);
  console.log(`  output ${outPath} — ${describeWrite(outPath, replace)}`);
  planFooter();
  process.exit(EXIT.OK);
}
fs.writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${t.segments.length} segments, ${clock(t.durationMs)})`);



