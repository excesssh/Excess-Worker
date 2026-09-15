import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile,lstat,mkdir,open,readFile,readdir,rename,rm,writeFile } from "node:fs/promises";
import { dirname,isAbsolute,join,parse,relative,resolve,sep } from "node:path";
import { AdapterError,BACKENDS,DEFAULT_MODEL_ID,RUNTIME_ARTIFACTS,catalogEntry,type Artifact,type Backend } from "./manifest.js";
import { scanSafeZip,DEFAULT_ZIP_LIMITS,type ZipLimits } from "./zip.js";

const hosts=new Set(["github.com","release-assets.githubusercontent.com","objects.githubusercontent.com","raw.githubusercontent.com","huggingface.co","us.aws.cdn.hf.co","cas-bridge.xethub.hf.co"]);
const GiB=1024*1024*1024;
// CUDA runtime archives are far larger than the CPU build; each backend has its own reviewed bounds.
const ZIP_LIMITS:Record<Backend,ZipLimits>={cpu:DEFAULT_ZIP_LIMITS,cuda:{maxInputBytes:512*1024*1024,maxTotalBytes:4*GiB,maxEntryBytes:2*GiB}};
export interface InstallProgress { artifact:string; receivedBytes:number; totalBytes:number }
export interface Installation {directory:string;serverPath:string;modelPath:string;capabilityDigest:string;modelId:string;backend:Backend}

function backendOf(value:unknown):Backend {
  if(!BACKENDS.includes(value as Backend))throw new AdapterError("INVALID_BACKEND");
  return value as Backend;
}
const runtimeDirectory=(root:string,backend:Backend)=>join(resolve(root),"runtimes",backend);
const modelDirectory=(root:string,modelId:string)=>join(resolve(root),"models",modelId);

/** What installing one catalog model on one backend downloads, and what it needs. The root holds shared
 * runtimes (`runtimes/<backend>`), models (`models/<id>`) and an optional offline cache (`downloads/<sha256>`). */
export function textInstallationPlan(directory:string,modelId:string=DEFAULT_MODEL_ID,backend:Backend="cpu") {
  if(typeof directory!=="string"||!directory||directory.length>1024)throw new AdapterError("INVALID_INSTALL_DIRECTORY");
  const entry=catalogEntry(modelId),selected=backendOf(backend);
  const artifacts=[...RUNTIME_ARTIFACTS[selected],...entry.artifacts];
  const downloadBytes=artifacts.reduce((sum,artifact)=>sum+artifact.bytes,0);
  return {directory:resolve(directory),modelId:entry.id,backend:selected,capabilityDigest:entry.capabilityDigest,platform:"win32-x64",
    model:{displayName:entry.displayName,parameters:entry.parameters,quantization:entry.quantization,minMemoryMb:entry.minMemoryMb,minVramMb:entry.minVramMb},
    artifacts,licences:{runtime:"MIT",model:"Apache-2.0"},downloadBytes,
    diskBudgetBytes:downloadBytes+ZIP_LIMITS[selected].maxTotalBytes,requiresExplicitConsent:true};
}
export async function noLinks(path:string):Promise<void> {
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  for(const part of relative(root,absolute).split(sep).filter(Boolean)) {
    current=join(current,part);
    try {if((await lstat(current)).isSymbolicLink())throw new AdapterError("INSTALL_PATH_LINK_FORBIDDEN");}
    catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
}
export function inside(root:string,name:string):string {
  const target=resolve(root,name),rel=relative(root,target);
  if(!rel||rel.startsWith(".."+sep)||rel===".."||isAbsolute(rel))throw new AdapterError("INSTALL_PATH_ESCAPE");
  return target;
}
async function hashFile(path:string,expectedBytes:number):Promise<string> {
  await noLinks(path);
  const stat=await lstat(path);
  if(!stat.isFile()||stat.size!==expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  const hash=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(path)){bytes+=(chunk as Buffer).length;if(bytes>expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");hash.update(chunk);}
  if(bytes!==expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return hash.digest("hex");
}
async function verifyRuntime(root:string,backend:Backend):Promise<string> {
  const directory=runtimeDirectory(root,backend);await noLinks(directory);
  const expected=new Map<string,{bytes:number;sha256:string}>();let servers=0;
  for(const artifact of RUNTIME_ARTIFACTS[backend]) {
    if(await hashFile(inside(directory,artifact.name),artifact.bytes)!==artifact.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
    if(!artifact.name.endsWith(".zip"))continue;
    scanSafeZip(await readFile(inside(directory,artifact.name)),ZIP_LIMITS[backend],entry=>{
      if(expected.has(entry.name.toLowerCase()))throw new AdapterError("UNSAFE_RUNTIME_ARCHIVE");
      if(entry.name.split("/").at(-1)==="llama-server.exe")servers++;
      expected.set(entry.name.toLowerCase(),{bytes:entry.data.length,sha256:createHash("sha256").update(entry.data).digest("hex")});
    });
  }
  const serverEntries=[...expected.keys()].filter(name=>name.split("/").at(-1)==="llama-server.exe");
  if(servers!==1||serverEntries.length!==1)throw new AdapterError("RUNTIME_SERVER_MISSING");
  const directories=new Set<string>();
  for(const name of expected.keys()){const parts=name.split("/");for(let n=1;n<parts.length;n++)directories.add(parts.slice(0,n).join("/"));}
  const seen=new Set<string>();
  async function inspect(relativeDirectory="") {
    for(const entry of await readdir(join(directory,"runtime",relativeDirectory),{withFileTypes:true})) {
      const name=(relativeDirectory?relativeDirectory+"/":"")+entry.name,key=name.toLowerCase();
      if(entry.isSymbolicLink()||(!entry.isFile()&&!entry.isDirectory()))throw new AdapterError("UNEXPECTED_RUNTIME_FILE");
      if(entry.isDirectory()){if(!directories.has(key))throw new AdapterError("UNEXPECTED_RUNTIME_FILE");await inspect(name);continue;}
      const file=expected.get(key);
      if(!file)throw new AdapterError("UNEXPECTED_RUNTIME_FILE");
      if(await hashFile(inside(join(directory,"runtime"),name),file.bytes)!==file.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
      seen.add(key);
    }
  }
  await inspect();
  if(seen.size!==expected.size)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return inside(join(directory,"runtime"),serverEntries[0]!);
}
async function verifyModel(root:string,modelId:string):Promise<string> {
  const entry=catalogEntry(modelId),directory=modelDirectory(root,entry.id);await noLinks(directory);
  for(const artifact of entry.artifacts)if(await hashFile(inside(directory,artifact.name),artifact.bytes)!==artifact.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return inside(directory,entry.artifacts[0]!.name);
}
/** Re-verifies every pinned file of a model and its backend runtime, including each extracted runtime file. */
export async function verifyInstallation(directory:string,modelId:string=DEFAULT_MODEL_ID,backend:Backend="cpu"):Promise<Installation> {
  const root=resolve(directory),entry=catalogEntry(modelId),selected=backendOf(backend);await noLinks(root);
  try {
    const serverPath=await verifyRuntime(root,selected),modelPath=await verifyModel(root,entry.id);
    return {directory:root,serverPath,modelPath,capabilityDigest:entry.capabilityDigest,modelId:entry.id,backend:selected};
  } catch(error) {if(error instanceof AdapterError)throw error;throw new AdapterError("ADAPTER_NOT_INSTALLED_OR_CORRUPT");}
}
/** Lists which catalog models and runtimes are present on disk, without re-hashing large files. */
export async function installedComponents(directory:string):Promise<{runtimes:Backend[];models:string[]}> {
  const root=resolve(directory),present=async(path:string)=>{try{return (await lstat(path)).isFile();}catch{return false;}};
  const runtimes:Backend[]=[],models:string[]=[];
  for(const backend of BACKENDS)if(await present(join(runtimeDirectory(root,backend),"install.json")))runtimes.push(backend);
  try{for(const name of await readdir(join(root,"models")))if(await present(join(root,"models",name,"install.json")))models.push(name);}catch{}
  return {runtimes,models};
}
async function download(artifact:Artifact,path:string,cache:string,signal:AbortSignal,progress?:(value:InstallProgress)=>void) {
  // A file already in the offline cache is used only if its size and hash match the pin.
  const cached=join(cache,artifact.sha256);
  try {
    if(await hashFile(cached,artifact.bytes)===artifact.sha256){await copyFile(cached,path);progress?.({artifact:artifact.name,receivedBytes:artifact.bytes,totalBytes:artifact.bytes});return;}
  } catch(error) {if(!(error instanceof AdapterError)&&(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  let url=artifact.url,response:Response|undefined;
  for(let hops=0;hops<5;hops++) {
    const parsed=new URL(url);
    if(parsed.protocol!=="https:"||parsed.username||parsed.password||!hosts.has(parsed.hostname))throw new AdapterError("ARTIFACT_REDIRECT_DENIED");
    response=await fetch(url,{redirect:"manual",signal,headers:{"Accept-Encoding":"identity","User-Agent":"EXCESS-pinned-adapter-installer"}});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get("location");await response.body?.cancel();
      if(!location)throw new AdapterError("ARTIFACT_DOWNLOAD_FAILED");url=new URL(location,url).href;continue;
    }
    break;
  }
  if(!response?.ok||!response.body){await response?.body?.cancel();throw new AdapterError("ARTIFACT_DOWNLOAD_FAILED");}
  const length=response.headers.get("content-length");
  if(length!==null&&Number(length)!==artifact.bytes){await response.body.cancel();throw new AdapterError("ARTIFACT_SIZE_MISMATCH");}
  const file=await open(path,"wx",0o600),hash=createHash("sha256");let received=0,lastProgress=0;
  try {
    for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received+=chunk.byteLength;if(received>artifact.bytes)throw new AdapterError("ARTIFACT_SIZE_MISMATCH");
      hash.update(chunk);
      for(let offset=0;offset<chunk.byteLength;){const result=await file.write(chunk,offset,chunk.byteLength-offset);if(result.bytesWritten<1)throw new AdapterError("ARTIFACT_WRITE_FAILED");offset+=result.bytesWritten;}
      if(received-lastProgress>=64*1024*1024){lastProgress=received;progress?.({artifact:artifact.name,receivedBytes:received,totalBytes:artifact.bytes});}
    }
    if(received!==artifact.bytes||hash.digest("hex")!==artifact.sha256)throw new AdapterError("ARTIFACT_HASH_MISMATCH");
    await file.sync();progress?.({artifact:artifact.name,receivedBytes:received,totalBytes:artifact.bytes});
  } finally {await file.close();}
}
// Antivirus scanners briefly lock freshly written files on Windows; renaming the staged directory is retried.
async function renameWithRetry(from:string,to:string):Promise<void> {
  for(let attempt=0;;attempt++) {
    try {await rename(from,to);return;}
    catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      if(attempt>=20||!["EPERM","EBUSY","EACCES"].includes(code??""))throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(250*(attempt+1),3000)));
    }
  }
}
async function installComponent(root:string,target:string,artifacts:readonly Artifact[],limits:ZipLimits|null,verify:()=>Promise<unknown>,
  record:Record<string,unknown>,signal:AbortSignal,onProgress?:(value:InstallProgress)=>void):Promise<void> {
  try {await lstat(target);await verify();return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await mkdir(dirname(target),{recursive:true});await noLinks(dirname(target));
  const stage=target+".install-"+randomUUID();
  await mkdir(stage,{mode:0o700});
  try {
    for(const artifact of artifacts) {
      const path=inside(stage,artifact.name);await mkdir(dirname(path),{recursive:true});
      await download(artifact,path,join(root,"downloads"),signal,onProgress);
    }
    if(limits)for(const artifact of artifacts.filter(item=>item.name.endsWith(".zip"))) {
      const writes:Promise<void>[]=[];
      scanSafeZip(await readFile(inside(stage,artifact.name)),limits,entry=>{
        const path=inside(join(stage,"runtime"),entry.name);
        writes.push(mkdir(dirname(path),{recursive:true}).then(()=>writeFile(path,entry.data,{flag:"wx",mode:0o600})));
      });
      await Promise.all(writes);
    }
    await writeFile(inside(stage,"install.json"),JSON.stringify({version:2,...record,installedAt:new Date().toISOString(),artifacts},null,2)+"\n",{flag:"wx",mode:0o600});
    signal.throwIfAborted();await noLinks(target);await renameWithRetry(stage,target);
    await verify();
  } catch(error) {
    // Only the fresh random staging sibling is ever recursively removed.
    if(dirname(stage)===dirname(target)&&stage.startsWith(target+".install-")&&relative(dirname(target),stage)!=="")await rm(stage,{recursive:true,force:true});
    if(error instanceof AdapterError)throw error;
    throw new AdapterError(signal.aborted?"ARTIFACT_DOWNLOAD_ABORTED":"ARTIFACT_INSTALL_FAILED",{cause:error});
  }
}
/** Installs a catalog model and its backend runtime after explicit consent, reusing whatever is already verified. */
export async function installTextAdapter(directory:string,options:{consent:true;modelId?:string;backend?:Backend;signal?:AbortSignal;onProgress?:(value:InstallProgress)=>void}):Promise<Installation> {
  if(options?.consent!==true)throw new AdapterError("MODEL_INSTALL_CONSENT_REQUIRED");
  if(process.platform!=="win32"||process.arch!=="x64")throw new AdapterError("UNSUPPORTED_ADAPTER_PLATFORM");
  const root=resolve(directory),entry=catalogEntry(options.modelId??DEFAULT_MODEL_ID),backend=backendOf(options.backend??"cpu");
  await mkdir(root,{recursive:true});await noLinks(root);
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(6*60*60*1000)]):AbortSignal.timeout(6*60*60*1000);
  await installComponent(root,runtimeDirectory(root,backend),RUNTIME_ARTIFACTS[backend],ZIP_LIMITS[backend],()=>verifyRuntime(root,backend),{backend},signal,options.onProgress);
  await installComponent(root,modelDirectory(root,entry.id),entry.artifacts,null,()=>verifyModel(root,entry.id),{modelId:entry.id,capabilityDigest:entry.capabilityDigest},signal,options.onProgress);
  return verifyInstallation(root,entry.id,backend);
}
