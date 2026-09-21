import fs from 'node:fs';
import path from 'node:path';

// MPEG Layer III frame tables (kbps). MPEG-1 vs MPEG-2/2.5 differ in bitrate table + samples/frame.
const BR_V1_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const BR_V2_L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
const SR = { 3:[44100,48000,32000,0], 2:[22050,24000,16000,0], 0:[11025,12000,8000,0] }; // by version bits

function id3Len(b){ if(b.length>=10 && b[0]===0x49&&b[1]===0x44&&b[2]===0x33){const s=((b[6]&0x7f)<<21)|((b[7]&0x7f)<<14)|((b[8]&0x7f)<<7)|(b[9]&0x7f);return 10+s+((b[5]&0x10)?10:0);} return 0; }

function frameInfo(b,off){
  if(!(b[off]===0xff && (b[off+1]&0xe0)===0xe0)) return null;
  const verBits=(b[off+1]>>3)&0x03, layer=(b[off+1]>>1)&0x03;
  if(layer!==0x01) return null; // Layer III only
  const isV1=verBits===0x03, brIdx=(b[off+2]>>4)&0x0f, srIdx=(b[off+2]>>2)&0x03, pad=(b[off+2]>>1)&0x01;
  const bitrate=(isV1?BR_V1_L3:BR_V2_L3)[brIdx]*1000, sr=(SR[verBits]||SR[2])[srIdx];
  if(!bitrate||!sr) return null;
  const samples=isV1?1152:576;
  const size=Math.floor((isV1?144:72)*bitrate/sr)+pad;
  if(size<=0) return null;
  return { size, durMs: samples/sr*1000 };
}

const dir=process.cwd();
// Normalize targetMs: 0 is a legitimate no-op (schema allows outroMs:0); a missing/non-numeric/negative
// value (env or argv typo) falls back to the 2500 ms default rather than throwing.
const rawTarget=process.env.SIZZLECRAFT_OUTRO_MS||process.argv[2];
let targetMs=Number(rawTarget);
if(!Number.isFinite(targetMs)||targetMs<0) targetMs=2500;
if(targetMs===0){ console.log('append-outro: outroMs=0 -> no-op (no outro appended)'); process.exit(0); }
const silence=fs.readFileSync(path.join(dir,'silence.mp3'));
const voPath=path.join(dir,'voiceover.mp3');
let off=id3Len(silence); const frames=[]; let acc=0;
while(off<silence.length-4 && acc<targetMs){
  const fi=frameInfo(silence,off);
  if(!fi){ off++; continue; }
  frames.push(silence.subarray(off,off+fi.size)); acc+=fi.durMs; off+=fi.size;
}
if(!frames.length) throw new Error('append-outro: no silence frames parsed from silence.mp3');
fs.appendFileSync(voPath, Buffer.concat(frames));
console.log('appended outro ~'+Math.round(acc)+'ms ('+frames.length+' frames)');
