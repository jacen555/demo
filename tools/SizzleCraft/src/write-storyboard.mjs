// Storyboard preview — derived from timing.json so it can never drift from the approved timeline.
import fs from 'node:fs';
import { EXIT, CliError, guard, parseCli, requireExistingFile, resolveOutput, describeWrite, planFooter, describeJsonValue } from './cli-support.mjs';
import { isSilentSegment, silentCaption, silentSegmentProblems, wordsInSegment, segmentEntryBlocker, segmentLabel } from './silent-segment.mjs';
import { BRAND_PALETTE } from './brand-palette.mjs';

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

Exit codes: 0 success/plan · 1 write failed · 2 bad usage, a refused overwrite, or a timeline it cannot read
`.trimStart();

const { values, projectDir, apply, replace } = guard(() => parseCli({ usage: USAGE, options: { out: { type: 'string' } } }));
// Refused, not crashed. This was a bare JSON.parse wrapped only around the path resolve:
// an unparseable timing.json escaped as an uncaught SyntaxError with a stack and exit 1.
// Unreadable input is the caller's fault — EXIT.USAGE by cli-support's definition, a
// missing prerequisite — and CliError defaults to it. Same wording as frame-capture.
const t = guard(() => {
  const timingPath = requireExistingFile(projectDir, 'timing.json', 'timing file');
  const text = fs.readFileSync(timingPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    // Reported by size, never by contents — see remix.mjs and write-chapters.mjs:197. V8's
    // parse message quotes the opening bytes of the file back at the caller.
    throw new CliError(`${timingPath} is not valid JSON (${text.length} characters)`);
  }
});
// SHAPE FIRST. A null, an array or a string where a segment object belongs used to reach
// `panel` and throw an uncaught TypeError on `s.visual` — a crash with a stack, not a
// refusal, and the path had no exit code of its own. Asked before the declaration check
// below, so a malformed entry is named as what it is rather than crashing the check that
// would have described it.
//
// THE ENTRY RULE ONLY: segmentEntryBlocker returns null for a non-array and says nothing
// about ids, so this stage's handling of an empty or id-less list is unchanged.
guard(() => {
  // THE LIST ITSELF, FIRST. `(t.segments || [])` guards ABSENCE and not TYPE — a non-empty
  // string is truthy — so `segments: "two of them"` threw `.filter is not a function`, and
  // an absent or null list threw on `.length`. A list that is PRESENT and is not a list
  // cannot be read and is refused; absent and null are read as empty, which is what the
  // plan line below already intended with `segments.length` over `t.segments?.length ?? 0`.
  if (t.segments !== undefined && t.segments !== null && !Array.isArray(t.segments)) {
    throw new CliError(
      `timing.segments is not a list of segments — it is ${describeJsonValue(t.segments)}. ` +
        'Every stage reads it as a list; one that is not a list cannot be read at all.',
    );
  }
  const bad = segmentEntryBlocker(t.segments);
  if (bad) throw new CliError(bad.fact);
});

// READ ONCE, HERE, AND NOWHERE ELSE. Every site below used its own idiom for the same
// question — `t.segments || []` in one place, `t.segments.length` in three, and
// `t.segments?.length ?? 0` in the plan line — so the file disagreed with itself about
// what an absent list means and crashed at the sites that had no guard at all.
const segments = Array.isArray(t.segments) ? t.segments : [];

// RENDERING METADATA IS NOT THE TIMELINE. A storyboard with no `intake` has nothing to put
// in one badge; a segments list that is not a list means the file cannot be read. So these
// are rendered blank rather than refused, which is the idiom this file already used for a
// missing FIELD (`t.project.lede || t.project.subtitle || ''`). Not a type check: a
// `project` that is a string renders empty badges today and is left alone, because
// refusing it would widen past the defect.
const project = t.project ?? {};
const intake = t.intake ?? {};
// A silent segment's caption is its accessibility cue, and the storyboard is where an author
// reviews it. A blank caption rendered as an empty cue under the SILENT label and exited 0.
// Refuse the declarations validate-timing, voice and write-subtitles refuse, before planning.
guard(() => {
  // THE INDEX IS KEPT. `.filter().flatMap()` discarded it before the label needed it, so
  // silentSegmentProblems fell back to its default `segment "${seg?.id}"` and an id-less
  // segment became `segment "undefined"`. The label comes from the shared symbol, as every
  // other one in this change does.
  const problems = segments.flatMap((s, i) => (isSilentSegment(s) ? silentSegmentProblems(s, segmentLabel(s, i)) : []));
  if (problems.length) throw new CliError(problems.join('\n'));
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAL = BRAND_PALETTE;
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;

const panel = (s, i) => {
  const v = s.visual || {}, ca = PAL[i % PAL.length];
  const win = ((s.endMs - s.startMs) / 1000).toFixed(1);
  // `''.split(/\s+/)` is `['']` — length 1 — so a segment with no narration reported ONE
  // word. A number that looks measured and is not is worse than no number, because the
  // storyboard is what an author reviews the pacing against.
  const words = wordsInSegment(s);
  const silent = isSilentSegment(s);

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
        <span>${win}s · ${silent ? 'silent' : `${words} words`}</span>
        <span class="mode">${esc(v.mode || 'narrative')}${v.layout ? ' / ' + esc(v.layout) : ''}</span>
      </div>
    </header>
    <div class="grid2">
      <div class="vo"><div class="volabel">${silent ? 'SILENT — ACCESSIBILITY CUE' : 'VOICEOVER'}</div><p>${silent ? esc(silentCaption(s)) : esc(s.voiceoverText)}</p><div class="claims">${claims}</div></div>
      <div class="viz">${diagram || shots || `<div class="cards">${cards}</div>`}</div>
    </div>
  </section>`;
};

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Storyboard — ${esc(project.title)}</title>
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
<h1>${esc(project.title)} — storyboard</h1>
<p class="lede">${esc(project.lede || project.subtitle || '')}</p>
<div class="badges">
  <span><b>${clock(t.durationMs)}</b> total (${clock(t.contentMs)} narration + ${(t.outroMs / 1000).toFixed(1)}s end-card)</span>
  <span>${segments.length} segments</span>
  <span>${t.aspectRatio} · ${esc(project.width)}×${esc(project.height)} @ ${esc(project.fps)}fps (${esc(project.mode)})</span>
  <span>${esc(intake.voice)} @ ${esc(intake.speed)}×</span>
  <span>engagement: ${esc(project.engagementLevel)}</span>
  <span>background: ${esc(project.background)}</span>
</div>
${segments.map(panel).join('')}
<footer>Preview only — final frames are rendered by the Builder from this same timing.json. Step numbers show reveal order; motion (edge draw, flowing particles, active-path pulse) is applied at render.</footer>
</div></body></html>`;

const outPath = guard(() => resolveOutput(projectDir, values.out ?? 'storyboard.html', { apply, replace, label: 'output' }));
if (!apply) {
  console.log(`plan: render a storyboard for ${segments.length} segment(s)`);
  console.log(`  source ${projectDir}/timing.json`);
  console.log(`  output ${outPath} — ${describeWrite(outPath, replace)}`);
  planFooter();
  process.exit(EXIT.OK);
}
fs.writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${segments.length} segments, ${clock(t.durationMs)})`);



