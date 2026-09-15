import { chromium } from 'playwright';
import fs from 'fs';
const file = process.argv[2] || 'voiceover.mp3';
const b = await chromium.launch({headless:true});
const p = await b.newPage(); await p.goto('about:blank');
const b64 = fs.readFileSync(file).toString('base64');
const runs = await p.evaluate(async (b64) => {
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
  const ctx = new OfflineAudioContext(1, 48000, 48000);
  const buf = await ctx.decodeAudioData(u8.buffer);
  const d = buf.getChannelData(0), sr = buf.sampleRate;
  const win = Math.round(sr*0.02);            // 20ms RMS window
  const THRESH = 0.004;                        // near-silence
  const loud = [];
  for (let i=0;i<d.length;i+=win){
    let s=0,n=0; for(let j=i;j<Math.min(i+win,d.length);j++){s+=d[j]*d[j];n++;}
    loud.push(Math.sqrt(s/n) > THRESH);
  }
  const out=[]; let start=null;
  for (let i=0;i<loud.length;i++){
    if(!loud[i]){ if(start===null) start=i; }
    else { if(start!==null){ out.push([start*20, i*20]); start=null; } }
  }
  if(start!==null) out.push([start*20, loud.length*20]);
  return { durationMs: Math.round(buf.duration*1000), runs: out.filter(r=>r[1]-r[0]>=400) };
}, b64);
console.log(`${file}: ${runs.durationMs}ms total`);
console.log('silence runs >= 400ms:');
for (const [s,e] of runs.runs) {
  const mm = ms=>`${Math.floor(ms/60000)}:${String(Math.floor(ms%60000/1000)).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
  console.log(`  ${mm(s)} -> ${mm(e)}   ${((e-s)/1000).toFixed(2)}s`);
}
await b.close();
