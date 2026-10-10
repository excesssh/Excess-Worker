import { gunzipSync } from "node:zlib";
import { AdapterError } from "./manifest.js";
import type { ZipEntry,ZipLimits } from "./zip.js";

// Reviewed tar.gz subset for pinned Linux builds. The default layout requires one top-level folder and strips it; the
// explicit flat layout accepts only root-level regular files. In the default layout, a symlink must name a file in the
// archive and is materialized as a copy, so installed runtimes never contain links. Hard links, devices, long-name and
// pax records are refused in both layouts.
export type SafeTarGzLayout="single-root"|"flat-regular-files";
export function scanSafeTarGz(input:Buffer,limits:ZipLimits,onEntry:(entry:ZipEntry)=>void,layout:SafeTarGzLayout="single-root"):void {
  const bad=():never=>{throw new AdapterError("UNSAFE_RUNTIME_ARCHIVE");};
  if(layout!=="single-root"&&layout!=="flat-regular-files")return bad();
  if(input.length<32||input.length>limits.maxInputBytes)return bad();
  let tar=Buffer.alloc(0);
  try {tar=gunzipSync(input,{maxOutputLength:limits.maxTotalBytes+4*1024*1024});}catch{return bad();}
  if(tar.length<1024||tar.length%512!==0)return bad();
  const text=(offset:number,length:number)=>{const raw=tar.subarray(offset,offset+length),end=raw.indexOf(0);return raw.subarray(0,end<0?length:end).toString("utf8");};
  const segmentOk=(segment:string)=>Boolean(segment)&&segment!=="."&&segment!==".."&&/^[-A-Za-z0-9._+]+$/.test(segment);
  const files=new Map<string,Buffer>(),links=new Map<string,string>(),names=new Set<string>();
  let root:string|undefined,at=0,total=0,count=0,ended=false;
  while(at+512<=tar.length) {
    const header=tar.subarray(at,at+512);
    if(header.every(byte=>byte===0)){ended=true;break;}
    if(++count>4096)return bad();
    let sum=0;for(let index=0;index<512;index++)sum+=index>=148&&index<156?32:header[index]!;
    const recorded=text(at+148,8).trim();
    if(!/^[0-7]{1,7}$/.test(recorded)||parseInt(recorded,8)!==sum||!text(at+257,6).startsWith("ustar"))return bad();
    const prefix=text(at+345,155),base=text(at,100),name=prefix?prefix+"/"+base:base;
    const sizeText=text(at+124,12).trim();
    if(!/^[0-7]{1,11}$/.test(sizeText))return bad();
    const size=parseInt(sizeText,8),type=String.fromCharCode(header[156]!),dataAt=at+512,next=dataAt+Math.ceil(size/512)*512;
    if(next>tar.length||!name||name.length>240||name.startsWith("/")||name.includes("\\"))return bad();
    const segments=name.replace(/\/$/,"").split("/");
    if(!segments.every((segment,index)=>segmentOk(segment)||limits.allowExcessWorkerScope===true&&index===3&&segment==="@excess"&&segments[1]==="app"&&segments[2]==="node_modules"))return bad();
    if(layout==="flat-regular-files") {
      if(segments.length!==1||name.endsWith("/"))return bad();
    } else if(root===undefined)root=segments[0];else if(segments[0]!==root)return bad();
    const relativeName=layout==="flat-regular-files"?segments[0]!:segments.slice(1).join("/");
    if(type==="5") {
      if(size!==0||layout==="flat-regular-files")return bad();
    } else {
      if(!relativeName||names.has(relativeName))return bad();
      names.add(relativeName);
      if(type==="0"||type==="\0") {
        total+=size;
        if(size>limits.maxEntryBytes||total>limits.maxTotalBytes)return bad();
        files.set(relativeName,Buffer.from(tar.subarray(dataAt,dataAt+size)));
      } else if(type==="2") {
        if(layout==="flat-regular-files")return bad();
        if(limits.allowExcessWorkerScope===true)return bad();
        const target=text(at+157,100);
        if(size!==0||!segmentOk(target))return bad();
        const directory=segments.slice(1,-1).join("/");
        links.set(relativeName,(directory?directory+"/":"")+target);
      } else return bad();
    }
    at=next;
  }
  if(!ended||(layout==="single-root"&&root===undefined)||files.size===0)return bad();
  for(const [name,data] of files)onEntry({name,data});
  for(const [name,target] of links) {
    let resolved=target;
    for(let hops=0;links.has(resolved);hops++){if(hops>8)return bad();resolved=links.get(resolved)!;}
    const data=files.get(resolved);
    if(!data)return bad();
    total+=data.length;
    if(total>limits.maxTotalBytes)return bad();
    onEntry({name,data});
  }
}
