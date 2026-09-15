import { createHash } from "node:crypto";
import { MEDIA_LIMITS,type ArtifactRef } from "@excess/protocol";
import { AdapterError } from "./manifest.js";

export const sha256=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
export const artifactRef=(data:Buffer,contentType:ArtifactRef["contentType"]):ArtifactRef=>({digest:sha256(data),bytes:data.length,contentType});
/** Canonical padded base64 only; anything a strict encoder would not produce is refused. */
export function strictBase64(value:unknown,maxBytes:number):Buffer|null {
  if(typeof value!=="string"||value.length%4!==0||value.length>Math.ceil(maxBytes/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))return null;
  const data=Buffer.from(value,"base64");
  return data.length<=maxBytes&&data.toString("base64")===value?data:null;
}

export interface WavInfo {sampleRate:number;channels:number;bitsPerSample:number;dataBytes:number;durationMs:number}
/** The only accepted audio: RIFF/WAVE, one PCM `fmt ` chunk (16 kHz, mono, 16-bit) before one `data` chunk; other chunks
 * such as LIST are skipped. Duration comes from the data size (32,000 bytes per second) and must be 1 to 300 seconds. */
export function parseWav(input:Uint8Array):WavInfo {
  const bad=():never=>{throw new AdapterError("INVALID_AUDIO");};
  const b=Buffer.from(input.buffer,input.byteOffset,input.byteLength),limits=MEDIA_LIMITS.transcription;
  if(b.length<44||b.length>limits.maxAudioBytes||b.toString("latin1",0,4)!=="RIFF"||b.toString("latin1",8,12)!=="WAVE")return bad();
  let at=12,format:{tag:number;channels:number;rate:number;byteRate:number;block:number;bits:number}|undefined,dataBytes=-1;
  for(let chunks=0;at+8<=b.length;chunks++) {
    if(chunks>=16)return bad();
    const id=b.toString("latin1",at,at+4),size=b.readUInt32LE(at+4),body=at+8;
    if(body+size>b.length)return bad();
    if(id==="fmt ") {
      if(format||size<16)return bad();
      format={tag:b.readUInt16LE(body),channels:b.readUInt16LE(body+2),rate:b.readUInt32LE(body+4),byteRate:b.readUInt32LE(body+8),block:b.readUInt16LE(body+12),bits:b.readUInt16LE(body+14)};
    } else if(id==="data") {if(!format)return bad();dataBytes=size;break;}
    at=body+size+(size&1);
  }
  if(!format||dataBytes<2||dataBytes%2!==0||format.tag!==1||format.channels!==1||format.rate!==limits.sampleRate||format.bits!==16||format.block!==2||format.byteRate!==limits.sampleRate*2)return bad();
  const durationMs=dataBytes/32;
  if(durationMs<limits.minSeconds*1000||durationMs>limits.maxSeconds*1000)return bad();
  return {sampleRate:format.rate,channels:1,bitsPerSample:16,dataBytes,durationMs};
}
/** A deterministic 16 kHz mono PCM16 sine tone, used for local probes; not speech. */
export function toneWav(milliseconds:number,frequency=440):Buffer {
  const samples=Math.round(milliseconds*16),out=Buffer.alloc(44+samples*2);
  out.write("RIFF",0,"latin1");out.writeUInt32LE(36+samples*2,4);out.write("WAVEfmt ",8,"latin1");out.writeUInt32LE(16,16);
  out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
  out.write("data",36,"latin1");out.writeUInt32LE(samples*2,40);
  for(let n=0;n<samples;n++)out.writeInt16LE(Math.round(Math.sin(2*Math.PI*frequency*n/16000)*8000),44+n*2);
  return out;
}

const PNG_SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const PNG_END=Buffer.from([0,0,0,0,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82]);
/** Structural PNG check: signature, a first IHDR chunk with the dimensions, a final IEND chunk and the size limit. */
export function parsePng(input:Buffer,maxBytes:number=MEDIA_LIMITS.image.maxImageBytes):{width:number;height:number} {
  if(input.length<8+25+12||input.length>maxBytes||!input.subarray(0,8).equals(PNG_SIGNATURE)||input.readUInt32BE(8)!==13||
     input.toString("latin1",12,16)!=="IHDR"||!input.subarray(input.length-12).equals(PNG_END))throw new AdapterError("INVALID_IMAGE_OUTPUT");
  return {width:input.readUInt32BE(16),height:input.readUInt32BE(20)};
}
