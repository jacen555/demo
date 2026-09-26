import fs from 'node:fs';
import { EXIT, runCli, parseCli, requireExistingFile, resolveOutput, describeWrite, planFooter } from './cli-support.mjs';

const USAGE = `
vo-envelope — measure the narration amplitude envelope used to sidechain-duck the music
bed (pipeline stage S4/S8).

  node vo-envelope.mjs                      plan only (default)
  node vo-envelope.mjs --apply              write vo-envelope.json
  node vo-envelope.mjs --apply --replace    overwrite an existing vo-envelope.json

Options
  --voice <file>    narration to measure (default: voiceover.mp3)
  --out <file>      output path (default: vo-envelope.json)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing --out
  --help            show this message

Exit codes: 0 success/plan · 1 measurement failed · 2 bad usage or refused overwrite
`.trimStart();

await runCli(async () => {
  const { values, projectDir, apply, replace } = parseCli({
    usage: USAGE,
    options: { voice: { type: 'string' }, out: { type: 'string' } },
  });

  const voicePath = requireExistingFile(projectDir, values.voice ?? 'voiceover.mp3', 'voice track');
  const outPath = resolveOutput(projectDir, values.out ?? 'vo-envelope.json', { apply, replace, label: 'output' });

  if (!apply) {
    console.log('plan: measure the narration amplitude envelope');
    console.log(`  source ${voicePath} (${fs.statSync(voicePath).size} bytes)`);
    console.log(`  output ${outPath} — ${describeWrite(outPath, replace)}`);
    planFooter();
    return EXIT.OK;
  }

  // Loaded only on the --apply path so a plan never needs a browser.
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    await p.goto('about:blank');
    const b64 = fs.readFileSync(voicePath).toString('base64');
    const env = await p.evaluate(async (b64) => {
      const bin = atob(b64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const ctx = new OfflineAudioContext(1, 48000, 48000);
      const buf = await ctx.decodeAudioData(u8.buffer);
      const d = buf.getChannelData(0), sr = buf.sampleRate;
      const hop = Math.round(sr * 0.02), rms = [];
      for (let i = 0; i < d.length; i += hop) {
        let s = 0, n = 0; for (let j = i; j < Math.min(i + hop, d.length); j++) { s += d[j] * d[j]; n++; }
        rms.push(Math.sqrt(s / n));
      }
      return { durationMs: Math.round(buf.duration * 1000), hopMs: 20, rms };
    }, b64);
    fs.writeFileSync(outPath, JSON.stringify(env));
    console.log(`envelope: ${env.rms.length} frames over ${env.durationMs}ms -> ${outPath}`);
  } finally {
    await b.close();
  }
  return EXIT.OK;
});
