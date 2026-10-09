// Measures head/tail silence by DECODING the audio, not from synthesis metadata
// (see bug ledger entry 5). Read-only: it reports and cannot fail on any finding.
//
// THE BROWSER LAUNCH USED TO BE THE FIRST THING THIS FILE DID. It sat at module scope
// above the argument read, so `--help` launched a headless Chromium, then died inside
// node:fs trying to open a file literally named "--help". Argument parsing could not be
// put in front of it without moving it, which is why this is a restructure rather than a
// guard: the work now happens inside a function that runs after parseCli has returned.
//
// The browser is also closed in a `finally` now. It previously closed only on the success
// path, so any failure between launch and the last line leaked a Chromium process.
import fs from "node:fs";
import { chromium } from "playwright";
import { parseCli, requireExistingFile, runCli } from "./cli-support.mjs";

const USAGE = `
silence-scan — report silent runs in an audio file, measured by decoding it.

  node silence-scan.mjs                 scan voiceover.mp3
  node silence-scan.mjs <file>          scan a named file

Options
  --project <dir>   project root the file is resolved against (default: current directory)
  --help            show this message

Reports runs of near-silence (RMS below 0.004 over a 20 ms window) lasting 400 ms or more.
Read-only: it reports what it measured and never fails on a finding.

Exit codes: 0 success · 1 the file could not be decoded · 2 bad usage`.trim();

await runCli(async () => {
    // Resolved against --project rather than the process cwd, which is what the usage says.
    // Advertising the option and ignoring it would read a different file from the one the
    // caller was told, and leave the input unconfined.
    const { positionals, projectDir } = parseCli({
        usage: USAGE,
        allowPositionals: true,
    });
    const file = requireExistingFile(
        projectDir,
        positionals[0] ?? "voiceover.mp3",
        "audio file",
    );
    const b64 = fs.readFileSync(file).toString("base64");

    const b = await chromium.launch({ headless: true });
    try {
        const p = await b.newPage();
        await p.goto("about:blank");
        const runs = await p.evaluate(async (b64) => {
            const bin = atob(b64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const ctx = new OfflineAudioContext(1, 48000, 48000);
            const buf = await ctx.decodeAudioData(u8.buffer);
            const d = buf.getChannelData(0),
                sr = buf.sampleRate;
            const win = Math.round(sr * 0.02); // 20ms RMS window
            const THRESH = 0.004; // near-silence
            const loud = [];
            for (let i = 0; i < d.length; i += win) {
                let s = 0,
                    n = 0;
                for (let j = i; j < Math.min(i + win, d.length); j++) {
                    s += d[j] * d[j];
                    n++;
                }
                loud.push(Math.sqrt(s / n) > THRESH);
            }
            const out = [];
            let start = null;
            for (let i = 0; i < loud.length; i++) {
                if (!loud[i]) {
                    if (start === null) start = i;
                } else {
                    if (start !== null) {
                        out.push([start * 20, i * 20]);
                        start = null;
                    }
                }
            }
            if (start !== null) out.push([start * 20, loud.length * 20]);
            return {
                durationMs: Math.round(buf.duration * 1000),
                runs: out.filter((r) => r[1] - r[0] >= 400),
            };
        }, b64);

        console.log(`${file}: ${runs.durationMs}ms total`);
        console.log("silence runs >= 400ms:");
        for (const [s, e] of runs.runs) {
            const mm = (ms) =>
                `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
            console.log(
                `  ${mm(s)} -> ${mm(e)}   ${((e - s) / 1000).toFixed(2)}s`,
            );
        }
    } finally {
        await b.close();
    }
});
