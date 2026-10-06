import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, requireSafeFilename, resolveWithinRoot, resolveOutput, resolveEngineOutput, assertDistinctDestinations, pathExists, planFooter, fingerprintBuffer } from './cli-support.mjs';
// ONE STATEMENT OF WHAT A FINGERPRINT IS, and it now lives beside the other shared rules
// rather than in an audio module whose doc said "audio". A CONSUMERS line there enumerates
// every importer, and a test holds that list to the truth.

// The coach pack reads this by name, so it is part of the contract, not a detail.
const RECORD_NAME = 'preview-record.json';

const USAGE = `
preview — screenshot each segment late in its window, and audit the layout.

  node preview.mjs                         plan only (default)
  node preview.mjs --apply                 write preview/*.png for every segment
  node preview.mjs --apply --id flywheel --id explorer   just these segments

Options
  --id <segment>    segment to preview; repeatable (default: every segment)
  --out <dir>       output directory (default: preview)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write screenshots. Without it nothing is written.
  --replace         permit overwriting existing screenshots
  --help            show this message

A non-empty layout audit is a FAILURE (exit 1), matching frame-capture — the two stages
must agree about whether the same condition is fatal.

Exit codes: 0 success/plan · 1 layout issues found or preview failed · 2 bad usage
`.trimStart();

await runCli(async () => {
  const { values, projectDir, apply, replace } = parseCli({
    usage: USAGE,
    options: { id: { type: 'string', multiple: true, default: [] }, out: { type: 'string' } },
  });

  const t = JSON.parse(fs.readFileSync(requireExistingFile(projectDir, 'timing.json', 'timing file'), 'utf8'));
  const W = t.project.width, H = t.project.height;

  const known = new Set(t.segments.map((s) => s.id));
  const unknown = values.id.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new CliError(
      `unknown segment id(s): ${unknown.join(', ')}\navailable: ${[...known].join(', ')}`,
    );
  }
  const picks = values.id.length ? values.id : t.segments.map((s) => s.id);

  // CHECKED HERE, BEFORE ANY SHOT IS TAKEN. `contentMs` decides where the end card sits;
  // absent or non-numeric it seeked to NaN and screenshotted whatever was on screen, at
  // exit 0. Validating it after the segment shots left partial output behind, and the
  // retry was then blocked by the files the failed run had just written — the refusal
  // making itself harder to act on. make-music resolves its record path up front for the
  // same reason: a refusal should cost nothing.
  //
  // NOT `Number(t.contentMs)`. `Number(null)` and `Number('')` are both ZERO, so a guard
  // built on it accepts them and seeks to 1.2s — the opening frame, labelled as the end
  // card. A numeric string is refused as `hopMs` refuses "20": the type is part of the
  // contract, and coercion is how a wrong value becomes a plausible one.
  const { contentMs } = t;
  if (typeof contentMs !== 'number' || !Number.isFinite(contentMs) || contentMs < 0) {
    throw new CliError(
      `timing.contentMs is ${contentMs === undefined ? 'absent' : JSON.stringify(contentMs)} — it must be a ` +
        'non-negative number of milliseconds. The end card sits 1.2s after the content ends, so without one ' +
        'there is no time to seek to and the shot would show whatever was last on screen.',
    );
  }

  // A segment id comes from timing.json and is interpolated into an output filename.
  // timing.json is authored input, not trusted input — validate before it becomes a path.
  for (const id of picks) requireSafeFilename(id, 'segment id');

  const outDir = resolveWithinRoot(projectDir, values.out ?? 'preview', 'output directory');
  // The boundary must be applied to the path actually WRITTEN, not just to its directory:
  // `preview/one.png` can itself be a link pointing outside the project, and screenshotting
  // "into preview/" then follows it. resolveOutput returns the canonical target.
  const shotPath = (name) =>
    resolveOutput(projectDir, path.join(outDir, `${requireSafeFilename(name, 'screenshot name')}.png`), {
      apply,
      replace,
      label: `screenshot "${name}"`,
    });

  // Two valid ids can produce one file — a segment legitimately named `endcard` collides
  // with the end-card shot, and the second screenshot silently replaced the first without
  // --replace ever being consulted. Distinctness is a property of the SET, so no per-path
  // check can see it.
  const destinations = [...picks, 'endcard'].map((name) => ({ key: name, path: shotPath(name) }));
  assertDistinctDestinations(destinations, 'screenshot');
  const shotFor = new Map(destinations.map((d) => [d.key, d.path]));

  // Nobody names the record, so a link planted at it is REFUSED rather than followed —
  // the same rule every engine-chosen output in this codebase follows. Resolved HERE,
  // before a single shot is taken: a guard that fires after partial output has landed
  // leaves the retry blocked by the failed run's own files.
  const recordPath = resolveEngineOutput(projectDir, path.join(outDir, RECORD_NAME), {
    apply,
    replace,
    label: 'preview record',
  });

  if (!apply) {
    console.log(`plan: preview ${picks.length} segment(s) plus the end card`);
    console.log(`  output ${outDir}`);
    for (const { path: p } of destinations) console.log(`    ${p}`);
    planFooter();
    return EXIT.OK;
  }

  if (!replace) {
    const clashes = destinations.map((d) => d.path).filter((p) => pathExists(p, 'screenshot'));
    if (clashes.length) {
      throw new CliError(
        `${clashes.length} preview image(s) already exist, e.g. ${clashes[0]}. Pass --replace to overwrite them.`,
      );
    }
  }

  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--force-color-profile=srgb'] });
  // THE AUDIT IS OF THE DOCUMENT, NOT OF THE SLIDE ON SCREEN. `auditLayout` walks every
  // `.sl` in the page (write-build-html.mjs), so calling it per segment and filing the
  // result under that segment reported one slide's overflow under EVERY segment previewed
  // — "2 segment(s): ok, big" when only `big` overflowed. It is asked ONCE, and each issue
  // is attributed to the slide that owns it.
  //
  // SLIDES ARE `seg-<index>`, NOT SEGMENT IDS. Matching an issue's id against a segment id
  // matches nothing against a real build; the index is the join.
  const slideOwner = new Map(t.segments.map((s, i) => [`seg-${i}`, s.id]));
  slideOwner.set(`seg-${t.segments.length}`, 'endcard');
  const ownerOf = (issue) => slideOwner.get(issue.id) ?? issue.id;
  let documentIssues = [];
  const seekFor = new Map();
  try {
    const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await p.goto(new URL(`file:///${path.join(projectDir, 'video-auto.html').replace(/\\/g, '/')}`).toString(), { waitUntil: 'load' });
    await p.waitForTimeout(500);
    fs.mkdirSync(outDir, { recursive: true });

    for (const id of picks) {
      const s = t.segments.find((x) => x.id === id);
      const time = (s.startMs + (s.endMs - s.startMs) * 0.86) / 1000; // late in the segment: everything revealed
      await p.evaluate((tm) => {
        if (window.masterTimeline) { window.masterTimeline.seek(tm); window.masterTimeline.pause(); }
        if (window.fireTriggersUpTo) window.fireTriggersUpTo(tm);
      }, time);
      await p.waitForTimeout(180);
      await p.screenshot({ path: shotFor.get(id) });
      seekFor.set(id, Number(time.toFixed(3)));
      console.log(`${id.padEnd(10)} t=${time.toFixed(1)}s`);
    }

    // Asked once, after every seek, so it sees the document in its final state — the same
    // state frame-capture would render.
    documentIssues = await p.evaluate(() => (window.auditLayout ? window.auditLayout() : []));
    for (const issue of documentIssues) {
      console.log(`${String(ownerOf(issue)).padEnd(10)} layout issue: ${JSON.stringify(issue)}`);
    }

    // Validated up front, before any shot was taken.
    const ec = (contentMs + 1200) / 1000;
    await p.evaluate((tm) => {
      if (window.masterTimeline) { window.masterTimeline.seek(tm); window.masterTimeline.pause(); }
      if (window.fireTriggersUpTo) window.fireTriggersUpTo(tm);
    }, ec);
    await p.waitForTimeout(180);
    await p.screenshot({ path: shotFor.get('endcard') });
    seekFor.set('endcard', Number(ec.toFixed(3)));
    console.log(`endcard    t=${ec.toFixed(1)}s`);
  } finally {
    await b.close();
  }

  // ------------------------------------------------------------------------------------
  // THE BINDING RECORD, PUBLISHED LAST — and the reason is NOT make-music's.
  //
  // make-music publishes its ducking record FIRST, deliberately and with its reasons
  // written down ("THE RECORD FIRST, THEN THE BED"). That is correct THERE because it
  // fingerprints an IN-MEMORY buffer: the bytes exist before the write, so the record can
  // precede it, and a failed write leaves a record describing bytes that are not on disk —
  // which remux-music refuses as another bed.
  //
  // Here the stills are PNG bytes the BROWSER writes to disk. They cannot be hashed until
  // they exist, so the record CANNOT precede them. Same engine, opposite order, and the
  // distinguishing condition — whether the bytes exist before the write — is stated in
  // neither file. Cited without it, that precedent transfers a conclusion without the
  // reason that bounds it.
  //
  // IT DESCRIBES WHAT EACH STILL IS, NEVER WHAT IT SHOWS. The shot is taken at 86% of the
  // segment's window and can miss a late reveal, so a record claiming the still shows
  // "everything" would assert coverage it cannot deliver.
  //
  // It is published even when the audit FAILS: the transcript is most worth binding
  // exactly when it carries findings.
  const record = {
    timing: fingerprintBuffer(fs.readFileSync(path.join(projectDir, 'timing.json')), 'timing.json'),
    scene: fingerprintBuffer(fs.readFileSync(path.join(projectDir, 'video-auto.html')), 'video-auto.html'),
    stills: destinations.map(({ key, path: p }) => ({
      ...fingerprintBuffer(fs.readFileSync(p), path.basename(p)),
      // What the still IS: whose window it was taken in, and when.
      segment: key,
      seekSeconds: seekFor.get(key),
    })),
    // An empty transcript is a FINDING — "audited, nothing found" — not an absence. Omitting
    // it would let "not audited" read as "nothing wrong", which is the distinction the whole
    // pack exists to preserve.
    audit: { issues: documentIssues.map((issue) => ({ ...issue, owner: ownerOf(issue) })) },
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`record     ${recordPath}`);

  // frame-capture refuses to render a scene whose layout audit fails. Printing the same
  // finding here and exiting 0 meant the cheap check passed while the expensive one would
  // not — two stages disagreeing about whether the same condition is a failure.
  if (documentIssues.length) {
    const owners = [...new Set(documentIssues.map(ownerOf))];
    console.error(`\nFAILED: layout issues in ${owners.length} segment(s): ${owners.join(', ')}`);
    return EXIT.FAILED;
  }
  return EXIT.OK;
});
