import { parseFile } from 'music-metadata';
import { parseCli, requireExistingFile, runCli } from './cli-support.mjs';

export async function probeDurationSeconds(audioPath) {
  const metadata = await parseFile(audioPath, { duration: true });
  if (typeof metadata.format?.duration !== 'number') throw new Error(`no duration for ${audioPath}`);
  return metadata.format.duration;
}

export async function probeMany(paths, { concurrency = 8 } = {}) {
  const result = {};
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const file = paths[next++];
      result[file] = await probeDurationSeconds(file);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker));
  return result;
}

const USAGE = `
audio-probe — print a media file's duration in seconds, probed without a full decode.

  node audio-probe.mjs                  probe voiceover.mp3
  node audio-probe.mjs <file>           probe a named file

Options
  --project <dir>   project root the file is resolved against (default: current directory)
  --help            show this message

Also importable: probeDurationSeconds(path) and probeMany(paths).

Exit codes: 0 success · 1 the file could not be probed · 2 bad usage`.trim();

// Argument parsing comes first. This block used to pass argv[2] straight to the probe, so
// `--help` was read as the name of a file to open and the script died inside node:fs.
//
// The file is resolved against --project rather than the process cwd, which is what the
// usage above says: advertising an option and then ignoring it would send a caller's path
// somewhere other than where they were told, and leave the input unconfined.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await runCli(async () => {
    const { positionals, projectDir } = parseCli({ usage: USAGE, allowPositionals: true });
    const file = requireExistingFile(projectDir, positionals[0] ?? 'voiceover.mp3', 'audio file');
    console.log(await probeDurationSeconds(file));
  });
}
