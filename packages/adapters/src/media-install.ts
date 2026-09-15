import { mkdir } from "node:fs/promises";
import { join,resolve } from "node:path";
import { AdapterError,RUNTIME_REDIST,SD_RUNTIME_REDIST,currentPlatform,mediaCatalogEntry,runtimeArtifacts,sdRuntimeArtifacts,sdServerExecutable,serverExecutable,
  type Backend,type MediaModelEntry,type MediaRuntime,type Platform } from "./manifest.js";
import { backendOf,copyRedist,hashFile,inside,installComponent,limitsFor,modelDirectory,noLinks,platformOf,runtimeDirectory,verifyRuntimeAt,type InstallProgress,type RuntimeSpec } from "./install.js";
import { DEFAULT_ZIP_LIMITS,type ZipLimits } from "./zip.js";
import type { MediaKind } from "@excess/protocol";

const MiB=1024*1024,GiB=1024*MiB;
// Reviewed bounds for the stable-diffusion.cpp master-869 zips. The CPU and Vulkan builds were unpacked and inspected on
// 15 September 2026: flat archives of regular files (the Linux builds store versioned .so names as copies, not links).
const SD_ARCHIVE_LIMITS:Readonly<Record<Platform,Partial<Record<Backend,ZipLimits>>>>={
  "win32-x64":{cpu:DEFAULT_ZIP_LIMITS,cuda:{maxInputBytes:768*MiB,maxTotalBytes:4*GiB,maxEntryBytes:2*GiB}},
  "linux-x64":{cpu:{maxInputBytes:64*MiB,maxTotalBytes:512*MiB,maxEntryBytes:128*MiB},vulkan:{maxInputBytes:64*MiB,maxTotalBytes:512*MiB,maxEntryBytes:128*MiB}},
};
export interface MediaInstallation {directory:string;serverPath:string;files:Readonly<Record<string,string>>;capabilityDigest:string;modelId:string;kind:MediaKind;runtime:MediaRuntime;backend:Backend}
export const sdRuntimeDirectory=(root:string,backend:Backend)=>join(resolve(root),"sd-runtimes",backend);

function selected(modelId:string,backend:unknown):{entry:MediaModelEntry;backend:Backend} {
  const entry=mediaCatalogEntry(modelId),chosen=backendOf(backend);
  if(entry.gpuOnly&&chosen==="cpu")throw new AdapterError("MODEL_REQUIRES_GPU");
  return {entry,backend:chosen};
}
/** llama.cpp media models share the text runtime folder; image models use a separate stable-diffusion.cpp folder. */
export function mediaRuntimeSpec(root:string,entry:MediaModelEntry,backend:Backend,platform:Platform):RuntimeSpec {
  if(entry.runtime==="llama.cpp")return {directory:runtimeDirectory(root,backend),artifacts:runtimeArtifacts(backend,platform),server:serverExecutable(platform),limits:limitsFor(platform,backend),redist:RUNTIME_REDIST,platform};
  const limits=SD_ARCHIVE_LIMITS[platform][backend];
  if(!limits)throw new AdapterError("BACKEND_UNSUPPORTED_ON_PLATFORM");
  return {directory:sdRuntimeDirectory(root,backend),artifacts:sdRuntimeArtifacts(backend,platform),server:sdServerExecutable(platform),limits,redist:SD_RUNTIME_REDIST,platform};
}
/** The running process's glibc version on Linux ("2.35"), or null elsewhere or when unknown. */
export function runtimeGlibcVersion():string|null {
  const header=(process.report?.getReport() as {header?:{glibcVersionRuntime?:unknown}}|undefined)?.header;
  return typeof header?.glibcVersionRuntime==="string"?header.glibcVersionRuntime:null;
}
/** Whether a glibc version string is at least major.minor; an unknown version is treated as too old. */
export function glibcAtLeast(version:string|null,major:number,minor:number):boolean {
  const match=/^(\d+)\.(\d+)/.exec(version??"");
  if(!match)return false;
  const [have,haveMinor]=[Number(match[1]),Number(match[2])];
  return have>major||(have===major&&haveMinor>=minor);
}
/** What installing one media model on one backend downloads on this platform (the shared runtime plus the model files). */
export function mediaInstallationPlan(directory:string,modelId:string,backend:Backend="cpu") {
  if(typeof directory!=="string"||!directory||directory.length>1024)throw new AdapterError("INVALID_INSTALL_DIRECTORY");
  const platform=currentPlatform()??"win32-x64",{entry,backend:chosen}=selected(modelId,backend),spec=mediaRuntimeSpec(directory,entry,chosen,platform);
  const artifacts=[...spec.artifacts,...entry.artifacts],downloadBytes=artifacts.reduce((sum,artifact)=>sum+artifact.bytes,0);
  return {directory:resolve(directory),modelId:entry.id,kind:entry.kind,backend:chosen,capabilityDigest:entry.capabilityDigest,platform,runtime:entry.runtime,
    model:{displayName:entry.displayName,parameters:entry.parameters,quantization:entry.quantization,minMemoryMb:entry.minMemoryMb,minVramMb:entry.minVramMb,gpuOnly:entry.gpuOnly},
    artifacts,licences:{runtime:"MIT",model:String(entry.capability.modelLicence)},downloadBytes,
    diskBudgetBytes:downloadBytes+spec.limits.maxTotalBytes,requiresExplicitConsent:true};
}
async function verifyMediaModel(root:string,entry:MediaModelEntry):Promise<Record<string,string>> {
  const directory=modelDirectory(root,entry.id);await noLinks(directory);
  const files:Record<string,string>={};
  for(const artifact of entry.artifacts) {
    const path=inside(directory,artifact.name);
    if(await hashFile(path,artifact.bytes)!==artifact.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
    files[artifact.name]=path;
  }
  return Object.freeze(files);
}
/** Re-verifies every pinned file of a media model and its runtime, including each extracted runtime file. */
export async function verifyMediaInstallation(directory:string,modelId:string,backend:Backend="cpu"):Promise<MediaInstallation> {
  const root=resolve(directory),{entry,backend:chosen}=selected(modelId,backend);await noLinks(root);
  try {
    const serverPath=await verifyRuntimeAt(mediaRuntimeSpec(root,entry,chosen,platformOf())),files=await verifyMediaModel(root,entry);
    return {directory:root,serverPath,files,capabilityDigest:entry.capabilityDigest,modelId:entry.id,kind:entry.kind,runtime:entry.runtime,backend:chosen};
  } catch(error) {if(error instanceof AdapterError)throw error;throw new AdapterError("ADAPTER_NOT_INSTALLED_OR_CORRUPT");}
}
/** Installs a media model and its runtime after explicit consent, reusing whatever is already verified. GPU-only models
 * are refused on the CPU backend before anything is downloaded. */
export async function installMediaModel(directory:string,options:{consent:true;modelId:string;backend?:Backend;redistDirectory?:string;signal?:AbortSignal;onProgress?:(value:InstallProgress)=>void}):Promise<MediaInstallation> {
  if(options?.consent!==true)throw new AdapterError("MODEL_INSTALL_CONSENT_REQUIRED");
  const {entry,backend}=selected(options.modelId,options.backend??"cpu"),platform=platformOf(),root=resolve(directory);
  const spec=mediaRuntimeSpec(root,entry,backend,platform);
  // The pinned stable-diffusion.cpp Linux build links against glibc 2.38 (Ubuntu 24.04 or newer); refuse before any download.
  if(entry.runtime==="stable-diffusion.cpp"&&platform==="linux-x64"&&!glibcAtLeast(runtimeGlibcVersion(),2,38))throw new AdapterError("SD_RUNTIME_NEEDS_GLIBC_2_38");
  await mkdir(root,{recursive:true});await noLinks(root);
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(6*60*60*1000)]):AbortSignal.timeout(6*60*60*1000);
  await installComponent(root,spec.directory,spec.artifacts,spec.limits,()=>verifyRuntimeAt(spec),{backend,platform,runtime:entry.runtime},signal,options.onProgress);
  if(options.redistDirectory&&platform==="win32-x64")await copyRedist(join(spec.directory,"runtime"),spec.redist,options.redistDirectory);
  await installComponent(root,modelDirectory(root,entry.id),entry.artifacts,null,()=>verifyMediaModel(root,entry),{modelId:entry.id,kind:entry.kind,capabilityDigest:entry.capabilityDigest},signal,options.onProgress);
  return verifyMediaInstallation(root,entry.id,backend);
}
