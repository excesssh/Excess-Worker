import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile,link,lstat,mkdir,open,readFile,readdir,realpath,rename,rm,stat,statfs,writeFile } from "node:fs/promises";
import { basename,dirname,isAbsolute,join,parse,relative,resolve,sep } from "node:path";
import { AdapterError,BACKENDS,DEFAULT_MODEL_ID,MEDIA_CATALOG,MODEL_CATALOG,RUNTIME_REDIST,catalogEntry,currentPlatform,runtimeArtifacts,serverExecutable,type Artifact,type Backend,type Platform,type RedistFile } from "./manifest.js";
import { scanSafeZip,DEFAULT_ZIP_LIMITS,type ZipEntry,type ZipLimits } from "./zip.js";
import { scanSafeTarGz } from "./tar.js";

const hosts=new Set(["github.com","release-assets.githubusercontent.com","objects.githubusercontent.com","raw.githubusercontent.com","huggingface.co","us.aws.cdn.hf.co","cas-bridge.xethub.hf.co"]);
const MiB=1024*1024,GiB=1024*MiB;
// Each platform and backend archive has its own reviewed bounds; CUDA runtimes are far larger than the CPU builds.
const ARCHIVE_LIMITS:Readonly<Record<Platform,Partial<Record<Backend,ZipLimits>>>>={
  "win32-x64":{cpu:DEFAULT_ZIP_LIMITS,cuda:{maxInputBytes:512*MiB,maxTotalBytes:4*GiB,maxEntryBytes:2*GiB}},
  "linux-x64":{cuda:{maxInputBytes:1024*MiB,maxTotalBytes:4*GiB,maxEntryBytes:1024*MiB},cpu:{maxInputBytes:64*MiB,maxTotalBytes:512*MiB,maxEntryBytes:128*MiB},vulkan:{maxInputBytes:64*MiB,maxTotalBytes:512*MiB,maxEntryBytes:256*MiB}},
};
export interface InstallProgress { artifact:string; receivedBytes:number; totalBytes:number }
export interface VerifiedRuntimeFile {path:string;sha256:string}
export interface VerifiedRuntimeInputs {runtimeRoot:string;runtimeFiles:readonly VerifiedRuntimeFile[];modelFiles:readonly VerifiedRuntimeFile[]}
export interface Installation extends VerifiedRuntimeInputs {directory:string;serverPath:string;modelPath:string;capabilityDigest:string;modelId:string;backend:Backend}

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
const errorCode=(error:unknown)=>(error as NodeJS.ErrnoException)?.code;
export const runtimeDirectory=(root:string,backend:Backend)=>join(resolve(root),"runtimes",backend);
export const modelDirectory=(root:string,modelId:string)=>join(resolve(root),"models",modelId);

/** What installing one catalog model on one backend downloads on this platform, and what it needs. The root holds shared
 * runtimes (`runtimes/<backend>`), models (`models/<id>`) and an offline cache (`downloads/<sha256>`). */
export function textInstallationPlan(directory:string,modelId:string=DEFAULT_MODEL_ID,backend:Backend="cpu") {
  if(typeof directory!=="string"||!directory||directory.length>1024)throw new AdapterError("INVALID_INSTALL_DIRECTORY");
  const entry=catalogEntry(modelId),selected=backendOf(backend),platform=currentPlatform()??"win32-x64";
  const artifacts=[...runtimeArtifacts(selected,platform),...entry.artifacts];
  const downloadBytes=artifacts.reduce((sum,artifact)=>sum+artifact.bytes,0);
  return {directory:resolve(directory),modelId:entry.id,backend:selected,capabilityDigest:entry.capabilityDigest,platform,
    model:{displayName:entry.displayName,parameters:entry.parameters,quantization:entry.quantization,minMemoryMb:entry.minMemoryMb,minVramMb:entry.minVramMb,
      files:entry.artifacts.filter(item=>item.name.endsWith(".gguf")).length},
    artifacts,licences:{runtime:"MIT",model:String(entry.capability.modelLicence)},downloadBytes,
    diskBudgetBytes:downloadBytes+limitsFor(platform,selected).maxTotalBytes,requiresExplicitConsent:true};
}
export async function noLinks(path:string):Promise<void> {
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  for(const part of relative(root,absolute).split(sep).filter(Boolean)) {
    current=join(current,part);
    try {if((await lstat(current)).isSymbolicLink())throw new AdapterError("INSTALL_PATH_LINK_FORBIDDEN");}
    catch(error) {if(errorCode(error)!=="ENOENT")throw error;}
  }
}
export function inside(root:string,name:string):string {
  const target=resolve(root,name),rel=relative(root,target);
  if(!rel||rel.startsWith(".."+sep)||rel===".."||isAbsolute(rel))throw new AdapterError("INSTALL_PATH_ESCAPE");
  return target;
}
async function digestFile(path:string,expectedBytes:number):Promise<string> {
  const hash=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(path)){bytes+=(chunk as Buffer).length;if(bytes>expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");hash.update(chunk);}
  if(bytes!==expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return hash.digest("hex");
}
export async function hashFile(path:string,expectedBytes:number):Promise<string> {
  await noLinks(path);
  const found=await lstat(path);
  if(!found.isFile()||found.size!==expectedBytes)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return digestFile(path,expectedBytes);
}
/** One pinned runtime folder: its archives and licence, the one server executable they must contain, the archive bounds
 * and the only redistributable files allowed beside a Windows server. */
export interface RuntimeSpec {directory:string;artifacts:readonly Artifact[];server:string;limits:ZipLimits;redist:readonly RedistFile[];platform:Platform}
export async function verifyRuntimeFilesAt(spec:RuntimeSpec):Promise<{serverPath:string;runtimeRoot:string;runtimeFiles:readonly VerifiedRuntimeFile[]}> {
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
  const seen=new Set<string>(),verified:VerifiedRuntimeFile[]=[];
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
        verified.push({path:inside(join(directory,"runtime"),name),sha256:redist.sha256});
        continue;
      }
      if(await hashFile(inside(join(directory,"runtime"),name),file.bytes)!==file.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
      verified.push({path:inside(join(directory,"runtime"),name),sha256:file.sha256});
      seen.add(key);
    }
  }
  await inspect();
  if(seen.size!==expected.size)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return {serverPath:inside(join(directory,"runtime"),serverEntries[0]!),runtimeRoot:join(directory,"runtime"),
    runtimeFiles:Object.freeze(verified.map(file=>Object.freeze(file)))};
}
/** Compatibility wrapper for installation callers that need only the verified executable. */
export async function verifyRuntimeAt(spec:RuntimeSpec):Promise<string> {return (await verifyRuntimeFilesAt(spec)).serverPath;}
function textRuntimeSpec(root:string,backend:Backend):RuntimeSpec {
  const platform=platformOf();
  return {directory:runtimeDirectory(root,backend),artifacts:runtimeArtifacts(backend,platform),server:serverExecutable(platform),limits:limitsFor(platform,backend),redist:RUNTIME_REDIST,platform};
}
/** Re-hashes every pinned file in a model folder and returns the path of the first one: the GGUF, or a split model's first part. */
export async function verifyModelFiles(root:string,modelId:string,artifacts:readonly Artifact[]):Promise<string> {
  const directory=modelDirectory(root,modelId);await noLinks(directory);
  for(const artifact of artifacts)if(await hashFile(inside(directory,artifact.name),artifact.bytes)!==artifact.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
  return inside(directory,artifacts[0]!.name);
}
/** Re-verifies every pinned file of a model and its backend runtime, including each extracted runtime file. */
export async function verifyInstallation(directory:string,modelId:string=DEFAULT_MODEL_ID,backend:Backend="cpu"):Promise<Installation> {
  const root=resolve(directory),entry=catalogEntry(modelId),selected=backendOf(backend);await noLinks(root);
  try {
    const runtime=await verifyRuntimeFilesAt(textRuntimeSpec(root,selected)),modelPath=await verifyModelFiles(root,entry.id,entry.artifacts);
    const modelFiles=Object.freeze(entry.artifacts.filter(artifact=>!artifact.name.startsWith("licences/"))
      .map(artifact=>Object.freeze({path:inside(modelDirectory(root,entry.id),artifact.name),sha256:artifact.sha256})));
    return {directory:root,...runtime,modelPath,modelFiles,capabilityDigest:entry.capabilityDigest,modelId:entry.id,backend:selected};
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

export type Fetcher=(url:string,init:RequestInit)=>Promise<Response>;
const cachePath=(cache:string,artifact:Artifact)=>join(cache,artifact.sha256);
/** A file already in the offline cache is used only if its size and hash match the pin. */
async function cachedFile(cache:string,artifact:Artifact):Promise<string|null> {
  try {if(await hashFile(cachePath(cache,artifact),artifact.bytes)===artifact.sha256)return cachePath(cache,artifact);}
  catch(error) {if(!(error instanceof AdapterError)&&errorCode(error)!=="ENOENT")throw error;}
  return null;
}
/** Downloads one pinned artifact into a download folder as <sha256>. Bytes land in <sha256>.partial first; a later attempt keeps
 * them and asks for the rest with a byte range, re-hashing the kept bytes so the final SHA-256 still covers the whole file. A
 * server that ignores the range restarts the file; a wrong size or hash deletes it. */
export async function downloadToCache(artifact:Artifact,cache:string,signal:AbortSignal,progress?:(value:InstallProgress)=>void,fetcher:Fetcher=fetch):Promise<string> {
  await mkdir(cache,{recursive:true});await noLinks(cache);
  const partial=cachePath(cache,artifact)+".partial";
  let offset=0,hash=createHash("sha256");
  try {
    const kept=await lstat(partial);
    if(!kept.isFile()||kept.size===0||kept.size>artifact.bytes)await rm(partial,{force:true});
    else if(kept.size>0){offset=kept.size;for await(const chunk of createReadStream(partial,{start:0,end:offset-1}))hash.update(chunk);}
  } catch(error) {if(errorCode(error)!=="ENOENT")throw error;}
  if(offset<artifact.bytes) {
    let url=artifact.url,response:Response|undefined;
    const headers:Record<string,string>={"Accept-Encoding":"identity","User-Agent":"EXCESS-pinned-adapter-installer",...(offset>0?{Range:`bytes=${offset}-`}:{})};
    for(let hops=0;hops<5;hops++) {
      const parsed=new URL(url);
      if(parsed.protocol!=="https:"||parsed.username||parsed.password||!hosts.has(parsed.hostname))throw new AdapterError("ARTIFACT_REDIRECT_DENIED");
      response=await fetcher(url,{redirect:"manual",signal,headers});
      if([301,302,303,307,308].includes(response.status)) {
        const location=response.headers.get("location");await response.body?.cancel();
        if(!location)throw new AdapterError("ARTIFACT_DOWNLOAD_FAILED");url=new URL(location,url).href;continue;
      }
      break;
    }
    if(!response?.ok||!response.body){await response?.body?.cancel();throw new AdapterError("ARTIFACT_DOWNLOAD_FAILED");}
    if(offset>0&&(response.status!==206||response.headers.get("content-range")!==`bytes ${offset}-${artifact.bytes-1}/${artifact.bytes}`)) {
      if(response.status===206){await response.body.cancel();await rm(partial,{force:true});throw new AdapterError("ARTIFACT_DOWNLOAD_FAILED");}
      offset=0;hash=createHash("sha256");await rm(partial,{force:true});
    }
    const length=response.headers.get("content-length");
    if(length!==null&&Number(length)!==artifact.bytes-offset){await response.body.cancel();throw new AdapterError("ARTIFACT_SIZE_MISMATCH");}
    const file=await open(partial,offset>0?"a":"wx",0o600);let received=offset,lastProgress=offset;
    try {
      for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received+=chunk.byteLength;if(received>artifact.bytes){await rm(partial,{force:true});throw new AdapterError("ARTIFACT_SIZE_MISMATCH");}
        hash.update(chunk);
        for(let at=0;at<chunk.byteLength;){const result=await file.write(chunk,at,chunk.byteLength-at);if(result.bytesWritten<1)throw new AdapterError("ARTIFACT_WRITE_FAILED");at+=result.bytesWritten;}
        if(received-lastProgress>=64*MiB){lastProgress=received;progress?.({artifact:artifact.name,receivedBytes:received,totalBytes:artifact.bytes});}
      }
      await file.sync();
    } finally {await file.close();}
    if(received!==artifact.bytes){await rm(partial,{force:true});throw new AdapterError("ARTIFACT_SIZE_MISMATCH");}
  }
  if(hash.digest("hex")!==artifact.sha256){await rm(partial,{force:true});throw new AdapterError("ARTIFACT_HASH_MISMATCH");}
  await renameWithRetry(partial,cachePath(cache,artifact));
  progress?.({artifact:artifact.name,receivedBytes:artifact.bytes,totalBytes:artifact.bytes});
  return cachePath(cache,artifact);
}
// Antivirus scanners briefly lock freshly written files on Windows; renaming a staged file or directory is retried.
async function renameWithRetry(from:string,to:string):Promise<void> {
  for(let attempt=0;;attempt++) {
    try {await rename(from,to);return;}
    catch(error) {
      if(attempt>=20||!["EPERM","EBUSY","EACCES"].includes(errorCode(error)??""))throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(250*(attempt+1),3000)));
    }
  }
}
const NO_HARD_LINK=["EXDEV","EPERM","EACCES","ENOTSUP","EOPNOTSUPP","EMLINK","ENOSYS","EINVAL"];
/** Puts a verified file into a staging folder without a second copy when the volume allows it: a hard link (the source is then
 * removed if the installer owns it), otherwise a move or a copy that is hashed again. */
async function place(source:string,path:string,artifact:Artifact,owned:boolean):Promise<"link"|"move"|"copy"> {
  // A pending file that cannot be removed yet (a scanner holding it) is only a second name for the same bytes; the next
  // install finds it verified and moves it then.
  try {await link(source,path);if(owned)await rm(source,{force:true}).catch(()=>{});return owned?"move":"link";}
  catch(error) {if(!NO_HARD_LINK.includes(errorCode(error)??""))throw error;}
  if(owned)try {await renameWithRetry(source,path);return "move";} catch(error) {if(errorCode(error)!=="EXDEV")throw error;}
  await copyFile(source,path);
  if(await hashFile(path,artifact.bytes)!==artifact.sha256)throw new AdapterError("ARTIFACT_HASH_MISMATCH");
  return "copy";
}
/** Installs one component (a runtime or a model folder) from pinned artifacts. Every file is first found or downloaded in the
 * offline cache, so an interrupted install keeps each finished file and the partial one for the next attempt; `provided`
 * maps artifact names to local files already checked against their pins (imports), which are linked or copied instead. */
export async function installComponent(root:string,target:string,artifacts:readonly Artifact[],limits:ZipLimits|null,verify:()=>Promise<unknown>,
  record:Record<string,unknown>,signal:AbortSignal,onProgress?:(value:InstallProgress)=>void,provided?:ReadonlyMap<string,string>,fetcher?:Fetcher):Promise<void> {
  try {await lstat(target);await verify();return;}catch(error){if(errorCode(error)!=="ENOENT")throw error;}
  await mkdir(dirname(target),{recursive:true});await noLinks(dirname(target));
  // downloads/<sha256> is the supplier's own offline cache and is kept; the installer's downloads wait in downloads/pending
  // and move into the component once it installs.
  const cache=join(root,"downloads"),pending=join(cache,"pending"),sources=new Map<string,{path:string;owned:boolean}>();
  try {
    for(const artifact of artifacts) {
      const given=provided?.get(artifact.name);
      if(given!==undefined){sources.set(artifact.name,{path:given,owned:false});continue;}
      const offline=await cachedFile(cache,artifact),finished=offline?null:await cachedFile(pending,artifact);
      if(offline||finished){sources.set(artifact.name,{path:(offline??finished)!,owned:!offline});onProgress?.({artifact:artifact.name,receivedBytes:artifact.bytes,totalBytes:artifact.bytes});continue;}
      sources.set(artifact.name,{path:await downloadToCache(artifact,pending,signal,onProgress,fetcher),owned:true});
    }
  } catch(error) {
    if(error instanceof AdapterError)throw error;
    throw new AdapterError(signal.aborted?"ARTIFACT_DOWNLOAD_ABORTED":"ARTIFACT_INSTALL_FAILED",{cause:error});
  }
  const stage=target+".install-"+randomUUID();
  await mkdir(stage,{mode:0o700});
  // Linux runtime files must be executable by their owner; nobody else gets access on either platform.
  const mode=process.platform==="win32"?0o600:0o700;
  try {
    for(const artifact of artifacts) {
      const path=inside(stage,artifact.name);await mkdir(dirname(path),{recursive:true});
      await place(sources.get(artifact.name)!.path,path,artifact,sources.get(artifact.name)!.owned);
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

export interface DiskCheck {requiredBytes:number;freeBytes:number|null;sufficient:boolean}
export interface DiskComponent {target:string;artifacts:readonly Artifact[];limits:ZipLimits|null;provided?:ReadonlyMap<string,string>}
/** Free bytes on the volume that holds path (or its nearest existing parent), or null when the platform cannot say. */
export async function freeDiskBytes(path:string):Promise<number|null> {
  for(let current=resolve(path);;) {
    try {const found=await statfs(current);return Number(found.bavail)*Number(found.bsize);}
    catch(error) {
      if(!["ENOENT","ENOTDIR"].includes(errorCode(error)??""))return null;
      const parent=dirname(current);if(parent===current)return null;current=parent;
    }
  }
}
/** What an install still has to write before anything is downloaded: each pinned file that is neither installed nor already in
 * the offline cache (less the part of a partial download kept for resuming), a provided file only when it sits on another
 * volume, the reviewed expansion bound of every runtime archive to unpack, and 256 MiB of headroom. */
export async function installDiskCheck(root:string,components:readonly DiskComponent[]):Promise<DiskCheck> {
  const base=resolve(root),size=async(path:string)=>{try{const found=await lstat(path);return found.isFile()?found.size:-1;}catch{return -1;}};
  let device:number|null=null;
  for(let current=base;;){try{device=(await stat(current)).dev;break;}catch{const parent=dirname(current);if(parent===current)break;current=parent;}}
  let requiredBytes=256*MiB;
  for(const component of components) {
    try {await lstat(component.target);continue;} catch(error) {if(errorCode(error)!=="ENOENT")throw error;}
    for(const artifact of component.artifacts) {
      const given=component.provided?.get(artifact.name);
      if(given!==undefined){if(device===null||(await stat(given)).dev!==device)requiredBytes+=artifact.bytes;continue;}
      const pending=cachePath(join(base,"downloads","pending"),artifact);
      if(await size(cachePath(join(base,"downloads"),artifact))===artifact.bytes||await size(pending)===artifact.bytes)continue;
      requiredBytes+=artifact.bytes-Math.max(0,Math.min(artifact.bytes,await size(pending+".partial")));
    }
    if(component.limits&&component.artifacts.some(item=>isArchive(item.name)))requiredBytes+=component.limits.maxTotalBytes;
  }
  const freeBytes=await freeDiskBytes(base);
  return {requiredBytes,freeBytes,sufficient:freeBytes===null||freeBytes>=requiredBytes};
}
const textComponents=(root:string,modelId:string,backend:Backend):DiskComponent[]=>{
  const spec=textRuntimeSpec(root,backend),entry=catalogEntry(modelId);
  return [{target:spec.directory,artifacts:spec.artifacts,limits:spec.limits},{target:modelDirectory(root,entry.id),artifacts:entry.artifacts,limits:null}];
};
/** Disk preflight for installing a text model and its runtime. */
export const textInstallDiskCheck=(directory:string,modelId:string=DEFAULT_MODEL_ID,backend:Backend="cpu")=>installDiskCheck(directory,textComponents(resolve(directory),modelId,backendOf(backend)));

/** Copies pinned redistributable files from source into an installed runtime folder, checking every source byte first.
 * Files already present with the pinned bytes are kept; returns the names copied. */
export async function copyRedist(target:string,files:readonly RedistFile[],source:string):Promise<string[]> {
  await noLinks(target);await noLinks(resolve(source));
  const copied:string[]=[];
  for(const file of files) {
    const destination=inside(target,file.name);
    try {if(await hashFile(destination,file.bytes)===file.sha256)continue;}catch(error){if(!(error instanceof AdapterError)&&errorCode(error)!=="ENOENT")throw error;}
    const from=inside(resolve(source),file.name);
    let matches=false;try{matches=await hashFile(from,file.bytes)===file.sha256;}catch(error){if(!(error instanceof AdapterError)&&errorCode(error)!=="ENOENT")throw error;}
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
const installSignal=(signal?:AbortSignal)=>signal?AbortSignal.any([signal,AbortSignal.timeout(6*60*60*1000)]):AbortSignal.timeout(6*60*60*1000);
/** Installs a catalog model and its backend runtime after explicit consent, reusing whatever is already verified or cached.
 * Refuses with INSUFFICIENT_DISK_SPACE before downloading when the volume cannot hold what remains to be written. */
export async function installTextAdapter(directory:string,options:{consent:true;modelId?:string;backend?:Backend;redistDirectory?:string;signal?:AbortSignal;onProgress?:(value:InstallProgress)=>void}):Promise<Installation> {
  if(options?.consent!==true)throw new AdapterError("MODEL_INSTALL_CONSENT_REQUIRED");
  const platform=platformOf();
  const root=resolve(directory),entry=catalogEntry(options.modelId??DEFAULT_MODEL_ID),backend=backendOf(options.backend??"cpu");
  const spec=textRuntimeSpec(root,backend);
  await mkdir(root,{recursive:true});await noLinks(root);
  if(!(await installDiskCheck(root,textComponents(root,entry.id,backend))).sufficient)throw new AdapterError("INSUFFICIENT_DISK_SPACE");
  const signal=installSignal(options.signal);
  await installComponent(root,spec.directory,spec.artifacts,spec.limits,()=>verifyRuntimeAt(spec),{backend,platform},signal,options.onProgress);
  if(options.redistDirectory&&platform==="win32-x64")await installRuntimeRedist(root,backend,options.redistDirectory);
  await installComponent(root,modelDirectory(root,entry.id),entry.artifacts,null,()=>verifyModelFiles(root,entry.id,entry.artifacts),{modelId:entry.id,capabilityDigest:entry.capabilityDigest},signal,options.onProgress);
  return verifyInstallation(root,entry.id,backend);
}

/** A local file offered for import that matches no pinned model file. The message names every expected file and hash. */
export class ImportMismatchError extends AdapterError {
  constructor(file:string,bytes:number,sha256:string|null,modelId:string,expected:readonly Artifact[]) {
    super("IMPORT_FILE_MISMATCH");
    this.message=`IMPORT_FILE_MISMATCH: ${file} (${bytes} bytes${sha256?", SHA-256 "+sha256:""}) is not a pinned file of ${modelId}. Expected `+
      expected.map(item=>`${basename(new URL(item.url).pathname)} (${item.bytes} bytes, SHA-256 ${item.sha256})`).join(", ");
  }
}
export interface ImportResult {modelId:string;directory:string;files:{artifact:string;source:string;method:"link"|"copy"|"already_installed"}[];installed:boolean;missing:string[]}
/** Adds model files a supplier already has (for example downloaded with LM Studio or llama.cpp's own tools) to the model store.
 * Every file must match a pinned model file of the entry by size and SHA-256. Once every model file is matched, the model folder
 * is installed from them, hard-linked when the volume allows and copied otherwise, and only its small pinned licence texts are
 * downloaded. The runtime is installed separately with install-model, which then reuses the imported files. */
export async function importModelFiles(directory:string,modelId:string,paths:readonly string[],options:{consent:true;signal?:AbortSignal;onProgress?:(value:InstallProgress)=>void}):Promise<ImportResult> {
  const entry=MODEL_CATALOG.find(item=>item.id===modelId)??MEDIA_CATALOG.find(item=>item.id===modelId);
  if(!entry)throw new AdapterError("UNKNOWN_MODEL");
  return importModelFilesFor(directory,entry,paths,options);
}
/** Internal seam for importModelFiles: the same import for any pinned entry shape (tests use small fixture entries). */
export async function importModelFilesFor(directory:string,entry:{id:string;capabilityDigest:string;artifacts:readonly Artifact[]},paths:readonly string[],
  options:{consent:true;signal?:AbortSignal;onProgress?:(value:InstallProgress)=>void;fetcher?:Fetcher}):Promise<ImportResult> {
  if(options?.consent!==true)throw new AdapterError("MODEL_INSTALL_CONSENT_REQUIRED");
  if(!Array.isArray(paths)||paths.length<1||paths.length>99)throw new AdapterError("INVALID_IMPORT_FILES");
  const root=resolve(directory),target=modelDirectory(root,entry.id),models=entry.artifacts.filter(item=>!item.name.startsWith("licences/"));
  const matched=new Map<string,string>();
  for(const path of paths) {
    let source:string;
    try {source=await realpath(resolve(path));} catch {throw new AdapterError("IMPORT_FILE_NOT_FOUND");}
    const found=await lstat(source);
    if(!found.isFile())throw new AdapterError("IMPORT_FILE_NOT_FOUND");
    const candidates=models.filter(item=>item.bytes===found.size&&!matched.has(item.name));
    if(!candidates.length)throw new ImportMismatchError(basename(source),found.size,null,entry.id,models);
    const digest=await digestFile(source,found.size),match=candidates.find(item=>item.sha256===digest);
    if(!match)throw new ImportMismatchError(basename(source),found.size,digest,entry.id,models);
    matched.set(match.name,source);
  }
  const missing=models.filter(item=>!matched.has(item.name)).map(item=>basename(new URL(item.url).pathname));
  let installed=false;
  try {await lstat(target);installed=true;} catch(error) {if(errorCode(error)!=="ENOENT")throw error;}
  if(installed) {
    await verifyModelFiles(root,entry.id,entry.artifacts);
    return {modelId:entry.id,directory:target,files:[...matched].map(([artifact,source])=>({artifact,source,method:"already_installed" as const})),installed:true,missing:[]};
  }
  if(missing.length)return {modelId:entry.id,directory:target,files:[],installed:false,missing};
  await mkdir(root,{recursive:true});await noLinks(root);
  if(!(await installDiskCheck(root,[{target,artifacts:entry.artifacts,limits:null,provided:matched}])).sufficient)throw new AdapterError("INSUFFICIENT_DISK_SPACE");
  await installComponent(root,target,entry.artifacts,null,()=>verifyModelFiles(root,entry.id,entry.artifacts),
    {modelId:entry.id,capabilityDigest:entry.capabilityDigest,imported:true},installSignal(options.signal),options.onProgress,matched,options.fetcher);
  const files=[];
  for(const [artifact,source] of matched) {
    const [from,to]=await Promise.all([stat(source),stat(inside(target,artifact))]);
    files.push({artifact,source,method:from.ino===to.ino&&from.dev===to.dev&&from.ino!==0?"link" as const:"copy" as const});
  }
  return {modelId:entry.id,directory:target,files,installed:true,missing:[]};
}
