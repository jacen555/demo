import { parseFile } from 'music-metadata';

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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  console.log(await probeDurationSeconds(process.argv[2] || 'voiceover.mp3'));
}
