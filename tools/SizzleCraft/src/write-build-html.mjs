import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXIT, guard, parseCli, resolveOutput, describeWrite, planFooter } from './cli-support.mjs';

const USAGE = `
write-build-html — build the renderable scene video-auto.html from timing.json (stage S5).

  node write-build-html.mjs                      plan only (default)
  node write-build-html.mjs --apply              write video-auto.html
  node write-build-html.mjs --apply --replace    overwrite an existing video-auto.html

Options
  --out <file>      output path (default: video-auto.html)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing --out
  --help            show this message

Exit codes: 0 success/plan · 1 build failed · 2 bad usage or refused overwrite
`.trimStart();

// Parsed before any read, so --help cannot reach the filesystem.
const cli = (() => {
  try {
    return parseCli({ usage: USAGE, options: { out: { type: 'string' } } });
  } catch (err) {
    if (err.name === 'HelpRequested') { console.log(err.usage); process.exit(EXIT.OK); }
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode ?? EXIT.FAILED);
  }
})();

const dir = cli.projectDir;
const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
// Harden DOM tokens: segment ids AND node/edge ids (and edge from/to) get interpolated into DOM/SVG
// element ids (e.g. `${seg.id}-label`, `${seg.id}-shot-0`, node/edge ids) and `url(#…)` marker refs. The
// timing schema already constrains these to a safe token, so VALIDATE (fail fast) here rather than
// coercing — silent coercion could collapse distinct invalid ids to the same token (duplicate element
// ids) or desync explicit trigger targets from the rendered ids.
const TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
const assertTok = (val, where) => { const t = String(val == null ? '' : val); if (!TOKEN_RE.test(t)) throw new Error(`invalid DOM token ${JSON.stringify(val)} at ${where} — must match ${TOKEN_RE} (fix timing.json and re-run schema validation)`); return t; };
for (const s of (timing.segments || [])) {
  if (s && s.id != null) assertTok(s.id, `segments[].id ${JSON.stringify(s.id)}`);
  const v = s.visual; if (!v) continue;
  (v.nodes || []).forEach((n, i) => { if (n && n.id != null) assertTok(n.id, `${s.id}.nodes[${i}].id`); });
  (v.edges || []).forEach((e, i) => { if (!e) return; if (e.id != null) assertTok(e.id, `${s.id}.edges[${i}].id`); if (e.from != null) assertTok(e.from, `${s.id}.edges[${i}].from`); if (e.to != null) assertTok(e.to, `${s.id}.edges[${i}].to`); });
}
const w = timing.project?.width || 3840, h = timing.project?.height || 2160;
// Repair the classic "UTF-8 bytes read back as Latin-1/CP1252" mojibake (e.g. "Â·" -> "·", "â€™" -> "'")
// that upstream tools can bake into titles/labels/watermarks on Windows. Guarded: it only re-decodes when
// the string is EXACTLY the latin1 view of a valid UTF-8 byte sequence (no U+FFFD and perfectly
// reversible), so clean text — and lone accented chars like "é" (U+00E9) — pass through byte-identical.
const demojibake = s => {
  if (!/[\u00C2\u00C3\u00E2]/.test(s)) return s;
  try { const r = Buffer.from(s, 'latin1').toString('utf8'); if (!r.includes('\uFFFD') && Buffer.from(r, 'utf8').toString('latin1') === s) return r; } catch {}
  return s;
};
const esc = s => demojibake(String(s ?? '')).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// jsonScript() is the ONLY sanctioned way to embed timing-derived JSON inside a <script> block.
// Valid JSON is NOT script-safe: a narration/title/payload string containing `</script><script>` would
// terminate the block early and inject attacker markup, and U+2028/U+2029 are raw line terminators in
// JS source. Escaping `<`, `>`, `&`, U+2028 and U+2029 to \uXXXX form keeps the value byte-for-byte
// equivalent after JSON.parse while making script breakout structurally impossible. Never interpolate a
// bare JSON.stringify(...) into `<script>`.
const jsonScript = (value, space) => JSON.stringify(value, null, space)
  .replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// SAFE_SRC is canonical containment, not a regex-only allowlist. Every generated image source must
// resolve beneath this run's approved evidence-pack root and remain a local relative file path.
// Containment is decided on the REALPATH: a symlink/junction/reparse point inside evidence-pack whose
// target lives outside it is an escape, and path.resolve() alone cannot see that.
let EVIDENCE_ROOT;
try {
  EVIDENCE_ROOT = fs.realpathSync(path.resolve(dir, 'evidence-pack'));
} catch (err) {
  // A bare ENOENT stack here reads as a crash rather than a missing prerequisite.
  console.error(
    `error: evidence-pack/ not found in ${dir} (${err.code ?? err.message}) — every on-screen asset must ` +
      `resolve beneath the approved evidence pack, so the scene cannot be built without it.`,
  );
  process.exit(EXIT.USAGE);
}
const safeEvidenceSrc = raw => {
  const s = String(raw ?? '').trim();
  if (!s || s.includes('\0') || s.includes('\\') || s.includes('%') || /[?#]/.test(s)) throw new Error('unsafe evidence src rejected');
  if (s.startsWith('//') || s.startsWith('/') || /^[A-Za-z]:/.test(s) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) throw new Error('unsafe evidence src rejected');
  const parts = s.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error('unsafe evidence src rejected');
  const absolute = path.resolve(dir, ...parts);
  const inside = path.relative(EVIDENCE_ROOT, absolute);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('unsafe evidence src rejected');
  // Reject reparse points (POSIX symlinks AND Windows symlinks/junctions/mount points) on every
  // component, then re-check containment on the fully resolved realpath. lstat() is what distinguishes a
  // link from its target; on Windows a junction reports isSymbolicLink() === true for lstat, and any
  // other reparse point still resolves differently under realpath, which the containment re-check below
  // catches. Missing files are allowed to fail the realpath step and be rejected.
  let walk = EVIDENCE_ROOT;
  for (const part of path.relative(EVIDENCE_ROOT, absolute).split(path.sep)) {
    walk = path.join(walk, part);
    let st; try { st = fs.lstatSync(walk); } catch { throw new Error('unsafe evidence src rejected'); }
    if (st.isSymbolicLink()) throw new Error('unsafe evidence src rejected');
  }
  let real; try { real = fs.realpathSync(absolute); } catch { throw new Error('unsafe evidence src rejected'); }
  const realInside = path.relative(EVIDENCE_ROOT, real);
  if (!realInside || realInside === '..' || realInside.startsWith(`..${path.sep}`) || path.isAbsolute(realInside)) throw new Error('unsafe evidence src rejected');
  return path.relative(dir, absolute).split(path.sep).join('/');
};
// Aggregate, don't throw on the first bad path: a run with three broken sources should report all three
// with the OWNING segment id and the offending src, not one anonymous "unsafe evidence src rejected".
const srcErrors = [];
const checkedSrc = (raw, segmentId, where) => {
  try { return safeEvidenceSrc(raw); }
  catch { srcErrors.push(`segment "${segmentId}" ${where}: ${JSON.stringify(String(raw ?? ''))} is not a contained evidence-pack path`); return null; }
};
const assertNoSrcErrors = () => {
  if (srcErrors.length) throw new Error(`unsafe evidence src rejected — ${srcErrors.length} invalid source(s):\n  - ${srcErrors.join('\n  - ')}`);
};

// ---- footage (real user clip) metadata, resolved from clip-video output --------------------------
// A `footage` segment plays REAL extracted clip frames (evidence-pack/footage/<clipId>/frame_*.jpg)
// as a full-bleed background; the frame index is chosen per capture frame by window.__setFootageFrame.
let FOOTAGE = {};
try { FOOTAGE = JSON.parse(fs.readFileSync(path.join(dir, 'evidence-pack', 'footage', 'clips.json'), 'utf8')); } catch {}
let MANIFEST = {};
try { MANIFEST = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch {}
const DERIVED_FOOTAGE = MANIFEST.stages?.['materialize-footage']?.derivedFootage || null;
// C-11: evidence-pack.json is the SINGLE source of truth for what may appear on-screen. clips.json alone
// is NOT sufficient — a tampered clips.json must not be able to smuggle an unapproved clip in.
let EVIDENCE = {};
try { EVIDENCE = JSON.parse(fs.readFileSync(path.join(dir, 'evidence-pack', 'evidence-pack.json'), 'utf8')); } catch {}
const evidenceApprovedClip = id => !!id && (EVIDENCE.assets || []).some(a => a && a.kind === 'clip' && a.approvedForUse === true && a.id === id);
// clipId is used verbatim as a path segment; force it to a single safe token (no separators / `..`)
// so neither the fallback path nor the frame URLs can escape evidence-pack/footage/.
const safeClipId = id => { const s = String(id || ''); return (/^[A-Za-z0-9._-]{1,128}$/.test(s) && s !== '.' && s !== '..') ? s : ''; };
const footageClip = id => { const cid = safeClipId(id); return cid ? ((FOOTAGE.clips || []).find(c => c.id === cid) || null) : null; };
// C-3/C-11: a clip may only be composited when it is approved AND redaction-clear in clips.json AND has
// a matching approved evidence-pack asset (kind:"clip", approvedForUse:true, id===clipId) — the manifest
// is the authoritative gate, so a tampered clips.json can never approve a clip on its own.
const footageApproved = c => !!c && c.approvedForUse === true && c.redaction === 'clear' && evidenceApprovedClip(c.id);
const footageUsable = seg => footageApproved(footageClip(seg.visual?.footage?.clipId));
// A segment renders as `footage` ONLY when its clip is approved + redaction-clear; otherwise it falls
// back to a synthetic mode (explicit visual.mode, else inferred diagram/live/narrative) so the panel is
// never blank and autoTriggers() still generates the reveal/diagram/live triggers (schema/docs promise).
const mode = seg => { const v = seg.visual || {}; if ((v.mode === 'footage' || (!v.mode && v.footage)) && footageUsable(seg)) return 'footage'; if (v.mode && v.mode !== 'footage') return v.mode; return v.nodes ? 'diagram' : (v.shot || v.fields || v.hotspots) ? 'live' : 'narrative'; };
// Playback metadata is security-sensitive: frameCount changes where playback clamps, while fps changes
// timestamp-to-frame mapping. Derive count from the exact independently enumerated frame set, bind fps
// to storyboard-protected timing.project.fps, and require clips.json + manifest lineage to agree.
const FRAME_FILE_RE = /^frame_[0-9]{5}\.(?:jpg|jpeg|png|webp)$/i;
const containedRelative = (root, candidate, where) => {
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`footage lineage mismatch: ${where} escaped its clip root`);
  return rel;
};
const frameSetFacts = id => {
  const cid = safeClipId(id);
  if (!cid) throw new Error(`footage lineage mismatch: unsafe clip id ${JSON.stringify(id)}`);
  const clipRoot = path.resolve(EVIDENCE_ROOT, 'footage', cid);
  let rootStat;
  try { rootStat = fs.lstatSync(clipRoot); } catch { throw new Error(`footage lineage mismatch: missing frame root for ${cid}`); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`footage lineage mismatch: invalid frame root for ${cid}`);
  const clipReal = fs.realpathSync(clipRoot);
  containedRelative(EVIDENCE_ROOT, clipReal, `${cid} frame root`);
  const frames = [];
  const walk = current => {
    for (const name of fs.readdirSync(current)) {
      const candidate = path.join(current, name);
      const st = fs.lstatSync(candidate);
      if (st.isSymbolicLink()) throw new Error(`footage lineage mismatch: linked frame path for ${cid}`);
      const real = fs.realpathSync(candidate);
      containedRelative(clipReal, real, `${cid}/${name}`);
      if (st.isDirectory()) { walk(candidate); continue; }
      if (!FRAME_FILE_RE.test(name)) continue;
      if (!st.isFile()) throw new Error(`footage lineage mismatch: non-regular frame for ${cid}`);
      frames.push({ relative: path.relative(clipReal, real).split(path.sep).join('/'), real });
    }
  };
  walk(clipRoot);
  if (!frames.length) throw new Error(`footage lineage mismatch: empty frame set for ${cid}`);
  frames.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const digest = crypto.createHash('sha256');
  digest.update(Buffer.from('sizzlecraft-frame-set-v1', 'utf8'));
  digest.update(Buffer.from([0]));
  for (const frame of frames) {
    const bytes = fs.readFileSync(frame.real);
    digest.update(Buffer.from(frame.relative, 'utf8'));
    digest.update(Buffer.from([0]));
    digest.update(Buffer.from(String(bytes.length), 'ascii'));
    digest.update(Buffer.from([0]));
    digest.update(bytes);
    digest.update(Buffer.from([0]));
  }
  return { frameSetSha: digest.digest('hex'), frameCount: frames.length };
};
const VERIFIED_FOOTAGE_META = new Map();
const verifyFootageLineage = () => {
  const approved = (FOOTAGE.clips || []).filter(c => c?.approvedForUse === true);
  if (!approved.length) return;
  if (DERIVED_FOOTAGE?.kind !== 'footage-frame-set-v1' || DERIVED_FOOTAGE?.producer !== 'materialize-footage' || !Array.isArray(DERIVED_FOOTAGE.clips)) {
    throw new Error('footage lineage mismatch: approved clips require materialize-footage lineage');
  }
  const projectFps = timing.project?.fps;
  if (!Number.isSafeInteger(projectFps) || projectFps < 1) throw new Error('footage lineage mismatch: timing.project.fps must be a positive integer');
  const lineageById = new Map(DERIVED_FOOTAGE.clips.map(c => [c?.id, c]));
  if (lineageById.size !== DERIVED_FOOTAGE.clips.length) throw new Error('footage lineage mismatch: duplicate lineage clip id');
  const approvedIds = new Set(approved.map(c => c?.id));
  if (approvedIds.size !== approved.length) throw new Error('footage lineage mismatch: duplicate approved clip id');
  const projection = approved
    .slice()
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(c => {
      const cid = safeClipId(c.id), lineage = lineageById.get(cid), facts = frameSetFacts(cid);
      if (!lineage) throw new Error(`footage lineage mismatch: missing lineage clip ${cid}`);
      if (c.frameSetSha !== facts.frameSetSha || lineage.frameSetSha !== facts.frameSetSha) throw new Error(`footage lineage mismatch: frameSetSha differs for ${cid}`);
      if (!Number.isSafeInteger(c.frameCount) || c.frameCount !== facts.frameCount || lineage.frameCount !== facts.frameCount) throw new Error(`footage lineage mismatch: frameCount differs for ${cid}`);
      if (!Number.isSafeInteger(c.fps) || c.fps !== projectFps || lineage.fps !== projectFps) throw new Error(`footage lineage mismatch: fps differs for ${cid}`);
      if (lineage.redaction !== c.redaction) throw new Error(`footage lineage mismatch: redaction differs for ${cid}`);
      VERIFIED_FOOTAGE_META.set(cid, { frameCount: facts.frameCount, fps: projectFps });
      return { id: cid, frameSetSha: facts.frameSetSha, frameCount: facts.frameCount, fps: projectFps, redaction: c.redaction };
    });
  if (lineageById.size !== projection.length) throw new Error('footage lineage mismatch: lineage clip set differs');
  const projectionSha = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(projection), 'utf8')).digest('hex');
  if (DERIVED_FOOTAGE.sha256 !== projectionSha) throw new Error('footage lineage mismatch: derived projection hash differs');
};
verifyFootageLineage();
const footageMeta = id => {
  const meta = VERIFIED_FOOTAGE_META.get(safeClipId(id));
  if (!meta) throw new Error(`footage lineage mismatch: unverified playback metadata for ${String(id)}`);
  return meta;
};
// Frame dirs are attacker-influenced (timing.json) and are used to build Image.src. Canonically resolve
// them under evidence-pack first, then require containment in this clip's own subtree.
const safeFrameDir = (raw, clipId) => {
  const base = `evidence-pack/footage/${clipId}`;
  if (!raw) return base;
  try {
    const norm = safeEvidenceSrc(raw);
    const absolute = path.resolve(dir, norm);
    const clipRoot = path.resolve(EVIDENCE_ROOT, 'footage', clipId);
    const inside = path.relative(clipRoot, absolute);
    return (!inside || (!inside.startsWith(`..${path.sep}`) && inside !== '..' && !path.isAbsolute(inside))) ? norm : base;
  } catch {
    return base;
  }
};
const hasFootage = timing.segments.some(s => mode(s) === 'footage');  // mode()==='footage' already implies the clip is approved + redaction-clear
function footageLayer(seg) {
  const f = seg.visual?.footage || {}, clipId = safeClipId(f.clipId);
  const clip = footageClip(clipId);
  if (!footageApproved(clip)) {
    // Fail closed: never pull an unapproved / unredacted clip into the output. Emit an inert
    // placeholder (no frame source) so the segment falls back to synthetic content instead.
    return `<div id="${seg.id}-footage" class="footage-layer footage-blocked" data-clip="${esc(clipId)}"></div>`;
  }
  const fdir = safeFrameDir(f.frameDir, clipId);
  const fit = f.fit === 'cover' ? 'cover' : 'contain', meta = footageMeta(clipId);
  return `<div id="${seg.id}-footage" class="footage-layer" data-clip="${esc(clipId)}" data-framedir="${esc(fdir)}" data-framecount="${meta.frameCount}" data-fps="${meta.fps}" data-startms="${Number(f.startAtMs || 0)}" data-segstart="${seg.startMs}" data-segend="${seg.endMs}" style="background-size:${fit}"></div>`;
}

// ---- background choice + Azure-multicolor components -----------------------
// The user picks a BACKGROUND at intake; components then render multicolor from the
// fixed Azure/Fluent PALETTE (assigned per-component by index). Background and palette
// are decoupled — the same multicolor components read cleanly on any background, and
// text/surface vars adapt to the background's light|dark mode for AA contrast.
const PALETTE = ['#0078D4', '#00B7C3', '#8661C5', '#E3008C', '#107C10', '#F7630C'];
const ca = j => PALETTE[j % PALETTE.length];
const BACKGROUNDS = {
  white: { mode: 'light', stage: `radial-gradient(circle at 7% 6%,rgba(0,120,212,.10),transparent 30%),radial-gradient(circle at 93% 7%,rgba(227,0,140,.07),transparent 32%),radial-gradient(circle at 91% 94%,rgba(16,124,16,.07),transparent 32%),radial-gradient(circle at 9% 93%,rgba(247,99,12,.07),transparent 32%),linear-gradient(160deg,#FFFFFF,#F5F8FC)` },
  slate: { mode: 'light', stage: `linear-gradient(160deg,#EEF1F6,#DFE5EE)` },
  midnight: { mode: 'dark', stage: `radial-gradient(circle at 78% 12%,rgba(80,230,255,.16),transparent 30%),linear-gradient(135deg,#0B1020,#0c1a3a)` },
  transparent: { mode: 'light', stage: `#FFFFFF` } // MP4 has no alpha — transparent renders as white
};
const bgKey = String(timing.project?.background || timing.intake?.background || '').toLowerCase();
const bg = BACKGROUNDS[bgKey] || null;       // a chosen background (else null → legacy theme path)
const multicolor = !!bg;                      // multicolor components turn on with a chosen background
const bgVars = !bg ? '' : (bg.mode === 'light'
  ? '--color-text-primary:#201F1E;--color-text-secondary:#2B2A29;--color-card-bg:#FFFFFF;--color-card-border:rgba(0,0,0,.10);--color-accent-1:#0078D4;--color-accent-2:#00B7C3;--color-bg-primary:#FFFFFF;--color-bg-secondary:#F3F5F9'
  : '--color-text-primary:#FFFFFF;--color-text-secondary:#B7C6DE;--color-card-bg:rgba(255,255,255,.05);--color-card-border:rgba(255,255,255,.12);--color-bg-primary:#0B1020;--color-bg-secondary:#0c1a3a');

// ---- per-mode slide body -------------------------------------------------
function narrative(seg) {
  const v = seg.visual || {};
  const cards = (v.items || []).slice(0, 6).map((it, j) => {
    const accent = multicolor ? ca(j) : null;
    const cstyle = accent ? ` style="--ca:${accent};border-top:4px solid ${accent}"` : '';
    const statCls = accent ? 'stat' : 'stat gradient-text';
    return `<div id="${seg.id}-item-${j}" class="el card"${cstyle}><div class="kicker">${esc(it.label || 'Point ' + (j + 1))}</div>${it.value ? `<div class="${statCls}">${esc(it.value)}</div>` : ''}<div class="body">${esc(it.text || it.title || '')}</div></div>`;
  }).join('');
  const shots = (v.shots || (v.image ? [{ src: v.image, label: v.imageLabel }] : [])).slice(0, 4).map((s, j) => {
    const src = checkedSrc(s.src, seg.id, 'visual.shots[].src');   // aggregates via safeEvidenceSrc(s.src); null => reported below, nothing emitted
    if (!src) return '';
    return `<figure id="${seg.id}-shot-${j}" class="el shot"><img src="${esc(src)}" alt="${esc(s.label || '')}" loading="eager"/>${s.label ? `<figcaption>${esc(s.label)}</figcaption>` : ''}</figure>`;
  }).join('');
  return `${cards ? `<div class="grid">${cards}</div>` : ''}${shots ? `<div class="shots">${shots}</div>` : ''}`;
}

function diagram(seg) {
  const v = seg.visual || {}, nodes = v.nodes || [], edges = v.edges || [];
  const nodeAt = id => nodes.find(n => n.id === id) || {};
  const cx = n => Number(n.x || 0) + Number(n.w || 240) / 2, cy = n => Number(n.y || 0) + Number(n.h || 96) / 2;
  // point on node n's border along the line toward (tx,ty), with a small gap so the arrowhead clears the box
  const border = (n, tx, ty, gap = 10) => {
    const nx = Number(n.x || 0), ny = Number(n.y || 0), nw = Number(n.w || 240), nh = Number(n.h || 96);
    const px = nx + nw / 2, py = ny + nh / 2, dx = tx - px, dy = ty - py;
    if (!dx && !dy) return [px, py];
    const s = Math.min(dx ? (nw / 2 + gap) / Math.abs(dx) : Infinity, dy ? (nh / 2 + gap) / Math.abs(dy) : Infinity);
    return [px + dx * s, py + dy * s];
  };
  const nodeSvg = nodes.map((n, j) => {
    const x = Number(n.x || 0), y = Number(n.y || 0), nw = Number(n.w || 240), nh = Number(n.h || 96);
    const st = multicolor ? ` style="--ca:${ca(j)}"` : '';
    // Node label uses a wrapping HTML block (foreignObject) instead of a single SVG <text> line so long
    // labels wrap + fit INSIDE the box (no overflow past the rounded rect). See `.nodelabel` CSS.
    return `<g id="${seg.id}-node-${n.id}" class="el dnode"${st}><rect x="${x}" y="${y}" width="${nw}" height="${nh}" rx="14"/><foreignObject x="${x}" y="${y}" width="${nw}" height="${nh}"><div xmlns="http://www.w3.org/1999/xhtml" class="nodelabel">${esc(n.label || n.id || '')}</div></foreignObject></g>`;
  }).join('');
  const edgeSvg = edges.map((e, j) => {
    const a = nodeAt(e.from), b = nodeAt(e.to);
    const [ax, ay] = border(a, cx(b), cy(b)), [bx, by] = border(b, cx(a), cy(a));
    const st = multicolor ? ` style="--ce:${ca(j)}"` : '';
    const marker = multicolor ? `${seg.id}-arr-${e.id || j}` : 'arrow';
    return `<path id="${seg.id}-edge-${e.id || j}" class="el dedge"${st} d="M ${ax} ${ay} L ${bx} ${by}" marker-end="url(#${marker})"/>`;
  }).join('');
  // Edge labels are emitted AFTER the nodes so they paint on TOP (never hidden behind a box or an
  // arrowhead) and carry a stroke halo (see `.delabel` CSS) so the text stays legible over any line.
  // Each keeps its `el`/`-edgelabel-` id so the runtime reveals it together with its edge (drawEdge) —
  // previously edge labels carried `el` (visibility:hidden) but no trigger ever showed them.
  const labelSvg = edges.map((e, j) => {
    if (!e.label) return '';
    const a = nodeAt(e.from), b = nodeAt(e.to);
    const [ax, ay] = border(a, cx(b), cy(b)), [bx, by] = border(b, cx(a), cy(a));
    return `<text id="${seg.id}-edgelabel-${e.id || j}" class="el delabel" x="${(ax + bx) / 2}" y="${(ay + by) / 2 - 14}" text-anchor="middle">${esc(e.label)}</text>`;
  }).join('');
  // Wider, clearer arrowheads (was markerWidth/Height 7) so direction reads at video scale.
  const arrowDims = 'refX="8" refY="5" markerWidth="10" markerHeight="10"';
  const multiMarkers = multicolor ? edges.map((e, j) =>
    `<marker id="${seg.id}-arr-${e.id || j}" viewBox="0 0 10 10" ${arrowDims} orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${ca(j)}"/></marker>`).join('') : '';
  return `<svg class="diagram-svg" viewBox="${esc(v.viewBox || '0 0 1600 900')}" preserveAspectRatio="xMidYMid meet"><defs><marker id="arrow" viewBox="0 0 10 10" ${arrowDims} orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker>${multiMarkers}</defs>${edgeSvg}${nodeSvg}${labelSvg}</svg>`;
}

function live(seg) {
  const v = seg.visual || {}, url = v.url || 'app.localhost', shot = v.shot || v.image;
  const shotSrc = shot ? (checkedSrc(shot, seg.id, 'visual.shot') || '') : '';   // aggregates via safeEvidenceSrc(shot)
  const fields = (v.fields || []).map((f, j) =>
    `<div id="${seg.id}-field-${f.id || j}" class="el livefield" style="left:${Number(f.x || 4)}%;top:${Number(f.y || 12)}%;width:${Number(f.w || 30)}%"><span class="livelabel">${esc(f.label || '')}</span><span class="liveinput" data-text="${esc(f.text || '')}"></span></div>`).join('');
  const hotspots = (v.hotspots || []).map((hp, j) =>
    `<div id="${seg.id}-hotspot-${hp.id || j}" class="el hotspot" style="left:${Number(hp.x || 50)}%;top:${Number(hp.y || 50)}%">${esc(hp.label || '')}</div>`).join('');
  return `<div class="browser"><div class="chrome"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><div class="urlbar">${esc(url)}</div></div><div class="viewport">${shotSrc ? `<img class="liveshot" src="${esc(shotSrc)}" alt=""/>` : ''}${fields}${hotspots}<div id="${seg.id}-cursor" class="cursor"></div></div></div>`;
}

function body(seg) { const m = mode(seg); return m === 'footage' ? '' : m === 'diagram' ? diagram(seg) : m === 'live' ? live(seg) : narrative(seg); }

function slide(seg, i) {
  const v = seg.visual || {}, m = mode(seg);
  if (m === 'footage') {
    const f = v.footage || {}, ov = f.overlays || ['lowerThird', 'brandBug'];
    const lt = ov.includes('lowerThird')
      ? `<div class="safe safe-footage"><div id="${seg.id}-lt" class="el lower-third"><div id="${seg.id}-label" class="kicker">${esc(v.kicker || timing.project?.title || timing.project?.slug || 'Demo')}</div><h1 id="${seg.id}-title" class="title lt-title">${esc(v.title || seg.title || '')}</h1>${v.subtitle ? `<p id="${seg.id}-subtitle" class="subtitle lt-sub">${esc(v.subtitle)}</p>` : ''}</div></div>`
      : `<div class="safe safe-footage"><div id="${seg.id}-label" class="el kicker" style="visibility:hidden">${esc(v.title || seg.title || 'Demo')}</div></div>`;
    const bug = ov.includes('brandBug') ? `<div class="brand-bug">${esc(timing.project?.title || 'SizzleCraft')}</div>` : '';
    return `<section id="seg-${i}" class="sl ${i === 0 ? 'on' : ''}" data-mode="footage"><div class="footage-fullbleed">${footageLayer(seg)}</div>${bug}${lt}</section>`;
  }
  return `<section id="seg-${i}" class="sl ${i === 0 ? 'on' : ''}" data-mode="${m}"><div class="safe" style="--fit:1"><div id="${seg.id}-label" class="el kicker">${esc(v.kicker || timing.project?.title || timing.project?.slug || 'Demo')}</div><h1 id="${seg.id}-title" class="el title">${esc(v.title || seg.title || '')}</h1>${v.subtitle ? `<p id="${seg.id}-subtitle" class="el subtitle">${esc(v.subtitle)}</p>` : ''}<div class="stage-body ${m}">${body(seg)}</div></div></section>`;
}

// ---- triggers (segment-relative atMs -> absolute seconds) -----------------
function autoTriggers(seg) {
  const v = seg.visual || {}, m = mode(seg), dur = Math.max(1, seg.endMs - seg.startMs);
  const out = [{ atMs: 0, target: `${seg.id}-label`, action: 'rise', withSegment: true }, { atMs: 0, target: `${seg.id}-title`, action: 'rise', withSegment: true }];
  if (v.subtitle) out.push({ atMs: 450, target: `${seg.id}-subtitle`, action: 'rise' });
  if ((seg.triggers || []).some(t => t.target)) return out; // author drives the rest
  if (m === 'diagram') {
    const seq = [...(v.nodes || []).map(n => ({ target: `${seg.id}-node-${n.id}`, action: 'revealNode' })),
                 ...(v.edges || []).map((e, j) => ({ target: `${seg.id}-edge-${e.id || j}`, action: 'drawEdge' }))];
    const step = Math.min(900, (dur * 0.7) / (seq.length || 1));
    seq.forEach((t, k) => out.push({ atMs: Math.round(700 + k * step), target: t.target, action: t.action }));
    // Standard+ engagement: interactive-animation-enabled workflow by default — numbered step badges,
    // flowing edge particles, and an active-path pulse that walks the flow node-by-node so the viewer
    // follows how it works (C-17). `minimal` keeps clean reveals only. All positioned by seek (deterministic).
    const lvl = timing.project?.engagementLevel || timing.intake?.engagementLevel || 'standard';
    if (lvl !== 'minimal') {
      const base = Math.round(700 + seq.length * step) + 400;
      const particles = lvl === 'rich' ? 4 : 2;
      (v.nodes || []).forEach((n, k) => out.push({ atMs: base + k * 120, target: `${seg.id}-node-${n.id}`, action: 'stepBadge', payload: { stepIndex: k + 1 } }));
      (v.edges || []).forEach((e, j) => out.push({ atMs: base + 500 + j * 160, target: `${seg.id}-edge-${e.id || j}`, action: 'flowEdge', payload: { particles } }));
      (v.edges || []).forEach((e, j) => { const eid = `${seg.id}-edge-${e.id || j}`; out.push({ atMs: base + 500 + j * 220, target: eid, action: 'pulsePath', payload: { chain: [`${seg.id}-node-${e.from}`, eid, `${seg.id}-node-${e.to}`] } }); });
    }
  } else if (m === 'live') {
    let at = 600;
    (v.hotspots || []).forEach(hp => { out.push({ atMs: at, target: `${seg.id}-cursor`, action: 'moveCursor', payload: { toId: `${seg.id}-hotspot-${hp.id}` } }); at += 650; out.push({ atMs: at, target: `${seg.id}-hotspot-${hp.id}`, action: 'click' }); at += 500; });
    (v.fields || []).forEach(f => { out.push({ atMs: at, target: `${seg.id}-cursor`, action: 'moveCursor', payload: { toId: `${seg.id}-field-${f.id}` } }); at += 450; out.push({ atMs: at, target: `${seg.id}-field-${f.id}`, action: 'type' }); at += 900; });
  } else if (m === 'footage') {
    // Real footage plays full-bleed. Reveal the lower-third WRAPPER (it carries `.el`, so it stays
    // hidden until revealed — its title/subtitle children ride inside it). No card/shot reveals: the
    // pixels are real, so we don't composite synthetic content over them.
    if ((v.footage?.overlays || ['lowerThird', 'brandBug']).includes('lowerThird')) out.push({ atMs: 400, target: `${seg.id}-lt`, action: 'rise' });
  } else {
    // Narrative: reveal cards (visual.items) then screenshots (visual.shots). Both use `.el`
    // (visibility:hidden until revealed), so each needs a pop trigger or the panel renders blank.
    const items = (v.items || []).slice(0, 6).map((_, j) => `${seg.id}-item-${j}`);
    const shots = (v.shots || (v.image ? [1] : [])).slice(0, 4).map((_, j) => `${seg.id}-shot-${j}`);
    [...items, ...shots].forEach((target, j) => out.push({ atMs: 500 + j * 260, target, action: 'pop' }));
  }
  // Never let an auto-generated trigger land past the segment's own end: a later-firing effect would
  // run while a LATER slide is active, accumulate hidden-slide overlays, and break seek determinism/QC.
  // (Author-supplied triggers are the author's responsibility and are scheduled elsewhere.)
  const lastMs = Math.max(0, dur - 50);
  out.forEach(o => { if (o.atMs > lastMs) o.atMs = lastMs; });
  return out;
}

const segs = timing.segments.map((s, i) => ({ slide: i + 1, id: s.id, audioStart: s.startMs / 1000, audioEnd: s.endMs / 1000 }));
const trs = timing.segments.flatMap((s, i) => {
  const explicit = (s.triggers || []).filter(t => t.target).map(t => ({ atMs: Number(t.atMs || 0), target: t.target, action: t.action || 'rise', withSegment: !!(t.withSegment || t.withSlide), payload: t.payload || null }));
  return [...autoTriggers(s), ...explicit].map(t => ({ t: (s.startMs + Number(t.atMs || 0)) / 1000, s: i + 1, a: t.target, kind: t.action || 'rise', withSegment: !!t.withSegment, payload: t.payload || null }));
}).map((t, i) => ({ ...t, _i: i }))  // stable source-order index (autoTriggers then explicit, per segment) — the canonical tiebreaker below
  .sort((a, b) => (a.t - b.t) || (a.s - b.s) || (a._i - b._i));  // strict TOTAL order: triggers that clamp/collapse to the same (t, slide) keep a single deterministic order so non-commutative effects (pulsePath clears, overlays) converge to one final state under parallel-worker seeks

// ---- background themes (user-selectable preset) ---------------------------
const THEMES = {
  midnight: { label: 'Midnight (default) — deep navy + cyan glow', stage: `radial-gradient(circle at 78% 12%,rgba(80,230,255,.20),transparent 30%),linear-gradient(135deg,#0B1020,#0c1a3a)`, size: 'auto', anim: '' },
  light: { label: 'Light — clean Fluent white (dark text)', stage: `radial-gradient(circle at 80% 10%,rgba(0,120,212,.10),transparent 34%),linear-gradient(160deg,#FFFFFF,#F3F2F1)`, size: 'auto', anim: '', vars: '--color-text-primary:#1B1A19;--color-text-secondary:#323130;--color-accent-1:#0078D4;--color-accent-2:#00A4EF;--color-card-bg:rgba(0,90,158,.06);--color-card-border:rgba(0,0,0,.12);--color-bg-primary:#FFFFFF;--color-bg-secondary:#F3F2F1' },
  microsoft: { label: 'Microsoft — light with brand accents (blue + green)', stage: `radial-gradient(circle at 12% 88%,rgba(127,186,0,.10),transparent 40%),radial-gradient(circle at 85% 12%,rgba(0,164,239,.12),transparent 38%),linear-gradient(150deg,#FFFFFF,#EEF3FB)`, size: 'auto', anim: '', vars: '--color-text-primary:#201F1E;--color-text-secondary:#2B2A29;--color-accent-1:#0078D4;--color-accent-2:#7FBA00;--color-card-bg:rgba(0,120,212,.06);--color-card-border:rgba(0,0,0,.12);--color-bg-primary:#FFFFFF;--color-bg-secondary:#EEF3FB' },
  azure: { label: 'Azure — deep azure-blue gradient', stage: `linear-gradient(135deg,#0A2540,#0F4C81,#0078D4,#0A2540)`, size: '300% 300%', anim: '#stage{animation:bgAzure 20s ease infinite}@keyframes bgAzure{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}', vars: '--color-accent-1:#50E6FF;--color-accent-2:#C3F1FF' },
  aurora: { label: 'Aurora — slow-shifting indigo / teal / violet', stage: `linear-gradient(120deg,#0a0e29,#11324a,#1a1040,#0a0e29)`, size: '300% 300%', anim: '#stage{animation:bgAurora 18s ease infinite}@keyframes bgAurora{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}' },
  mesh: { label: 'Mesh — drifting multi-colour blobs', stage: `radial-gradient(40% 50% at 20% 25%,rgba(80,230,255,.22),transparent 60%),radial-gradient(45% 55% at 80% 30%,rgba(155,240,11,.16),transparent 60%),radial-gradient(50% 60% at 50% 88%,rgba(120,90,255,.20),transparent 60%),#0a0f22`, size: '180% 180%,180% 180%,180% 180%,auto', anim: '#stage{animation:bgMesh 26s ease-in-out infinite}@keyframes bgMesh{0%{background-position:0% 0%,100% 0%,50% 100%,0 0}50%{background-position:30% 25%,70% 35%,50% 70%,0 0}100%{background-position:0% 0%,100% 0%,50% 100%,0 0}}' },
  slate: { label: 'Slate — clean minimal neutral (no motion)', stage: `linear-gradient(160deg,#1b2230,#10151f)`, size: 'auto', anim: '' },
  dawn: { label: 'Dawn — warm plum + amber glow', stage: `radial-gradient(circle at 75% 15%,rgba(255,140,90,.18),transparent 35%),linear-gradient(140deg,#1a1030,#2a1430,#0d0a1e)`, size: 'auto', anim: '' }
};
const theme = THEMES[(timing.project?.theme || timing.theme || timing.intake?.theme || 'midnight')] || THEMES.midnight;

// ---- version end-card (Feature B) -----------------------------------------
// One extra brand-styled slide appended after the segments, revealed at contentMs and held through the
// trailing outro (Voice appended matching silence so the -shortest MP4 covers it). NaN/absence-guarded:
// only built when endCard.enabled AND builderVersion is a valid displayable string AND contentMs is finite.
// `validVersion` defensively rejects empty / whitespace / the literal "undefined"/"null" strings so a buggy
// upstream stamp can never surface on screen (graceful-omit — the whole end-card is dropped instead).
const bvRaw = timing.builderVersion;
const validVersion = (typeof bvRaw === 'string' && bvRaw.trim() !== '' && !['undefined','null'].includes(bvRaw.trim().toLowerCase())) ? bvRaw.trim() : null;
const endCardOn = !!(timing.endCard && timing.endCard.enabled !== false && validVersion && Number.isFinite(timing.contentMs));
const endCardIndex = timing.segments.length;                 // 0-based section index => slide number endCardIndex+1
const endCardText = endCardOn ? `${String(timing.endCard.tagline || 'Created by SizzleCraft')} ${validVersion}`.trim() : '';
// No `.el` on the children, so they are visible whenever the slide is `.on` (deterministic — no trigger
// needed). Reuses `.title` (AA-contrast: --color-text-primary adapts to the background mode) + `.safe`
// (safe-area + fitLayout), so visual-qc/a11y pass on any theme/background.
const endCardSlide = endCardOn ? `<section id="seg-${endCardIndex}" class="sl" data-mode="endcard"><div class="safe" style="--fit:1"><h1 id="endcard-title" class="title">${esc(endCardText)}</h1></div></section>` : '';

// ---- styles + runtime -----------------------------------------------------
const css = `:root{--color-bg-primary:#0B1020;--color-bg-secondary:#0c1a3a;--color-accent-1:#50E6FF;--color-accent-2:#9BF00B;--color-text-primary:#fff;--color-text-secondary:#8aa4c8;--color-card-bg:rgba(255,255,255,.04);--color-card-border:rgba(255,255,255,.10);--font-display:'Aptos Display','Segoe UI Variable Display',sans-serif;--font-body:'Aptos','Segoe UI Variable Text',sans-serif}
html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;font-family:var(--font-body);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
#stage{width:${w}px;height:${h}px;position:relative;overflow:hidden;color:var(--color-text-primary);background:${bg ? bg.stage : theme.stage};background-size:${bg ? 'auto' : theme.size}${bg ? ';' + bgVars : (theme.vars ? ';' + theme.vars : '')}}
${bg ? '' : theme.anim}
.sl{position:absolute;inset:0;visibility:hidden;opacity:0;overflow:hidden}.sl.on{visibility:visible;opacity:1}
.safe{position:absolute;left:6%;right:6%;top:6%;bottom:7%;display:grid;gap:calc(var(--fit) * 2vh);align-content:center;justify-items:center;text-align:center}
.el{visibility:hidden}.el.show{visibility:visible}
.kicker{text-transform:uppercase;letter-spacing:.12vw;font-size:calc(var(--fit) * clamp(16px,.8vw,30px));color:var(--color-accent-1)}
.title{font-family:var(--font-display);font-weight:900;font-size:calc(var(--fit) * clamp(44px,3vw,118px));line-height:1;letter-spacing:-.03vw;overflow-wrap:anywhere;max-width:88%}
.subtitle{font-weight:600;font-size:calc(var(--fit) * clamp(24px,1.2vw,52px));line-height:1.25;color:var(--color-text-secondary);overflow-wrap:anywhere;max-width:80%}
.stage-body{width:100%;display:grid;gap:calc(var(--fit) * 1.6vh);justify-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:calc(var(--fit) * 1.2vw);width:100%}
.card{background:var(--color-card-bg);border:1px solid var(--color-card-border);border-radius:.7vw;padding:calc(var(--fit) * 1.2vw);min-width:0}
.card .kicker{color:var(--ca,var(--color-accent-1))}.card .stat{color:var(--ca)}
.stat{font-family:var(--font-display);font-weight:900;font-size:calc(var(--fit) * clamp(28px,2.2vw,72px))}
.body{font-weight:500;font-size:calc(var(--fit) * clamp(18px,1vw,40px));color:var(--color-text-secondary);overflow-wrap:anywhere}
.gradient-text{background:linear-gradient(135deg,var(--color-accent-1),var(--color-accent-2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.shots{display:flex;gap:calc(var(--fit) * 1.2vw);justify-content:center;align-items:center;width:100%}
.shot{margin:0;max-width:100%}.shot img{display:block;max-width:100%;max-height:calc(var(--fit) * 52vh);width:auto;height:auto;object-fit:contain;border-radius:.6vw;border:1px solid var(--color-card-border)}
.shot figcaption{margin-top:.6vh;font-size:calc(var(--fit) * clamp(16px,.9vw,32px));color:var(--color-text-secondary)}
.diagram-svg{width:100%;max-height:calc(var(--fit) * 58vh)}
.dnode rect{fill:var(--color-card-bg);stroke:var(--ca,var(--color-accent-1));stroke-width:3}
.dnode foreignObject{overflow:hidden}
.nodelabel{width:100%;height:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;padding:6px 14px;color:var(--color-text-primary);font-family:var(--font-display);font-weight:700;font-size:22px;line-height:1.12;overflow-wrap:anywhere;word-break:break-word;hyphens:auto}
.dedge{fill:none;stroke:var(--ce,var(--color-accent-2));stroke-width:4.5;stroke-linecap:round}
.delabel{fill:var(--color-text-primary);font-size:22px;font-weight:600;paint-order:stroke;stroke:var(--color-bg-primary,#0a0f22);stroke-width:6px;stroke-linejoin:round}#arrow path{fill:var(--color-accent-2)}
/* Diagram slides top-align their title (with padding) so a tall diagram never pushes the title flush to the top edge. */
section[data-mode="diagram"] .safe{align-content:start;top:8%;gap:calc(var(--fit) * 1.4vh)}
.browser{width:100%;max-width:84%;margin:0 auto;border-radius:.9vw;overflow:hidden;background:#0d1426;border:1px solid var(--color-card-border)}
.chrome{display:flex;align-items:center;gap:.6vw;padding:.7vw 1vw;background:#0a1322}
.dot{width:.9vw;height:.9vw;border-radius:50%}.dot.r{background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
.urlbar{flex:1;background:#06101f;border-radius:.4vw;padding:.45vw 1vw;color:var(--color-text-secondary);font-size:calc(var(--fit) * clamp(16px,.95vw,34px))}
.viewport{position:relative;height:calc(var(--fit) * 54vh);background:#06101f}
.liveshot{width:100%;height:100%;object-fit:cover;object-position:top}
.livefield{position:absolute;background:rgba(6,16,31,.92);border:2px solid var(--color-accent-1);border-radius:.4vw;padding:.45vw .8vw;color:#fff;font-size:calc(var(--fit) * clamp(16px,.95vw,34px));text-align:left}
.livelabel{display:block;color:var(--color-text-secondary);font-size:.8em}.liveinput{display:inline-block;min-height:1em;border-left:2px solid var(--color-accent-1);padding-left:.2vw}
.hotspot{position:absolute;transform:translate(-50%,-50%);background:var(--color-accent-2);color:#06101f;padding:.45vw 1vw;border-radius:2vw;font-weight:700;font-size:calc(var(--fit) * clamp(16px,.95vw,34px))}
.hotspot.clicked{box-shadow:0 0 0 .5vw rgba(155,240,11,.35)}
.cursor{position:absolute;left:50%;top:50%;width:2.2vw;height:2.2vw;pointer-events:none;z-index:6;background:no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 2l16 7-6 2-2 6-8-15z' fill='white' stroke='%2306101f' stroke-width='1.2'/%3E%3C/svg%3E")}
/* --- footage (real user clip played full-bleed; frame swapped per capture frame) --- */
.footage-fullbleed{position:absolute;inset:0;background:#000;z-index:0}
.footage-layer{position:absolute;inset:0;background-position:center;background-repeat:no-repeat;background-color:#000}
.safe.safe-footage{align-content:end;justify-items:start;text-align:left;bottom:8%;top:auto;height:auto}
.lower-third{--color-bg-primary:#0B1020;background:linear-gradient(90deg,rgba(4,8,18,.72),rgba(4,8,18,.30) 70%,transparent);border-left:.4vw solid var(--color-accent-1);padding:calc(var(--fit) * 1.4vh) calc(var(--fit) * 1.6vw);border-radius:.3vw;display:grid;gap:.5vh;justify-items:start;max-width:72%;backdrop-filter:blur(2px)}
.lower-third .kicker{color:#fff;opacity:.92}
.lt-title{font-size:calc(var(--fit) * clamp(30px,2vw,66px));color:#fff;max-width:100%;text-align:left;text-shadow:0 2px 10px rgba(0,0,0,.55)}
.lt-sub{font-size:calc(var(--fit) * clamp(18px,1vw,36px));color:#e8f0ff;max-width:100%;text-align:left;text-shadow:0 1px 6px rgba(0,0,0,.5)}
.brand-bug{position:absolute;right:2.4%;top:3.2%;z-index:6;font-family:var(--font-display);font-weight:800;font-size:calc(var(--fit,1) * clamp(16px,.9vw,30px));color:#fff;opacity:.85;letter-spacing:.02vw;text-shadow:0 2px 8px rgba(0,0,0,.65)}
/* --- interactive engagement primitives (spotlight, emphasis, callout, flow, pulse, steps, progress) --- */
.fx-spot{position:absolute;border-radius:1vw;box-shadow:0 0 0 9999px rgba(4,8,18,.62);z-index:5;pointer-events:none}
.callout{position:absolute;max-width:28%;background:rgba(6,16,31,.96);border:2px solid var(--color-accent-1);border-radius:.6vw;padding:.7vw 1vw;color:#fff;font-size:calc(var(--fit) * clamp(16px,.95vw,34px));line-height:1.2;z-index:7;pointer-events:none;box-shadow:0 1vh 3vh rgba(0,0,0,.4)}
.callout::after{content:"";position:absolute;left:1.4vw;bottom:-.7vw;border:.4vw solid transparent;border-top-color:var(--color-accent-1)}
.rollover-tip{position:absolute;background:rgba(6,16,31,.96);border:2px solid var(--color-accent-2);border-radius:.4vw;padding:.4vw .8vw;color:#fff;font-size:calc(var(--fit) * clamp(14px,.85vw,30px));white-space:nowrap;z-index:7;pointer-events:none}
.stepbadge{position:absolute;transform:translate(-40%,-40%);width:2.4vw;height:2.4vw;border-radius:50%;background:var(--color-accent-1);color:#06101f;font-family:var(--font-display);font-weight:900;display:flex;align-items:center;justify-content:center;font-size:calc(var(--fit) * clamp(18px,1.1vw,40px));z-index:6}
.progress{position:absolute;left:6%;right:6%;bottom:3.2%;height:.6vh;background:rgba(255,255,255,.14);border-radius:1vw;overflow:hidden;z-index:6}
.progress > i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--color-accent-1),var(--color-accent-2))}
.flow-dot{r:7px;fill:var(--color-accent-1);offset-distance:0%;animation:flowMove 1.8s linear infinite}
@keyframes flowMove{from{offset-distance:0%}to{offset-distance:100%}}
.pulsing rect,.pulsing.dedge{animation:fxPulse 1.4s ease-in-out infinite}
@keyframes fxPulse{0%,100%{filter:drop-shadow(0 0 0 rgba(80,230,255,0))}50%{stroke-width:7;filter:drop-shadow(0 0 .6vw rgba(80,230,255,.85))}}`;

const runtime = `
const masterTimeline=gsap.timeline({paused:true});window.masterTimeline=masterTimeline;
// %%SEGMENTS_START%%
const segments=${jsonScript(segs, 2)};
// %%SEGMENTS_END%%
// %%TRIGGERS_START%%
const elementTriggers=${jsonScript(trs, 2)};
// %%TRIGGERS_END%%
const audio=document.getElementById('vo'),LINGER=2;let currentSlide=1;const fired=new Set();
function safeOverflow(safe){return safe.scrollHeight>safe.clientHeight+2||safe.scrollWidth>safe.clientWidth+2;}
window.fitLayout=function(){document.querySelectorAll('.sl').forEach(sl=>{const safe=sl.querySelector('.safe');if(!safe)return;const on=sl.classList.contains('on');sl.classList.add('on');let fit=1;safe.style.setProperty('--fit',fit);let g=0;while(g++<10&&safeOverflow(safe)){fit=Math.max(0.6,fit-0.06);safe.style.setProperty('--fit',fit);}if(!on)sl.classList.remove('on');});};
window.auditLayout=function(){const out=[];document.querySelectorAll('.sl').forEach(sl=>{const safe=sl.querySelector('.safe');if(!safe)return;const on=sl.classList.contains('on');sl.classList.add('on');if(safeOverflow(safe))out.push({id:sl.id,reason:'overflow-after-fit'});if(!on)sl.classList.remove('on');});return out;};
// Legibility guard: flags low-contrast (WCAG-AA) or too-small visible text so a "text not readable"
// regression is caught early. Advisory by default (Recorder logs it); Builder self-checks it at build.
function _lum(r,g,b){const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);}
function _rgb(s){const m=String(s).match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(',').map(x=>parseFloat(x));if(p.length>=4&&p[3]===0)return null;return [p[0],p[1],p[2]];}
function _hex(s){const m=String(s).trim().match(/^#?([0-9a-fA-F]{6})$/);if(!m)return null;const h=m[1];return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function _bgOf(el){let n=el;while(n){const c=_rgb(getComputedStyle(n).backgroundColor);if(c)return c;n=n.parentElement;}const src=el||document.getElementById('stage')||document.documentElement;const base=getComputedStyle(src).getPropertyValue('--color-bg-primary');return _hex(base)||_rgb(base)||_rgb(getComputedStyle(document.body).backgroundColor)||[11,16,32];}
window.auditLegibility=function(){const out=[];const stageH=(document.getElementById('stage')||document.body).clientHeight||1080;const minPx=Math.max(14,stageH*0.014);document.querySelectorAll('.sl.on .kicker,.sl.on .title,.sl.on .subtitle,.sl.on .body,.sl.on .label,.sl.on .value,.sl.on .text,.sl.on .lt-title,.sl.on .lt-sub,.sl.on svg text').forEach(el=>{if(!el.textContent.trim())return;const eid=el.id||el.className||el.tagName.toLowerCase();const cs=getComputedStyle(el);if(cs.visibility==='hidden'||parseFloat(cs.opacity)<0.5)return;const fg=_rgb(cs.color)||_rgb(cs.fill)||_hex(cs.fill),bg=_bgOf(el);const px=parseFloat(cs.fontSize);if(px&&px<minPx)out.push({id:eid,reason:'text-too-small',px:Math.round(px),minPx:Math.round(minPx)});if(fg&&bg){const L1=_lum(...fg),L2=_lum(...bg);const ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);const fw=cs.fontWeight==='bold'?700:(cs.fontWeight==='normal'?400:(parseInt(cs.fontWeight,10)||400));const large=px>=stageH*0.033||(fw>=600&&px>=stageH*0.026);const need=large?3.0:4.5;if(ratio<need)out.push({id:eid,reason:'low-contrast',ratio:Math.round(ratio*10)/10,need});}});return out;};
function show(el){if(el)el.classList.add('show');}
// Deterministic effect driver: GSAP flourishes must be a pure function of VIDEO time, not wall-clock, so
// seek(t)/frame capture yields the same pixels regardless of worker scheduling. Each effect tween is
// created PAUSED and registered with its trigger's absolute start time (__curT); __syncTweens(t) then
// sets every registered tween's progress from (t - t0)/duration. This is what actually makes the
// "seek-safe determinism" guarantee hold (the empty masterTimeline never drove these tweens).
const __drv=[];let __curT=0;
function __sch(tw){const t0=__curT,dur=tw.totalDuration()||0.001;tw.pause();__drv.push({tw,t0,d:dur});tw.totalProgress(Math.max(0,Math.min(1,((window.__t||0)-t0)/dur)));return tw;}
window.__syncTweens=function(t){for(const e of __drv)e.tw.totalProgress(e.d>0?Math.max(0,Math.min(1,(t-e.t0)/e.d)):1);};
function reveal(id,kind){const el=document.getElementById(id);if(!el||fired.has(id))return;fired.add(id);show(el);const p={rise:{y:'0.8vw'},pop:{scale:.82,opacity:0},left:{x:'-1.4vw'},flip:{rotateY:75,transformPerspective:900}}[kind]||{y:'0.8vw'};__sch(gsap.fromTo(el,p,{x:0,y:0,scale:1,opacity:1,rotateY:0,duration:.55,ease:'power3.out'}));}
function drawEdge(id){const el=document.getElementById(id);if(!el||fired.has(id))return;fired.add(id);show(el);const lb=document.getElementById(id.replace('-edge-','-edgelabel-'));if(lb)show(lb);try{const len=el.getTotalLength();__sch(gsap.fromTo(el,{strokeDasharray:len,strokeDashoffset:len},{strokeDashoffset:0,duration:.7,ease:'power2.inOut'}));}catch(e){}}
function moveCursor(cursorId,toId){const c=document.getElementById(cursorId),t=document.getElementById(toId);if(!c||!t)return;show(c);const vp=c.parentElement.getBoundingClientRect(),r=t.getBoundingClientRect();__sch(gsap.to(c,{left:(r.left-vp.left+r.width/2)+'px',top:(r.top-vp.top+r.height/2)+'px',duration:.6,ease:'power2.inOut'}));}
function clickAt(id){const t=document.getElementById(id);if(!t)return;show(t);t.classList.add('clicked');__sch(gsap.fromTo(t,{scale:1},{scale:.95,duration:.12,yoyo:true,repeat:1}));}
function typeInto(id,tr){const f=document.getElementById(id);if(!f)return;show(f);const inp=f.querySelector('.liveinput');if(!inp)return;const txt=inp.getAttribute('data-text')||'';const startT=tr?tr.t:0,cps=26;const k=Math.max(0,Math.min(txt.length,Math.round(((window.__t||0)-startT)*cps)));inp.textContent=txt.slice(0,k);}
// --- interactive engagement effects (create-once; guarded so per-frame seek stays deterministic) ---
const fxDone=new Set();function once(tr){const k=tr.kind+'|'+tr.a+'|'+tr.t;if(fxDone.has(k))return false;fxDone.add(k);return true;}
function fxHost(tr,id){const el=id&&document.getElementById(id);return (el&&el.closest('.sl'))||document.getElementById('seg-'+((tr.s||1)-1));}
function fxRect(id){const el=document.getElementById(id);if(!el)return null;const host=el.closest('.sl');if(!host)return null;const hb=host.getBoundingClientRect(),r=el.getBoundingClientRect();return{el,host,hb,x:r.left-hb.left,y:r.top-hb.top,w:r.width,h:r.height};}
function spotlight(id,tr){const host=fxHost(tr,id);if(!host)return;if(tr.payload&&tr.payload.release){host.querySelectorAll('.fx-spot').forEach(n=>n.remove());return;}const r=fxRect(id);if(!r)return;show(r.el);const pad=Math.min(r.w,r.h)*0.25+14,d=document.createElement('div');d.className='fx-spot';d.style.left=(r.x-pad)+'px';d.style.top=(r.y-pad)+'px';d.style.width=(r.w+2*pad)+'px';d.style.height=(r.h+2*pad)+'px';host.appendChild(d);__sch(gsap.fromTo(d,{opacity:0},{opacity:1,duration:.4}));}
function emphasize(id,tr){const el=document.getElementById(id);if(!el)return;show(el);const sc=(tr.payload&&tr.payload.scale)||1.12;__sch(gsap.fromTo(el,{scale:1},{scale:sc,duration:.5,yoyo:true,repeat:1,ease:'power2.inOut',transformOrigin:'center center'}));}
function zoomFocus(id,tr){const p=tr.payload||{},host=fxHost(tr,id),surf=host&&(host.querySelector('.viewport')||host.querySelector('.diagram-svg')||host.querySelector('.stage-body'));if(!surf)return;if(p.release){__sch(gsap.to(surf,{scale:1,x:0,y:0,duration:.6,ease:'power2.inOut'}));return;}const sc=p.scale||1.4;let ox=0,oy=0;const r=fxRect(id);if(r){const cb=surf.getBoundingClientRect(),cx=cb.left-r.hb.left+cb.width/2,cy=cb.top-r.hb.top+cb.height/2;ox=(cx-(r.x+r.w/2))*sc;oy=(cy-(r.y+r.h/2))*sc;}__sch(gsap.to(surf,{scale:sc,x:ox,y:oy,duration:.7,ease:'power2.inOut',transformOrigin:'center center'}));}
function callout(id,tr){const r=fxRect(id);if(!r)return;show(r.el);const c=document.createElement('div');c.className='callout';c.textContent=(tr.payload&&tr.payload.text)?String(tr.payload.text):'';c.style.left=Math.max(0,r.x)+'px';c.style.top=Math.max(0,r.y-16)+'px';c.style.transform='translateY(-100%)';r.host.appendChild(c);__sch(gsap.fromTo(c,{opacity:0,y:12},{opacity:1,y:0,duration:.45,ease:'power3.out'}));}
function hover(cursorId,tr){const toId=tr.payload&&tr.payload.toId;if(toId)moveCursor(cursorId,toId);const r=toId&&fxRect(toId);if(!r)return;document.querySelectorAll('.hovered').forEach(n=>n.classList.remove('hovered'));document.querySelectorAll('.rollover-tip').forEach(n=>n.remove());r.el.classList.add('hovered');if(tr.payload&&tr.payload.text){const t=document.createElement('div');t.className='rollover-tip';t.textContent=String(tr.payload.text);t.style.left=r.x+'px';t.style.top=(r.y+r.h+8)+'px';r.host.appendChild(t);__sch(gsap.fromTo(t,{opacity:0},{opacity:1,duration:.35}));}}
function flowEdge(id,tr){const path=document.getElementById(id);if(!path)return;show(path);const svg=path.closest('svg');if(!svg)return;const d=path.getAttribute('d'),n=Math.max(1,(tr.payload&&tr.payload.particles)||3),r=(tr.payload&&tr.payload.r)||7;for(let i=0;i<n;i++){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('class','flow-dot');dot.setAttribute('r',String(r));dot.style.offsetPath="path('"+d+"')";dot.style.animationDelay=(-(i*(1.8/n)))+'s';svg.appendChild(dot);}if(window.__sizzleAnim&&window.__sizzleAnim.scan)window.__sizzleAnim.scan();}
function pulsePath(tr){const chain=(tr.payload&&tr.payload.chain&&tr.payload.chain.length)?tr.payload.chain:[tr.a];const first=document.getElementById(chain[0]);const scope=(first&&first.closest('.sl'))||document;scope.querySelectorAll('.pulsing').forEach(el=>el.classList.remove('pulsing'));chain.forEach(id=>{const el=document.getElementById(id);if(el){show(el);el.classList.add('pulsing');}});if(window.__sizzleAnim&&window.__sizzleAnim.scan)window.__sizzleAnim.scan();}
function stepBadge(id,tr){const r=fxRect(id);if(!r)return;show(r.el);const b=document.createElement('div');b.className='stepbadge';b.textContent=String((tr.payload&&tr.payload.stepIndex)||'');b.style.left=r.x+'px';b.style.top=r.y+'px';r.host.appendChild(b);__sch(gsap.fromTo(b,{scale:0},{scale:1,duration:.4,ease:'back.out(2)'}));}
function progressBar(tr){const host=fxHost(tr,null);if(!host)return;let bar=host.querySelector('.progress');if(!bar){bar=document.createElement('div');bar.className='progress';const i=document.createElement('i');bar.appendChild(i);host.appendChild(bar);}const v=Math.max(0,Math.min(1,(tr.payload&&tr.payload.value!=null)?tr.payload.value:1));__sch(gsap.to(bar.querySelector('i'),{width:(v*100)+'%',duration:.5,ease:'power2.out'}));}
function apply(tr){__curT=tr.t||0;switch(tr.kind){case 'drawEdge':return drawEdge(tr.a);case 'revealNode':return reveal(tr.a,'pop');case 'moveCursor':return void(once(tr)&&moveCursor(tr.a,(tr.payload&&tr.payload.toId)||tr.a));case 'hover':case 'rollover':return void(once(tr)&&hover(tr.a,tr));case 'click':case 'clickRipple':return void(once(tr)&&clickAt(tr.a));case 'type':return typeInto(tr.a,tr);case 'spotlight':return void(once(tr)&&spotlight(tr.a,tr));case 'emphasize':return void(once(tr)&&emphasize(tr.a,tr));case 'zoomFocus':return void(once(tr)&&zoomFocus(tr.a,tr));case 'callout':return void(once(tr)&&callout(tr.a,tr));case 'flowEdge':return void(once(tr)&&flowEdge(tr.a,tr));case 'pulsePath':return void(once(tr)&&pulsePath(tr));case 'stepBadge':return void(once(tr)&&stepBadge(tr.a,tr));case 'progress':return void(once(tr)&&progressBar(tr));default:return reveal(tr.a,tr.kind);}}
const slideShowTimes=[{slide:1,showAt:0}];for(let i=0;i<segments.length-1;i++)slideShowTimes.push({slide:segments[i+1].slide,showAt:segments[i].audioEnd+LINGER});${endCardOn ? `slideShowTimes.push({slide:${endCardIndex + 1},showAt:${jsonScript(timing.contentMs / 1000)}});` : ''}
// --- footage frame injection (real user clip). Maps absolute time -> extracted frame file and swaps
// the full-bleed background. Pure index->file map so per-frame seek stays deterministic + resumable.
// Preview calls it fire-and-forget from fireTriggersUpTo; the capture script awaits it before screenshot.
window.__footage=${hasFootage};
window.__setFootageFrame=function(absMs){const ls=document.querySelectorAll('.footage-layer'),ps=[];ls.forEach(el=>{const s=+el.dataset.segstart,e=+el.dataset.segend,dir=el.dataset.framedir;if(!dir||!Number.isFinite(s)||!Number.isFinite(e))return;if(absMs<s-1||absMs>e+1)return;const fps=+el.dataset.fps||30,count=Math.max(1,+el.dataset.framecount||1),start=+el.dataset.startms||0;let idx=Math.round(((absMs-s)+start)/1000*fps)+1;idx=Math.max(1,Math.min(count,idx));const url=dir+'/frame_'+String(idx).padStart(5,'0')+'.jpg';if(el.dataset.cur===url)return;if(el.__pendingUrl===url&&el.__pendingPromise){ps.push(el.__pendingPromise);return;}const p=new Promise(res=>{const im=new Image();im.onload=()=>res(true);im.onerror=()=>res(false);im.src=url;}).then(ok=>{if(ok){el.style.backgroundImage='url("'+url+'")';el.dataset.cur=url;}if(el.__pendingUrl===url){el.__pendingUrl=null;el.__pendingPromise=null;}return ok;});el.__pendingUrl=url;el.__pendingPromise=p;ps.push(p);});return Promise.all(ps);};
function setSlide(n){if(n===currentSlide)return;document.querySelectorAll('.sl').forEach(s=>s.classList.remove('on'));document.getElementById('seg-'+(n-1))?.classList.add('on');currentSlide=n;elementTriggers.filter(t=>t.s===n&&t.withSegment).forEach(apply);}
let __lastFireT=0;
// Seek-safety: on a backwards / non-monotonic seek (preview scrub), cumulative state (fired, fxDone,
// __drv tweens) and injected overlays (.fx-spot/.callout/.rollover-tip/.stepbadge/.flow-dot/.progress)
// would otherwise persist and once()/fired would short-circuit re-creation. Reset them, then re-apply
// triggers up to the new time so the frame is reconstructed deterministically from scratch.
function __resetSeekState(){fired.clear();fxDone.clear();for(const e of __drv){try{e.tw.kill();}catch(_){}}__drv.length=0;document.querySelectorAll('.fx-spot,.callout,.rollover-tip,.stepbadge,.flow-dot,.progress').forEach(n=>n.remove());document.querySelectorAll('.show,.clicked,.hovered,.pulsing').forEach(el=>el.classList.remove('show','clicked','hovered','pulsing'));try{gsap.set('*',{clearProps:'transform,opacity'});}catch(_){}currentSlide=0;}
function fireTriggersUpTo(time){if(time<__lastFireT-0.0005)__resetSeekState();__lastFireT=time;window.__t=time;let target=1;for(const s of slideShowTimes)if(time>=s.showAt)target=s.slide;setSlide(target);for(const tr of elementTriggers)if(time>=tr.t)apply(tr);window.__syncTweens(time);if(window.__footage)window.__setFootageFrame(time*1000);}
window.fireTriggersUpTo=fireTriggersUpTo;
// Deterministic per-frame visual-state signature for capture-time dedup (dedupHolds). Two frames are
// pixel-identical iff their computed visual state is identical; __frameSig(frameNo) serialises EVERY
// source of per-frame pixel change so the recorder may hardlink (reuse) a settled frame ONLY when the
// signature is unchanged. CORRECTNESS INVARIANT: any omitted pixel source => false dedup => corruption.
// MOTION GUARD: if anything is mid-motion at this instant (an active GSAP tween, a live t-dependent CSS
// animation — themes/flow-dots/pulses are captured PAUSED with a rewritten animation-delay, so we test
// applicability via animationName, NOT play-state — or any animated raster/SMIL media that advances on
// the browser clock), we return a frame-unique token so those frames are NEVER deduped. Only fully
// settled, no-motion spans (static themes, no active tween, no animated media) can be held.
function __sigVis(el){if(!el)return false;const cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none'||parseFloat(cs.opacity)===0)return false;return el.getClientRects().length>0;}
function __sigActiveTween(){for(const e of __drv){const p=e.d>0?((window.__t||0)-e.t0)/e.d:1;if(p>0.0001&&p<0.9999)return true;}return false;}
function __sigLiveCssAnim(){if(!window.__sizzleAnim||!window.__sizzleAnim.els)return false;for(const el of window.__sizzleAnim.els()){if(getComputedStyle(el).animationName!=='none'&&__sigVis(el))return true;}return false;}
function __sigLiveMedia(){for(const im of document.querySelectorAll('.sl.on img')){if(!__sigVis(im))continue;const s=(im.currentSrc||im.src||'').split('?')[0].split('#')[0].toLowerCase();if(/\\.(gif|apng|webp|svg)$/.test(s))return true;}for(const a of document.querySelectorAll('.sl.on animate,.sl.on animateTransform,.sl.on animateMotion,.sl.on set')){if(__sigVis(a.ownerSVGElement||a))return true;}return false;}
window.__frameSig=function(frameNo){
  if(__sigActiveTween()||__sigLiveCssAnim()||__sigLiveMedia())return 'm'+frameNo; // in-motion: never hold
  const p=[],on=document.querySelector('.sl.on');
  p.push('S'+(on?on.id:'-')); // on-screen slide identity (covers inter-segment flips + end-card)
  const ids=sel=>Array.from(document.querySelectorAll(sel)).map((el,i)=>el.id||('#'+i)).sort().join(',');
  p.push('V'+ids('.show')); // every revealed/shown element (reveal/drawEdge + effect-shown elements)
  p.push('C'+ids('.clicked')+'|'+ids('.hovered')+'|'+ids('.pulsing')); // discrete stateful classes
  const ov=[];document.querySelectorAll('.fx-spot,.callout,.rollover-tip,.stepbadge,.flow-dot,.progress').forEach(n=>ov.push(n.className+':'+(n.textContent||'')+':'+(n.style.left||'')+','+(n.style.top||'')+','+(n.style.width||'')+','+(n.style.height||'')+','+(n.style.transform||'')+','+(n.style.opacity||'')));
  const pw=[];document.querySelectorAll('.progress i').forEach(i=>pw.push(i.style.width||''));
  p.push('O'+ov.sort().join(';')+'|'+pw.join(',')); // dynamic overlays: EVERY inline pixel-affecting prop
  // (left/top/width/height/transform/opacity) + text/progress. .fx-spot settles style.height, callout
  // settles style.transform, and GSAP writes inline transform/opacity — all must be in the tuple or two
  // settled frames differing only by one could collide and be wrongly held (C-19 violation).
  const ty=[];document.querySelectorAll('.liveinput').forEach(inp=>{if(inp.textContent)ty.push((inp.id||inp.getAttribute('data-text')||'')+'#'+inp.textContent.length);});
  p.push('T'+ty.sort().join(',')); // typed text (advances per-frame; NOT a tween, so must be explicit)
  // Footage: derive the index DETERMINISTICALLY from window.__t using the SAME math as
  // __setFootageFrame — NOT el.dataset.cur, which is committed asynchronously (after image load) and
  // therefore lags the frame about to be screenshotted by one frame. Reading dataset.cur here would
  // make the sig describe the PREVIOUS footage frame, causing a false dedup on footage segments (e.g.
  // a lower-fps clip whose index repeats then advances) and violating the C-19 equivalence invariant.
  // For layers outside their active window (index not changing this frame) dataset.cur is stable, so
  // it is read directly with no lag.
  const ft=[],__absMs=(window.__t||0)*1000;
  document.querySelectorAll('.footage-layer').forEach(el=>{const s=+el.dataset.segstart,e=+el.dataset.segend,dir=el.dataset.framedir;if(dir&&Number.isFinite(s)&&Number.isFinite(e)&&__absMs>=s-1&&__absMs<=e+1){const fps=+el.dataset.fps||30,count=Math.max(1,+el.dataset.framecount||1),start=+el.dataset.startms||0;let idx=Math.round(((__absMs-s)+start)/1000*fps)+1;idx=Math.max(1,Math.min(count,idx));ft.push(dir+'/frame_'+String(idx).padStart(5,'0')+'.jpg');}else ft.push(el.dataset.cur||'-');});
  p.push('G'+ft.join(',')); // footage frame that WILL be shown per layer (deterministic in t)
  const safe=on&&on.querySelector('.safe');p.push('L'+(safe?(safe.style.getPropertyValue('--fit')||'1'):'1')); // layout fit
  return p.join('~');
};
function tick(){fireTriggersUpTo(audio.currentTime);if(!window.__done)requestAnimationFrame(tick);}
window.startPlayback=async()=>{window.fitLayout();window.__done=false;fireTriggersUpTo(0);await audio.play();requestAnimationFrame(tick);};
audio.addEventListener('ended',()=>setTimeout(()=>{window.__done=true},3000));
function refit(){try{window.fitLayout();}catch(e){}}
refit();window.addEventListener('load',refit);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(refit);
Promise.all([...document.images].map(im=>im.complete?0:new Promise(r=>{im.addEventListener('load',r);im.addEventListener('error',r);}))).then(refit);
elementTriggers.filter(t=>t.s===1&&t.withSegment).forEach(apply);`;

// Inline GSAP from the local install so video-auto.html runs fully offline (C-8) — no CDN, no network, no external supply chain.
const gsapPath = path.join(dir, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
if (!fs.existsSync(gsapPath)) {
  console.error(
    `error: gsap not installed locally at ${gsapPath} — run \`npm install gsap\` in ${dir} ` +
      `(a local-first render must not depend on a CDN)`,
  );
  process.exit(EXIT.USAGE);
}
const gsapInline = `<script>${fs.readFileSync(gsapPath, 'utf8')}</script>`;
// Materialize EVERY slide first. narrative()/live() call checkedSrc(), so asserting before this map
// would inspect an empty srcErrors list and silently omit unsafe imagery from the final HTML.
const slideHtml = timing.segments.map(slide).join('');
assertNoSrcErrors();   // every invalid evidence source, named by segment id, reported in ONE error
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${w},height=${h},initial-scale=1">${gsapInline}<style>${css}</style></head><body><div id="stage">${slideHtml}${endCardSlide}<audio id="vo" preload="auto" src="voiceover.mp3"></audio></div><script>${runtime}</script></body></html>`;
const outPath = guard(() => resolveOutput(dir, cli.values.out ?? 'video-auto.html', { apply: cli.apply, replace: cli.replace, label: 'output' }));
if (!cli.apply) {
  console.log(`plan: build the scene for ${timing.segments?.length ?? 0} segment(s)`);
  console.log(`  source ${path.join(dir, 'timing.json')}`);
  console.log(`  output ${outPath} — ${describeWrite(outPath, cli.replace)}`);
  console.log(`  size   ${html.length} bytes of generated HTML`);
  planFooter();
  process.exit(EXIT.OK);
}
fs.writeFileSync(outPath, html);
console.log('wrote video-auto.html (' + timing.segments.length + ' segments)');
