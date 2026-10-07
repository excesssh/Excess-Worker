import { inflateRawSync } from "node:zlib";
import { AdapterError } from "./manifest.js";

export interface ZipEntry { name:string; data:Buffer }
export interface ZipLimits { maxInputBytes:number; maxTotalBytes:number; maxEntryBytes:number;
  /** Only signed worker packages contain app/node_modules/@excess. Runtime downloads keep this unset. */
  allowExcessWorkerScope?:boolean }
const MiB=1024*1024;
export const DEFAULT_ZIP_LIMITS:Readonly<ZipLimits>=Object.freeze({maxInputBytes:32*MiB,maxTotalBytes:256*MiB,maxEntryBytes:128*MiB});

// Reviewed ZIP subset only: no ZIP64, encryption, links, collisions or path traversal. Entries are inflated one at a
// time and handed to the callback, so large runtime archives never hold every file in memory at once.
export function scanSafeZip(input:Buffer,limits:ZipLimits,onEntry:(entry:ZipEntry)=>void):void {
  const bad=():never=>{throw new AdapterError("UNSAFE_RUNTIME_ARCHIVE");};
  if(input.length<22||input.length>limits.maxInputBytes)return bad();
  let end=-1;
  for(let p=input.length-22;p>=Math.max(0,input.length-65557);p--)if(input.readUInt32LE(p)===0x06054b50){end=p;break;}
  if(end<0||end+22+input.readUInt16LE(end+20)!==input.length||input.readUInt16LE(end+4)!==0||input.readUInt16LE(end+6)!==0)return bad();
  const count=input.readUInt16LE(end+10),size=input.readUInt32LE(end+12),offset=input.readUInt32LE(end+16);
  if(count<1||count>1024||count!==input.readUInt16LE(end+8)||offset+size!==end)return bad();
  let at=offset,total=0;
  const names=new Set<string>();
  for(let n=0;n<count;n++) {
    if(at+46>end||input.readUInt32LE(at)!==0x02014b50)return bad();
    const flags=input.readUInt16LE(at+8),method=input.readUInt16LE(at+10),compressed=input.readUInt32LE(at+20),expanded=input.readUInt32LE(at+24);
    const nameSize=input.readUInt16LE(at+28),extra=input.readUInt16LE(at+30),comment=input.readUInt16LE(at+32),local=input.readUInt32LE(at+42);
    if(at+46+nameSize+extra+comment>end||input.readUInt16LE(at+34)!==0||(flags&~0x808)!==0||![0,8].includes(method))return bad();
    const name=input.subarray(at+46,at+46+nameSize).toString("utf8"),segments=name.replace(/\/$/,"").split("/");
    if(!name||name.length>240||name.includes("\\")||segments.some((s,i)=>!s||s==="."||s===".."||
      (!/^[-A-Za-z0-9._]+$/.test(s)&&!(limits.allowExcessWorkerScope===true&&i===3&&s==="@excess"&&segments[1]==="app"&&segments[2]==="node_modules"))||
      s.endsWith(".")||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))||names.has(name.toLowerCase()))return bad();
    names.add(name.toLowerCase());
    const mode=(input.readUInt32LE(at+38)>>>16)&0xf000;
    if(mode!==0&&mode!==0x8000&&mode!==0x4000)return bad();
    if(local+30>offset||input.readUInt32LE(local)!==0x04034b50||input.readUInt16LE(local+6)!==flags||input.readUInt16LE(local+8)!==method)return bad();
    const localNameSize=input.readUInt16LE(local+26),dataAt=local+30+localNameSize+input.readUInt16LE(local+28);
    if(dataAt+compressed>offset||input.subarray(local+30,local+30+localNameSize).toString("utf8")!==name)return bad();
    total+=expanded;
    if(total>limits.maxTotalBytes||expanded>limits.maxEntryBytes)return bad();
    const directory=name.endsWith("/");
    if(directory&&expanded!==0)return bad();
    if(!directory) {
      let data:Buffer;
      try {data=method===0?Buffer.from(input.subarray(dataAt,dataAt+compressed)):inflateRawSync(input.subarray(dataAt,dataAt+compressed),{maxOutputLength:Math.max(1,expanded)});}catch{return bad();}
      if(data.length!==expanded)return bad();
      onEntry({name,data});
    }
    at+=46+nameSize+extra+comment;
  }
  if(at!==end)return bad();
}
export function readSafeZip(input:Buffer,limits:ZipLimits=DEFAULT_ZIP_LIMITS):ZipEntry[] {
  const result:ZipEntry[]=[];
  scanSafeZip(input,limits,entry=>result.push(entry));
  return result;
}
