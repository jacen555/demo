import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const projectDir = process.cwd();
const timing = JSON.parse(fs.readFileSync(path.join(projectDir, 'timing.json'), 'utf8'));
const fps = Number(timing.project?.fps || process.env.SIZZLECRAFT_FPS || 30);
const width = Number(timing.project?.width || 3840);
const height = Number(timing.project?.height || 2160);
// Derive the total duration with nullish-coalescing (not `||`) so a present-but-invalid value like
// timing.durationMs=0 is NOT silently replaced by a segment-derived fallback, and an empty/missing
// `segments` array can never yield -Infinity/NaN. Validate up front so malformed timing fails fast
// here with an actionable error instead of producing totalFrames=NaN and confusing downstream errors.
// Per-segment end timestamp: prefer the authored `endMs`; otherwise derive it from
// `startMs + audio.durationMs` (the only measured-duration field that exists — there is no
// `audio.endMs`). Segments that supply neither contribute 0 and are caught by the validation below.
const segEndMs = (timing.segments || []).map(s => {
  if (Number.isFinite(Number(s.endMs))) return Number(s.endMs);
  const start = Number(s.startMs), dur = Number(s.audio?.durationMs);
  return Number.isFinite(start) && Number.isFinite(dur) ? start + dur : 0;
});
const segMaxEndMs = segEndMs.length ? Math.max(...segEndMs) : 0;
const durationMs = Number(timing.durationMs ?? timing.totalDurationMs ?? segMaxEndMs);
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(`invalid timing duration (${durationMs}) — set a positive timing.durationMs / totalDurationMs, or provide segments with a positive endMs`);
}
const totalFrames = Math.ceil(((durationMs + 1000) / 1000) * fps);
const frameDir = path.join(projectDir, 'frames');

// Mode-aware frame format: draft=jpeg (fast/small), live=png (fidelity). Env overrides.
// Only jpeg (jpg) and png are supported (Playwright screenshot type + the WebCodecs encoder path,
// see references/ffmpeg-free-encoder.md) — validate up front so an unexpected value fails fast here
// instead of as a confusing per-frame screenshot error deep in the capture loop.
const fmtRaw = (process.env.SIZZLECRAFT_FRAME_FORMAT || timing.project?.frameFormat || 'png').toLowerCase();
const frameFormat = fmtRaw === 'jpg' ? 'jpeg' : fmtRaw;
if (frameFormat !== 'jpeg' && frameFormat !== 'png') {
  throw new Error(`unsupported frame format "${fmtRaw}" — only "jpeg" (or "jpg") and "png" are supported (see references/ffmpeg-free-encoder.md)`);
}
const jpegQuality = Number(process.env.SIZZLECRAFT_JPEG_QUALITY || timing.project?.jpegQuality || 88);
const ext = frameFormat === 'jpeg' ? 'jpg' : frameFormat;
// Performance / reliability knobs (env override config.yaml render.capture.*).
// Capture is CPU-bound and embarrassingly parallel, so default the worker count to the machine's core
// count (leaving one core for the OS/main process) instead of a fixed 4 — this is the single biggest
// safe speedup for long/high-res renders and has zero effect on output determinism. High-res frames
// (>1080p, e.g. 4K) are memory-heavy, so cap those to 6 pages to avoid OOM; ≤1080p uses all-but-one core.
// `SIZZLECRAFT_WORKERS` overrides explicitly; a non-numeric/unset value (e.g. "auto") falls back to autoWorkers.
const cpuCount = (os.availableParallelism?.() ?? os.cpus().length) || 4;
const heavyFrames = width * height > 1920 * 1080;
const autoWorkers = Math.max(1, Math.min(cpuCount - 1, heavyFrames ? 6 : cpuCount));
const workersEnv = Number(process.env.SIZZLECRAFT_WORKERS);
const workers = Math.max(1, Number.isFinite(workersEnv) && workersEnv > 0 ? workersEnv : autoWorkers);
const resume = /^(1|true|yes)$/i.test(String(process.env.SIZZLECRAFT_RESUME || ''));
// dedupHolds (render.capture.dedupHolds, default on): during capture, a fully-settled frame whose
// deterministic visual signature (window.__frameSig) equals the previous captured frame is not
// re-screenshotted — it is materialised as a hardlink (copy fallback) to that identical prior frame.
// This makes render cost track visual change: static/minimal content auto-fast-lanes; animated
// content (active tween / live CSS animation / animated media) is never held (motion guard in
// __frameSig). SIZZLECRAFT_NO_DEDUP=1 forces a full capture (equivalence mode) — the decoded frame
// stream MUST be identical to a dedup-on run. dedupHolds is intra-slice only (state resets per worker).
const dedupHolds = !/^(1|true|yes)$/i.test(String(process.env.SIZZLECRAFT_NO_DEDUP || ''))
  && (process.env.SIZZLECRAFT_DEDUP_HOLDS === undefined || /^(1|true|yes)$/i.test(String(process.env.SIZZLECRAFT_DEDUP_HOLDS)));
// Sparse layout audit runs only at frame 0 + each segment start (not every frame).
const auditFrames = new Set([0]);
let _acc = 0;
for (const s of (timing.segments || [])) { auditFrames.add(Math.round((s.startMs ?? _acc) / 1000 * fps)); _acc = s.endMs ?? _acc; }
const frameName = (n) => `frame_${String(n).padStart(5, '0')}.${ext}`;

// --- Single-writer capture lock. Two concurrent captures racing on the same
// frames dir corrupt the sequence; a heal loop must never assume a producer is
// alive just because frames exist. The lock owner is a live PID; a stale lock
// (dead owner) is taken over. If another live capture owns it, we exit cleanly.
const lockPath = path.join(projectDir, 'frames.lock');
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
(function acquireLock() {
  while (true) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (!owner || !pidAlive(owner)) { fs.rmSync(lockPath, { force: true }); continue; }
      console.log(`capture already running (pid ${owner}); exiting`);
      process.exit(0);
    }
  }
})();
process.on('exit', () => { try { fs.rmSync(lockPath, { force: true }); } catch {} });

// Resume keeps already-written frames (recover from an interrupted run); otherwise start clean.
// Resume is only honoured when the capture inputs are unchanged: a fingerprint of video-auto.html +
// all frame parameters is stored in frames/.capture-meta.json. If it is missing or mismatched (the
// HTML, fps, resolution, format or quality changed), kept frames would be stale — so we wipe and do a
// full capture. This closes the "resume trusts a frame produced by a different input" determinism hole.
const metaPath = path.join(frameDir, '.capture-meta.json');
const htmlPath = path.join(projectDir, 'video-auto.html');
// video-auto.html is a hard prerequisite for capture — without it every frame's page.goto fails.
// Fail fast here with an actionable message instead of writing a fingerprint with an empty htmlHash
// (which could never be a valid resume basis) and surfacing a confusing goto error deep in the loop.
if (!fs.existsSync(htmlPath)) {
  throw new Error(`video-auto.html not found in ${projectDir} — run the build-html step before frame capture`);
}
function captureFingerprint() {
  const htmlHash = crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('hex');
  return { htmlHash, fps, width, height, frameFormat, jpegQuality, totalFrames, v: 1 };
}
const fingerprint = captureFingerprint();
let effectiveResume = resume;
if (resume) {
  fs.mkdirSync(frameDir, { recursive: true });
  let ok = false;
  try { ok = JSON.stringify(JSON.parse(fs.readFileSync(metaPath, 'utf8'))) === JSON.stringify(fingerprint); } catch { ok = false; }
  if (!ok) {
    console.log('resume requested but capture inputs changed (or no fingerprint) — discarding stale frames and capturing fresh');
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
    effectiveResume = false;
  }
} else {
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
}
fs.writeFileSync(metaPath, JSON.stringify(fingerprint));

// Materialise a held (deduped) frame as a hardlink to the identical prior frame — falls back to a copy
// on filesystems / cross-device layouts without hardlinks. Written via a unique temp name + atomic
// rename so (a) a crash never leaves a truncated frame a later resume would trust, and (b) we NEVER
// write in place over an existing (possibly hardlinked, shared-inode) path — rename replaces the dir
// entry without mutating the shared inode, so held frames can never be corrupted.
function linkOrCopy(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try { fs.linkSync(src, tmp); }
  catch { fs.copyFileSync(src, tmp); }
  fs.renameSync(tmp, dest);
}

// One-time in-page setup: cache the set of elements that ever carry a CSS animation, so per-frame
// work only re-stamps that small set instead of walking the whole DOM on every frame.
const PAGE_INIT = `
window.__sizzleAnim = (() => {
  const set = new Set();
  const scan = () => { document.querySelectorAll('*').forEach(el => {
    const st = getComputedStyle(el);
    if (st.animationName && st.animationName !== 'none') set.add(el);
  }); };
  return { scan, els: () => Array.from(set) };
})();
window.__sizzleAnim.scan();
`;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    // Perf/determinism launch flags. The page is driven entirely by explicit seek() calls (no
    // wall-clock), so disabling background throttling only removes latency, never changes pixels;
    // hiding scrollbars removes any residual gutter. NOTE: font-hinting/lcd-text flags are
    // deliberately NOT set here — they change text rasterization and would require re-approving a
    // storyboard frame.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--hide-scrollbars',
  ],
});

async function makePage() {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(projectDir, 'video-auto.html')).toString(), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(() => window.fitLayout?.());
  // Stage-vs-viewport guard: #stage MUST match the capture viewport. A mismatch
  // (e.g. an HTML built at 4K captured in a 1080p viewport) silently centers
  // content off-frame and clips it — auditLayout() can't catch it because the
  // safe area still fits the oversized stage. Fail fast, never ship a cut render.
  const stageFit = await page.evaluate(() => {
    const s = document.getElementById('stage');
    if (!s) return { ok: true };
    return { ok: Math.abs(s.clientWidth - window.innerWidth) <= 2 && Math.abs(s.clientHeight - window.innerHeight) <= 2,
             stageW: s.clientWidth, stageH: s.clientHeight, vw: window.innerWidth, vh: window.innerHeight };
  });
  if (!stageFit.ok) throw new Error(`stage/viewport mismatch — #stage is ${stageFit.stageW}x${stageFit.stageH} but viewport is ${stageFit.vw}x${stageFit.vh}; rebuild video-auto.html so timing.project width/height match the capture resolution`);
  await page.evaluate(PAGE_INIT);
  return page;
}

let done = 0;
// Progress bar + live ETA (frame-based; capture is the dominant cost). TTY draws a single \r bar
// throttled to ~7/s; when piped/logged (non-TTY) it prints only at 10% milestones so it never floods
// a Tee'd render log. Safe under parallel workers — all increment the shared `done`.
const captureStart = Date.now();
const isTTY = !!process.stdout.isTTY;
let _lastDraw = 0, _lastBucket = -1;
const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
function reportProgress(n, total) {
  const frac = total > 0 ? n / total : 1, pct = Math.round(frac * 100);
  const elapsed = Date.now() - captureStart, eta = n > 0 ? elapsed * (total - n) / n : 0;
  const w = 24, filled = Math.round(frac * w);
  const line = `capture [${'\u2588'.repeat(filled)}${'\u2591'.repeat(w - filled)}] ${pct}% ${n}/${total} ETA ${fmtDur(eta)} elapsed ${fmtDur(elapsed)}`;
  if (isTTY) { const now = Date.now(); if (now - _lastDraw < 140 && n !== total) return; _lastDraw = now; process.stdout.write('\r' + line + (n === total ? '\n' : '')); }
  else { const b = Math.floor(pct / 10); if (b > _lastBucket || n === total) { _lastBucket = b; console.log(line); } }
}
let held = 0;
// Returns the deterministic visual signature of the frame. Always runs seek + footage + (on audit
// frames) the layout/legibility gates BEFORE deciding whether to write. When skipWrite is true (a
// resumed frame already exists on disk) it audits without touching the file. Otherwise it either
// hardlinks a settled unchanged frame (dedupHolds) or screenshots it, updating the per-slice `state`.
async function captureFrame(page, frameNo, state, skipWrite = false) {
  const t = frameNo / fps;
  const isAudit = auditFrames.has(frameNo);
  const { sig } = await page.evaluate(([seconds, rescan, fno]) => {
    if (window.masterTimeline) { window.masterTimeline.seek(seconds).pause(); }
    window.fireTriggersUpTo?.(seconds);
    if (rescan) window.__sizzleAnim.scan(); // sparse re-scan catches trigger-added animations
    for (const el of window.__sizzleAnim.els()) {
      const st = getComputedStyle(el);
      if (st.animationName && st.animationName !== 'none') {
        // Cache each element's ORIGINAL animation-delay once (before we override it) so per-element
        // phase offsets survive — e.g. flowEdge staggers its `.flow-dot` particles via negative delays;
        // freezing at `baseDelay - seconds` keeps that stagger instead of collapsing them to one phase.
        if (el.__baseDelay === undefined) el.__baseDelay = (parseFloat(st.animationDelay) || 0);
        el.style.animationPlayState = 'paused';
        el.style.animationDelay = (el.__baseDelay - seconds) + 's';
      }
    }
    // NOTE: GSAP flourishes are driven deterministically by video time — fireTriggersUpTo() calls
    // window.__syncTweens(seconds), which sets every registered (paused) tween's progress to
    // (seconds - triggerStart)/duration. A cold worker-slice start therefore converges to the exact same
    // state as a warm 0→t progression with no extra work — no wall-clock settling hack is needed.
    // Compute the visual signature on the SAME round-trip, AFTER seek+trigger+freeze, so it reflects the
    // exact pixels about to be captured (no extra page.evaluate).
    return { sig: (window.__frameSig ? window.__frameSig(fno) : 'f' + fno) };
  }, [t, isAudit, frameNo]);

  // Real footage segments: swap the full-bleed background to the extracted clip frame matching this
  // timestamp and AWAIT its decode before screenshotting. fireTriggersUpTo() also fires this, but does
  // not await; awaiting here keeps capture deterministic (no half-loaded frame). No-op on synthetic runs.
  // FAIL FAST on a bad evidence pack: __setFootageFrame resolves per-layer load booleans; if any awaited
  // load reports false (missing/corrupt extracted frame) the layer would silently keep the PREVIOUS
  // background (or blank) and dedup/encode would produce a wrong-but-plausible render. Abort instead so
  // bad footage is caught deterministically rather than shipped.
  const footageLoads = await page.evaluate(seconds => (window.__footage && window.__setFootageFrame) ? window.__setFootageFrame(seconds * 1000) : null, t);
  if (Array.isArray(footageLoads) && footageLoads.some(ok => ok === false)) {
    const bad = footageLoads.filter(ok => ok === false).length;
    throw new Error(`footage frame load failed at ${t.toFixed(3)}s — ${bad} layer(s) reported a missing/corrupt extracted frame; aborting to avoid a wrong-but-plausible render.`);
  }

  // Audit ALWAYS runs (after seek+footage) BEFORE any dedup/skip decision, so the layout/legibility
  // gate is never bypassed — including on resume (skipWrite) and for held frames.
  if (isAudit) {
    const issues = await page.evaluate(() => window.auditLayout?.() || []);
    if (issues.length) throw new Error(`layout audit failed at ${t}s: ${JSON.stringify(issues)}`);
    const legib = await page.evaluate(() => window.auditLegibility?.() || []);
    if (legib.length) console.log(`[legibility] advisories at ${t.toFixed(1)}s: ${JSON.stringify(legib)}`);
  }

  if (skipWrite) return sig; // resumed frame already on disk — audited, not rewritten

  const outFile = path.join(frameDir, frameName(frameNo));
  // dedupHolds: a settled, non-audit frame whose signature equals the previous CAPTURED frame is
  // identical by construction — reuse that frame (hardlink/copy) instead of re-screenshotting. Audit
  // frames (segment starts) are never held. Motion-guarded frames get a frame-unique sig so they never
  // match. state.prevFile always points to a real screenshot (never advanced on a hold), so a run of
  // held frames all link to the one captured source.
  if (dedupHolds && !isAudit && state.prevFile && sig === state.prevSig) {
    linkOrCopy(state.prevFile, outFile);
    held++;
  } else {
    // Atomic write: screenshot to a unique temp then rename (see linkOrCopy rationale).
    const tmp = `${outFile}.tmp-${process.pid}-${frameNo}`;
    const opts = { path: tmp, type: frameFormat };
    if (frameFormat === 'jpeg') opts.quality = jpegQuality;
    await page.screenshot(opts);
    fs.renameSync(tmp, outFile);
    state.prevSig = sig; state.prevFile = outFile;
  }
  return sig;
}

// Frames within a slice progress sequentially on one page. Every frame is a pure seek — GSAP tweens
// are re-positioned by video time via __syncTweens — so any frame (cold slice start or warm) is
// deterministic. We still snap worker-slice boundaries to segment starts for clean audit boundaries.
try {
  // Snap each worker's cut to the nearest segment-start frame so every slice begins at a stable
  // segment boundary (auditLayout runs there). Fewer usable cut points than workers just means fewer
  // (still-correct) slices — we favour clean boundaries over max parallelism.
  const segStarts = [...new Set((timing.segments || [])
    .map(s => Math.round((s.startMs || 0) / 1000 * fps))
    .filter(f => f > 0 && f < totalFrames))].sort((a, b) => a - b);
  const cuts = [];
  for (let w = 1; w < workers && segStarts.length; w++) {
    const ideal = Math.round((w * totalFrames) / workers);
    let best = segStarts[0];
    for (const f of segStarts) if (Math.abs(f - ideal) < Math.abs(best - ideal)) best = f;
    if (!cuts.includes(best)) cuts.push(best);
  }
  const bounds = [0, ...cuts.sort((a, b) => a - b), totalFrames];
  const ranges = [];
  for (let i = 0; i < bounds.length - 1; i++) if (bounds[i] < bounds[i + 1]) ranges.push([bounds[i], bounds[i + 1]]);
  console.log(`capturing ${totalFrames} frames @ ${fps}fps ${width}x${height} ${frameFormat}${frameFormat === 'jpeg' ? ' q' + jpegQuality : ''} across ${ranges.length} worker(s)${resume ? ' [resume]' : ''}`);
  await Promise.all(ranges.map(async ([start, end]) => {
    const page = await makePage();
    const state = { prevSig: null, prevFile: null }; // per-slice dedup state — holds are intra-slice only
    try {
      for (let f = start; f < end; f++) {
        const outFile = path.join(frameDir, frameName(f));
        if (effectiveResume && fs.existsSync(outFile)) {
          // Resumed frame already on disk. Segment-start frames still re-run seek+audit (never bypass
          // the gate); other frames are kept as-is. Reset dedup state so the next captured frame is
          // screenshotted fresh (we don't know a kept non-audit frame's signature without re-seeking).
          if (auditFrames.has(f)) { const sig = await captureFrame(page, f, state, true); state.prevSig = sig; state.prevFile = outFile; }
          else { state.prevSig = null; state.prevFile = null; }
          reportProgress(++done, totalFrames);
          continue;
        }
        await captureFrame(page, f, state);
        reportProgress(++done, totalFrames);
      }
    } finally { await page.close(); }
  }));
  reportProgress(totalFrames, totalFrames); // guarantee a clean 100% close (e.g. full-resume runs)
} finally {
  await browser.close();
}

const captured = totalFrames - held;
console.log(`wrote ${totalFrames} frames to ${frameDir}` +
  (dedupHolds ? ` (${captured} captured, ${held} held/${totalFrames} = ${Math.round(held / Math.max(1, totalFrames) * 100)}% deduped)` : ' (dedup off)'));
// Record dedup stats for the manifest/auditability.
try { fs.writeFileSync(path.join(frameDir, '.dedup-stats.json'), JSON.stringify({ total: totalFrames, captured, held, dedupHolds })); } catch {}
