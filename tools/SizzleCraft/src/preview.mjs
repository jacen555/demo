import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, requireSafeFilename, resolveWithinRoot, resolveOutput, assertDistinctDestinations, pathExists, planFooter } from './cli-support.mjs';

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
  const allIssues = [];
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
      const issues = await p.evaluate(() => (window.auditLayout ? window.auditLayout() : []));
      await p.screenshot({ path: shotFor.get(id) });
      if (issues.length) allIssues.push({ id, issues });
      console.log(`${id.padEnd(10)} t=${time.toFixed(1)}s  layout issues: ${issues.length ? JSON.stringify(issues) : 'none'}`);
    }

    const ec = (t.contentMs + 1200) / 1000;
    await p.evaluate((tm) => {
      if (window.masterTimeline) { window.masterTimeline.seek(tm); window.masterTimeline.pause(); }
      if (window.fireTriggersUpTo) window.fireTriggersUpTo(tm);
    }, ec);
    await p.waitForTimeout(180);
    await p.screenshot({ path: shotFor.get('endcard') });
    console.log(`endcard    t=${ec.toFixed(1)}s`);
  } finally {
    await b.close();
  }

  // frame-capture refuses to render a scene whose layout audit fails. Printing the same
  // finding here and exiting 0 meant the cheap check passed while the expensive one would
  // not — two stages disagreeing about whether the same condition is a failure.
  if (allIssues.length) {
    console.error(`\nFAILED: layout issues in ${allIssues.length} segment(s): ${allIssues.map((a) => a.id).join(', ')}`);
    return EXIT.FAILED;
  }
  return EXIT.OK;
});
