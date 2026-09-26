import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, requireSafeFilename, resolveWithinRoot, resolveOutput, assertDistinctDestinations, pathExists, planFooter } from './cli-support.mjs';

const USAGE = `
preview-seg — screenshot one segment at several points through its window.

  node preview-seg.mjs --id flywheel                     plan only (default)
  node preview-seg.mjs --id flywheel --apply             write the screenshots
  node preview-seg.mjs --id flywheel --at 0.5,0.9 --apply

Options
  --id <segment>    segment to preview (required)
  --at <fractions>  comma-separated fractions through the segment (default: 0.5,0.75,0.9,0.98)
  --out <dir>       output directory (default: preview)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write screenshots. Without it nothing is written.
  --replace         permit overwriting existing screenshots
  --help            show this message

Exit codes: 0 success/plan · 1 preview failed · 2 bad usage or refused overwrite
`.trimStart();

await runCli(async () => {
  const { values, projectDir, apply, replace } = parseCli({
    usage: USAGE,
    options: { id: { type: 'string' }, at: { type: 'string' }, out: { type: 'string' } },
  });

  if (!values.id) throw new CliError(`--id is required\n\n${USAGE}`);

  const t = JSON.parse(fs.readFileSync(requireExistingFile(projectDir, 'timing.json', 'timing file'), 'utf8'));
  const W = t.project.width, H = t.project.height;

  // Validated before it becomes a filename: --id is argv, interpolated straight into an
  // output path, so `../../x` wrote outside the project.
  const id = requireSafeFilename(values.id, '--id');
  const s = t.segments.find((x) => x.id === id);
  if (!s) {
    throw new CliError(`unknown segment id "${id}". available: ${t.segments.map((x) => x.id).join(', ')}`);
  }

  const fracs = String(values.at ?? '0.5,0.75,0.9,0.98')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      if (!/^(?:\d+|\d*\.\d+)$/.test(x)) throw new CliError(`--at must be comma-separated decimals — got "${x}"`);
      const n = Number(x);
      if (!(n >= 0 && n <= 1)) throw new CliError(`--at fractions must be between 0 and 1 — got ${x}`);
      return n;
    });
  if (!fracs.length) throw new CliError('--at produced no fractions');

  const outDir = resolveWithinRoot(projectDir, values.out ?? 'preview', 'output directory');
  // Applied to the written path, not just its directory — see preview.mjs.
  const shotPath = (fr) =>
    resolveOutput(projectDir, path.join(outDir, `${id}-${Math.round(fr * 100)}.png`), {
      apply,
      replace,
      label: `screenshot at ${fr}`,
    });

  // Distinct fractions can round to the same filename (0.501 and 0.504 both give 50),
  // so one silently overwrites the other and the run still reports success.
  const destinations = fracs.map((fr) => ({ key: String(fr), path: shotPath(fr) }));
  assertDistinctDestinations(destinations, 'screenshot');

  if (!apply) {
    console.log(`plan: preview segment "${id}" at ${fracs.length} point(s)`);
    for (const { path: p } of destinations) console.log(`    ${p}`);
    planFooter();
    return EXIT.OK;
  }

  if (!replace) {
    const clashes = destinations.map((d) => d.path).filter((p) => pathExists(p, 'screenshot'));
    if (clashes.length) {
      throw new CliError(`${clashes.length} preview image(s) already exist, e.g. ${clashes[0]}. Pass --replace to overwrite them.`);
    }
  }

  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--force-color-profile=srgb'] });
  try {
    const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await p.goto(new URL(`file:///${path.join(projectDir, 'video-auto.html').replace(/\\/g, '/')}`).toString(), { waitUntil: 'load' });
    await p.waitForTimeout(500);
    fs.mkdirSync(outDir, { recursive: true });

    for (const { key, path: dest } of destinations) {
      const fr = Number(key);
      const time = (s.startMs + (s.endMs - s.startMs) * fr) / 1000;
      await p.evaluate((tm) => {
        if (window.masterTimeline) { window.masterTimeline.seek(tm); window.masterTimeline.pause(); }
        if (window.fireTriggersUpTo) window.fireTriggersUpTo(tm);
      }, time);
      await p.waitForTimeout(900); // let any in-flight draw finish
      await p.screenshot({ path: dest });
      console.log(`${id} @ ${(fr * 100).toFixed(0)}%  t=${time.toFixed(1)}s`);
    }
  } finally {
    await b.close();
  }
  return EXIT.OK;
});
