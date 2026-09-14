import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat,mkdir,open,readFile,readdir,rename,rm,writeFile } from "node:fs/promises";
import { dirname,isAbsolute,join,parse,relative,resolve,sep } from "node:path";
import { ARTIFACTS,AdapterError,capabilityDigest } from "./manifest.js";
import { readSafeZip } from "./zip.js";

const hosts=new Set(["github.com","release-assets.githubusercontent.com","raw.githubusercontent.com","huggingface.co","us.aws.cdn.hf.co"]);
type Artifact=(typeof ARTIFACTS)[keyof typeof ARTIFACTS];
export interface InstallProgress { artifact:string; receivedBytes:number; totalBytes:number }
export interface Installation {directory:string;serverPath:string;modelPath:string;capabilityDigest:string}
export function textInstallationPlan(directory:string) {
  if(typeof directory!=="string"||!directory||directory.length>1024)throw new AdapterError("INVALID_INSTALL_DIRECTORY");
  return {directory:resolve(directory),capabilityDigest,backend:"cpu",platform:"win32-x64",artifacts:ARTIFACTS,
    licences:{runtime:"MIT",model:"Apache-2.0"},downloadBytes:Object.values(ARTIFACTS).reduce((sum,a)=>sum+a.bytes,0),
    maxExtractedBytes:256*1024*1024,diskBudgetBytes:1024*1024*1024,requiresExplicitConsent:true};
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
export async function verifyInstallation(directory:string):Promise<Installation> {
  const root=resolve(directory);await noLinks(root);
  try {
    for(const artifact of Object.values(ARTIFACTS))if(await hashFile(inside(root,artifact.name),artifact.bytes)!==artifact.sha256)throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
    const entries=readSafeZip(await readFile(inside(root,ARTIFACTS.runtime.name)));
    const servers=entries.filter(e=>e.name.split("/").at(-1)==="llama-server.exe");
    if(servers.length!==1)throw new AdapterError("RUNTIME_SERVER_MISSING");
    const expectedFiles=new Set(entries.map(e=>e.name.toLowerCase())),expectedDirectories=new Set<string>();
    for(const entry of entries){const parts=entry.name.split("/");for(let n=1;n<parts.length;n++)expectedDirectories.add(parts.slice(0,n).join("/").toLowerCase());}
    async function inspect(relativeDirectory="") {
      for(const entry of await readdir(join(root,"runtime",relativeDirectory),{withFileTypes:true})) {
        const name=(relativeDirectory?relativeDirectory+"/":"")+entry.name;
        if(entry.isSymbolicLink()||(!entry.isFile()&&!entry.isDirectory()))throw new AdapterError("UNEXPECTED_RUNTIME_FILE");
        if(entry.isDirectory()){if(!expectedDirectories.has(name.toLowerCase()))throw new AdapterError("UNEXPECTED_RUNTIME_FILE");await inspect(name);}
        else if(!expectedFiles.has(name.toLowerCase()))throw new AdapterError("UNEXPECTED_RUNTIME_FILE");
      }
    }
    await inspect();
    for(const entry of entries)if(await hashFile(inside(join(root,"runtime"),entry.name),entry.data.length)!==createHash("sha256").update(entry.data).digest("hex"))throw new AdapterError("INSTALLED_ARTIFACT_MISMATCH");
    return {directory:root,serverPath:inside(join(root,"runtime"),servers[0]!.name),modelPath:inside(root,ARTIFACTS.model.name),capabilityDigest};
  } catch(error) {if(error instanceof AdapterError)throw error;throw new AdapterError("ADAPTER_NOT_INSTALLED_OR_CORRUPT");}
}
async function download(artifact:Artifact,path:string,signal:AbortSignal,progress?: (value:InstallProgress)=>void) {
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
      if(received-lastProgress>=8*1024*1024){lastProgress=received;progress?.({artifact:artifact.name,receivedBytes:received,totalBytes:artifact.bytes});}
    }
    if(received!==artifact.bytes||hash.digest("hex")!==artifact.sha256)throw new AdapterError("ARTIFACT_HASH_MISMATCH");
    await file.sync();progress?.({artifact:artifact.name,receivedBytes:received,totalBytes:artifact.bytes});
  } finally {await file.close();}
}
export async function installTextAdapter(directory:string,options:{consent:true;signal?:AbortSignal;onProgress?:(value:InstallProgress)=>void}):Promise<Installation> {
  if(options?.consent!==true)throw new AdapterError("MODEL_INSTALL_CONSENT_REQUIRED");
  if(process.platform!=="win32"||process.arch!=="x64")throw new AdapterError("UNSUPPORTED_ADAPTER_PLATFORM");
  const root=resolve(directory);await noLinks(root);
  try {await lstat(root);return await verifyInstallation(root);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await mkdir(dirname(root),{recursive:true});await noLinks(dirname(root));
  const stage=root+".install-"+randomUUID();
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(30*60*1000)]):AbortSignal.timeout(30*60*1000);
  await mkdir(stage,{mode:0o700});
  try {
    for(const artifact of Object.values(ARTIFACTS)) {
      const path=inside(stage,artifact.name);await mkdir(dirname(path),{recursive:true});
      await download(artifact,path,signal,options.onProgress);
    }
    const entries=readSafeZip(await readFile(inside(stage,ARTIFACTS.runtime.name)));
    for(const entry of entries){const path=inside(join(stage,"runtime"),entry.name);await mkdir(dirname(path),{recursive:true});await writeFile(path,entry.data,{flag:"wx",mode:0o600});}
    await writeFile(inside(stage,"install.json"),JSON.stringify({version:1,capabilityDigest,installedAt:new Date().toISOString(),artifacts:ARTIFACTS},null,2)+"\n",{flag:"wx",mode:0o600});
    await verifyInstallation(stage);signal.throwIfAborted();await noLinks(root);await rename(stage,root);
    return await verifyInstallation(root);
  } catch(error) {
    // Only the fresh random staging sibling is ever recursively removed.
    if(dirname(stage)===dirname(root)&&stage.startsWith(root+".install-")&&relative(dirname(root),stage)!=="")await rm(stage,{recursive:true,force:true});
    if(error instanceof AdapterError)throw error;
    throw new AdapterError(signal.aborted?"ARTIFACT_DOWNLOAD_ABORTED":"ARTIFACT_INSTALL_FAILED");
  }
}
