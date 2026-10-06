import fs from 'node:fs';
import { EXIT, runCli, parseCli, requireExistingFile, resolveOutput, describeWrite, planFooter, fingerprintBuffer } from './cli-support.mjs';
import {
  fingerprintVoice,
  envelopeBindingRecord,
  classifyEnvelopeLineage,
  describeEnvelopeState,
} from './envelope-ducking.mjs';

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

The envelope records a fingerprint of the VOICE AUDIO it was measured from, under
"measuredFrom". Every consumer checks it and refuses an envelope that describes different
audio, because a duck calibrated against a stale envelope drifts further out of alignment
the longer the video runs and nothing downstream measures that. The plan reports the state
of an envelope already on disk; it never silently re-measures one.

Exit codes: 0 success/plan · 1 measurement failed · 2 bad usage or refused overwrite
`.trimStart();

await runCli(async () => {
  const { values, projectDir, apply, replace } = parseCli({
    usage: USAGE,
    options: { voice: { type: 'string' }, out: { type: 'string' } },
  });

  const voiceName = values.voice ?? 'voiceover.mp3';
  const voicePath = requireExistingFile(projectDir, voiceName, 'voice track');
  const outPath = resolveOutput(projectDir, values.out ?? 'vo-envelope.json', { apply, replace, label: 'output' });

  if (!apply) {
    // Taken from the INPUT, streamed: the plan needs it to report whether an envelope
    // already on disk still describes this audio. See envelope-ducking.mjs for why the
    // fingerprint is over the input rather than over the artefact it certifies.
    const fingerprint = await fingerprintVoice(voicePath, voiceName);

    console.log('plan: measure the narration amplitude envelope');
    console.log(`  source ${voicePath} (${fingerprint.bytes} bytes, sha256 ${fingerprint.sha256.slice(0, 12)})`);
    console.log(`  output ${outPath} — ${describeWrite(outPath, replace)}`);

    // REPORTED, NEVER ACTED ON. This stage writes nothing without --apply, and quietly
    // re-measuring a stale envelope here would be the silent repair the consumers exist
    // to refuse.
    if (fs.existsSync(outPath)) {
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      } catch (err) {
        console.log(`  existing UNREADABLE — ${outPath} is not valid JSON (${err.message})`);
      }
      if (existing !== null) {
        console.log(`  existing ${describeEnvelopeState(classifyEnvelopeLineage(existing, fingerprint))}`);
      }
    }

    planFooter();
    return EXIT.OK;
  }

  // ONE READ, BOTH HASHED AND DECODED. The binding used to be taken from one read of the
  // voice and the envelope measured from a second, with a browser launch in between, so
  // a file replaced in that window got the new audio's envelope bound to the old audio.
  // Read once, before the browser: the fingerprint and the decode are over these bytes.
  const voiceBytes = await fs.promises.readFile(voicePath);
  const fingerprint = fingerprintBuffer(voiceBytes, voiceName);

  // Loaded only on the --apply path so a plan never needs a browser.
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    await p.goto('about:blank');
    const b64 = voiceBytes.toString('base64');
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
    // The binding names the buffer that was decoded, so it names the bytes measured.
    fs.writeFileSync(outPath, JSON.stringify({ ...env, measuredFrom: envelopeBindingRecord(fingerprint) }));
    console.log(`envelope: ${env.rms.length} frames over ${env.durationMs}ms -> ${outPath}`);
    console.log(`  measured from ${fingerprint.file} (sha256 ${fingerprint.sha256.slice(0, 12)})`);
  } finally {
    await b.close();
  }
  return EXIT.OK;
});
