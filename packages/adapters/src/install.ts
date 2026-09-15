import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile,lstat,mkdir,open,readFile,readdir,rename,rm,writeFile } from "node:fs/promises";
import { dirname,isAbsolute,join,parse,relative,resolve,sep } from "node:path";
import { AdapterError,BACKENDS,DEFAULT_MODEL_ID,RUNTIME_REDIST,catalogEntry,currentPlatform,runtimeArtifacts,serverExecutable,type Artifact,type Backend,type Platform,type RedistFile } from "./manifest.js";
import { scanSafeZip,DEFAULT_ZIP_LIMITS,type ZipEntry,type ZipLimits } from "./zip.js";
import { scanSafeTarGz } from "./tar.js";

const hosts=new Set(["github.com","release-assets.githubusercontent.com","objects.githubusercontent.com","raw.githubusercontent.com","huggingface.co","us.aws.cdn.hf.co","cas-bridge.xethub.hf.co"]);
const MiB=1024*1024,GiB=1024*MiB;
// Each platform and backend archive has its own reviewed bounds; CUDA runtimes are far larger than the CPU builds.
const ARCHIVE_LIMITS:Readonly<Record<Platform,Partial<Record<Backend,ZipLimits>>>>={
  "win32-x64":{cpu:DEFAULT_ZIP_LIMITS,cuda:{maxInputBytes:512*MiB,maxTotalBytes:4*GiB,maxEntryBytes:2*GiB}},
  "linux-x64":{cpu:{maxInputBytes:64*MiB,maxTotalBytes:512*MiB,maxEntryBytes:128*MiB},vulkan:{maxInputBytes:64*MiB,maxTotalBytes:512*MiB,maxEntryBytes:256*MiB}},
};
export interface InstallProgress { artifact:string; receivedBytes:number; totalBytes:number }
export interface Installation {directory:string;serverPath:string;modelPath:string;capabilityDigest:string;modelId:string;backend:Backend}

export function backendOf(value:unknown):Backend {
  if(!BACKENDS.includes(value as Backend))throw new AdapterError("INVALID_BACKEND");
  return value as Backend;
}
export function platformOf():Platform {
  const platform=currentPlatform();
  if(!platform)throw new AdapterError("UNSUPPORTED_ADAPTER_PLATFORM");
  return platform;
}
export function limitsFor(platform:Platform,backend:Backend):ZipLimits {
  const limits=ARCHIVE_LIMITS[platform][backend];
  if(!limits)throw new AdapterError("BACKEND_UNSUPPORTED_ON_PLATFORM");
  return limits;
}
const isArchive=(name:string)=>name.endsWith(".zip")||name.endsWith(".tar.gz");
function scanArchive(name:string,input:Buffer,limits:ZipLimits,onEntry:(entry:ZipEntry)=>void):void {
  if(name.endsWith(".zip"))scanSafeZip(input,limits,onEntry);else scanSafeTarGz(input,limits,onEntry);
}
// Windows file names are case-insensitive, so runtime files are compared case-insensitively there only.
const fileKey=(platform:Platform,name:string)=>platform==="win32-x64"?name.toLowerCase():name;
export const runtimeDirectory=(root:string,backend:Backend)=>join(resolve(root),"runtimes",backend);
export const modelDirectory=(root:string,modelId:string)=>join(resolve(root),"models",modelId);

/** What installing one catalog model on one backend downloads on this platform, and what it needs. The root holds shared
 * runtimes (`runtimes/<backend>`), models (`models/<id>`) and an optional offline cache (`downloads/<sha256>`). */
export function textInstallationPlan(directory:string,modelId:string=DEFAULT_MODEL_ID,backend:Backend="cpu") {
  if(typeof directory!=="string"||!directory||directory.length>1024)throw new AdapterError("INVALID_INSTALL_DIRECTORY");
  const entry=catalogEntry(modelId),selected=backendOf(backend),platform=currentPlatform()??"win32-x64";
  const artifacts=[...runtimeArtifacts(selected,platform),...entry.artifacts];
  const downloadBytes=artifacts.reduce((sum,artifact)=>sum+artifact.bytes,0);
  return {directory:resolve(directory),modelId:entry.id,backend:selected,capabilityDigest:entry.capabilityDigest,platform,
    model:{displayName:entry.displayName,parameters:entry.parameters,quantization:entry.quantization,minMemoryMb:entry.minMemoryMb,minVramMb:entry.minVramMb},
    artifacts,licences:{runtime:"MIT",model:"Apache-2.0"},downloadBytes,
    diskBudgetBytes:downloadBytes+limitsFor(platform,selected).maxTotalBytes,requiresExplicitConsent:true};
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
export async function hashFile(path:string,expectedBytes:number):Promise<string> {
  await noLinks(path);
  const stat=await lstat(path);
  if(!stat.isFile()||stat.size!==expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  const hash=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(path)){bytes+=(chunk as Buffer).length;if(bytes>expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");hash.update(chunk);}
  if(bytes!==expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return hash.digest("hex");
}
/** One pinned runtime folder: its archives and licence, the one server executable they must contain, the archive bounds
 * and the only redistributable files allowed beside a Windows server. */
export interface RuntimeSpec {directory:string;artifacts:readonly Artifact[];server:string;limits:ZipLimits;redist:readonly RedistFile[];platform:Platform}
export async function verifyRuntimeAt(spec:RuntimeSpec):Promise<string> {
  const {directory,platform,limits}=spec,server=fileKey(platform,spec.server);
  await noLinks(directory);
  const expected=new Map<string,{bytes:number;sha256:string}>();let servers=0;
  for(const artifact of spec.artifacts) {
    if(await hashFile(inside(directory,artifact.name),artifact.bytes)!==artifact.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
    if(!isArchive(artifact.name))continue;
    scanArchive(artifact.name,await readFile(inside(directory,artifact.name)),limits,entry=>{
      const key=fileKey(platform,entry.name);
      if(expected.has(key))throw new AdapterError("UNSAFE_RUNTIME_ARCHIVE");
      if(key.split("/").at(-1)===server)servers++;
      expected.set(key,{bytes:entry.data.length,sha256:createHash("sha256").update(entry.data).digest("hex")});
    });
  }
  const serverEntries=[...expected.keys()].filter(name=>name.split("/").at(-1)===server);
  if(servers!==1||serverEntries.length!==1)throw new AdapterError("RUNTIME_SERVER_MISSING");
  const directories=new Set<string>();
  for(const name of expected.keys()){const parts=name.split("/");for(let n=1;n<parts.length;n++)directories.add(parts.slice(0,n).join("/"));}
  const seen=new Set<string>();
  async function inspect(relativeDirectory="") {
    for(const entry of await readdir(join(directory,"runtime",relativeDirectory),{withFileTypes:true})) {
      const name=(relativeDirectory?relativeDirectory+"/":"")+entry.name,key=fileKey(platform,name);
      if(entry.isSymbolicLink()||(!entry.isFile()&&!entry.isDirectory()))throw new AdapterError("UNEXPECTED_RUNTIME_FILE");
      if(entry.isDirectory()){if(!directories.has(key))throw new AdapterError("UNEXPECTED_RUNTIME_FILE");await inspect(name);continue;}
      const file=expected.get(key);
      if(!file){
        // Only the pinned Visual C++ runtime files may sit beside a Windows server, and only with their exact bytes.
        const redist=relativeDirectory||platform!=="win32-x64"?undefined:spec.redist.find(item=>item.name===key);
        if(!redist)throw new AdapterError("UNEXPECTED_RUNTIME_FILE");
        if(await hashFile(inside(join(directory,"runtime"),name),redist.bytes)!==redist.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
        continue;
      }
      if(await hashFile(inside(join(directory,"runtime"),name),file.bytes)!==file.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
      seen.add(key);
    }
  }
  await inspect();
  if(seen.size!==expected.size)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return inside(join(directory,"runtime"),serverEntries[0]!);
}
function textRuntimeSpec(root:string,backend:Backend):RuntimeSpec {
  const platform=platformOf();
  return {directory:runtimeDirectory(root,backend),artifacts:runtimeArtifacts(backend,platform),server:serverExecutable(platform),limits:limitsFor(platform,backend),redist:RUNTIME_REDIST,platform};
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
    const serverPath=await verifyRuntimeAt(textRuntimeSpec(root,selected)),modelPath=await verifyModel(root,entry.id);
    return {directory:root,serverPath,modelPath,capabilityDigest:entry.capabilityDigest,modelId:entry.id,backend:selected};
  } catch(error) {if(error instanceof AdapterError)throw error;throw new AdapterError("ADAPTER_NOT_INSTALLED_OR_CORRUPT");}
}
/** Lists which catalog models (text and media) and runtimes are present on disk, without re-hashing large files.
 * `runtimes` are llama.cpp builds; `sdRuntimes` are stable-diffusion.cpp builds for image models. */
export async function installedComponents(directory:string):Promise<{runtimes:Backend[];sdRuntimes:Backend[];models:string[]}> {
  const root=resolve(directory),present=async(path:string)=>{try{return (await lstat(path)).isFile();}catch{return false;}};
  const runtimes:Backend[]=[],sdRuntimes:Backend[]=[],models:string[]=[];
  for(const backend of BACKENDS) {
    if(await present(join(runtimeDirectory(root,backend),"install.json")))runtimes.push(backend);
    if(await present(join(root,"sd-runtimes",backend,"install.json")))sdRuntimes.push(backend);
  }
  try{for(const name of await readdir(join(root,"models")))if(await present(join(root,"models",name,"install.json")))models.push(name);}catch{}
  return {runtimes,sdRuntimes,models};
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
export async function installComponent(root:string,target:string,artifacts:readonly Artifact[],limits:ZipLimits|null,verify:()=>Promise<unknown>,
  record:Record<string,unknown>,signal:AbortSignal,onProgress?:(value:InstallProgress)=>void):Promise<void> {
  try {await lstat(target);await verify();return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await mkdir(dirname(target),{recursive:true});await noLinks(dirname(target));
  const stage=target+".install-"+randomUUID();
  await mkdir(stage,{mode:0o700});
  // Linux runtime files must be executable by their owner; nobody else gets access on either platform.
  const mode=process.platform==="win32"?0o600:0o700;
  try {
    for(const artifact of artifacts) {
      const path=inside(stage,artifact.name);await mkdir(dirname(path),{recursive:true});
      await download(artifact,path,join(root,"downloads"),signal,onProgress);
    }
    if(limits)for(const artifact of artifacts.filter(item=>isArchive(item.name))) {
      const writes:Promise<void>[]=[];
      scanArchive(artifact.name,await readFile(inside(stage,artifact.name)),limits,entry=>{
        const path=inside(join(stage,"runtime"),entry.name);
        writes.push(mkdir(dirname(path),{recursive:true}).then(()=>writeFile(path,entry.data,{flag:"wx",mode})));
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
/** Copies pinned redistributable files from source into an installed runtime folder, checking every source byte first.
 * Files already present with the pinned bytes are kept; returns the names copied. */
export async function copyRedist(target:string,files:readonly RedistFile[],source:string):Promise<string[]> {
  await noLinks(target);await noLinks(resolve(source));
  const copied:string[]=[];
  for(const file of files) {
    const destination=inside(target,file.name);
    try {if(await hashFile(destination,file.bytes)===file.sha256)continue;}catch(error){if(!(error instanceof AdapterError)&&(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const from=inside(resolve(source),file.name);
    let matches=false;try{matches=await hashFile(from,file.bytes)===file.sha256;}catch(error){if(!(error instanceof AdapterError)&&(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(!matches)throw new AdapterError("REDIST_FILE_MISMATCH");
    // Staged beside, not inside, the runtime folder so an interrupted copy never leaves an unexpected runtime file.
    const stage=join(dirname(target),file.name+".install-"+randomUUID());
    await copyFile(from,stage);
    if(await hashFile(stage,file.bytes)!==file.sha256){await rm(stage,{force:true});throw new AdapterError("REDIST_FILE_MISMATCH");}
    await rm(destination,{force:true});await renameWithRetry(stage,destination);copied.push(file.name);
  }
  return copied;
}
/** Copies the pinned Visual C++ runtime files from source into an installed llama.cpp runtime. */
export async function installRuntimeRedist(directory:string,backend:Backend,source:string):Promise<string[]> {
  return copyRedist(join(runtimeDirectory(resolve(directory),backendOf(backend)),"runtime"),RUNTIME_REDIST,source);
}
/** Installs a catalog model and its backend runtime after explicit consent, reusing whatever is already verified. */
export async function installTextAdapter(directory:string,options:{consent:true;modelId?:string;backend?:Backend;redistDirectory?:string;signal?:AbortSignal;onProgress?:(value:InstallProgress)=>void}):Promise<Installation> {
  if(options?.consent!==true)throw new AdapterError("MODEL_INSTALL_CONSENT_REQUIRED");
  const platform=platformOf();
  const root=resolve(directory),entry=catalogEntry(options.modelId??DEFAULT_MODEL_ID),backend=backendOf(options.backend??"cpu");
  const spec=textRuntimeSpec(root,backend);
  await mkdir(root,{recursive:true});await noLinks(root);
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(6*60*60*1000)]):AbortSignal.timeout(6*60*60*1000);
  await installComponent(root,spec.directory,spec.artifacts,spec.limits,()=>verifyRuntimeAt(spec),{backend,platform},signal,options.onProgress);
  if(options.redistDirectory&&platform==="win32-x64")await installRuntimeRedist(root,backend,options.redistDirectory);
  await installComponent(root,modelDirectory(root,entry.id),entry.artifacts,null,()=>verifyModel(root,entry.id),{modelId:entry.id,capabilityDigest:entry.capabilityDigest},signal,options.onProgress);
  return verifyInstallation(root,entry.id,backend);
}
