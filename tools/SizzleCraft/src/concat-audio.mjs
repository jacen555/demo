import fs from 'node:fs';
import path from 'node:path';

function audioStart(buffer) {
  let offset = 0;
  if (buffer.length >= 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size + ((buffer[5] & 0x10) ? 10 : 0);
  }
  while (offset < buffer.length - 1) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) break;
    offset++;
  }
  return offset;
}

function stripId3v1(buffer) {
  return buffer.length >= 128 && buffer[buffer.length - 128] === 0x54 && buffer[buffer.length - 127] === 0x41 && buffer[buffer.length - 126] === 0x47
    ? buffer.subarray(0, buffer.length - 128)
    : buffer;
}

function clean(buffer, keepLeadingTag) {
  return stripId3v1(keepLeadingTag ? buffer : buffer.subarray(audioStart(buffer)));
}

const projectDir = process.cwd();
const silencePath = path.join(projectDir, 'silence.mp3');
const outPath = path.join(projectDir, 'voiceover.mp3');
const segmentPaths = fs.readdirSync(projectDir)
  .filter((name) => /^segment_\d+\.mp3$/i.test(name))
  .sort()
  .map((name) => path.join(projectDir, name));
if (!segmentPaths.length) throw new Error('no segment_000.mp3 files found');
if (!fs.existsSync(silencePath)) throw new Error(`missing ${silencePath}`);

const silence = clean(fs.readFileSync(silencePath), false);
const buffers = [];
for (let i = 0; i < segmentPaths.length; i++) {
  buffers.push(clean(fs.readFileSync(segmentPaths[i]), i === 0));
  if (i < segmentPaths.length - 1) buffers.push(silence);
}
fs.writeFileSync(outPath, Buffer.concat(buffers));
console.log(`wrote ${outPath}`);
