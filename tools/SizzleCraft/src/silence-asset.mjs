import fs from 'node:fs';
import path from 'node:path';

const projectDir = process.cwd();
const silencePath = path.join(projectDir, 'silence.mp3');

if (!fs.existsSync(silencePath)) {
  throw new Error(`missing ${silencePath}; copy the shipped mono 24 kHz silence.mp3 asset into the project dir`);
}

console.log(silencePath);
