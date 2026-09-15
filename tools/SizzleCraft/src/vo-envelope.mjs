import { chromium } from 'playwright';
import fs from 'fs';
const b = await chromium.launch({headless:true});
const p = await b.newPage(); await p.goto('about:blank');
const b64 = fs.readFileSync('voiceover.mp3').toString('base64');
const env = await p.evaluate(async (b64)=>{
  const bin=atob(b64); const u8=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
  const ctx=new OfflineAudioContext(1,48000,48000);
  const buf=await ctx.decodeAudioData(u8.buffer);
  const d=buf.getChannelData(0), sr=buf.sampleRate;
  const hop=Math.round(sr*0.02), rms=[];
  for(let i=0;i<d.length;i+=hop){
    let s=0,n=0; for(let j=i;j<Math.min(i+hop,d.length);j++){s+=d[j]*d[j];n++;}
    rms.push(Math.sqrt(s/n));
  }
  return { durationMs: Math.round(buf.duration*1000), hopMs:20, rms };
}, b64);
fs.writeFileSync('vo-envelope.json', JSON.stringify(env));
console.log(`envelope: ${env.rms.length} frames over ${env.durationMs}ms`);
await b.close();
