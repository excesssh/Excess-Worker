import {cp,mkdir,rm,readdir,readFile,writeFile,copyFile,stat,lstat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join,resolve,relative,sep} from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {nodeRuntime} from "./public-worker/node-runtime.mjs";
import {archiveDirectory} from "./public-worker/archive.mjs";
import {assertPublicBytes} from "./public-worker/privacy.mjs";

// Builds the supplier worker package for Windows x64 (default) or Linux x64 (--platform linux-x64): a Node runtime,
// the compiled worker and only its runtime dependencies, a launcher, onboarding notes and SHA-256 sums.
// Run `npm.cmd run build` first. Both packages use official pinned Node archives.
const root=fileURLToPath(new URL("../",import.meta.url));
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const platform=option("--platform")??"win32-x64";
if(!["win32-x64","linux-x64"].includes(platform))throw new Error("PACKAGE_PLATFORM_UNSUPPORTED "+platform);
const linux=platform==="linux-x64";
const out=resolve(option("--out")??join(root,".cache","package")),zip=!args.includes("--no-zip"),nodeLicense=option("--node-license");
if(!linux&&(process.platform!=="win32"||process.arch!=="x64"))throw new Error("PACKAGE_REQUIRES_WINDOWS_X64");
if(process.version!=="v24.11.1")throw new Error("PACKAGE_REQUIRES_PINNED_NODE_24_11_1");
const version=JSON.parse(await readFile(join(root,"apps/worker/package.json"),"utf8")).version;
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))throw Error("PACKAGE_VERSION_INVALID");
const releaseSequence=Number(process.env.EXCESS_RELEASE_SEQUENCE??1);
if(!Number.isSafeInteger(releaseSequence)||releaseSequence<1)throw Error("RELEASE_SEQUENCE_INVALID");
let sourceEpoch;
try{sourceEpoch=Number(execFileSync("git",["-c","safe.directory="+root.replaceAll("\\","/").replace(/\/$/,""),"show","-s","--format=%ct","HEAD"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim());}catch{}
const epoch=Number(process.env.SOURCE_DATE_EPOCH??sourceEpoch);
if(!Number.isSafeInteger(epoch)||epoch<315532800)throw Error("SOURCE_DATE_EPOCH_REQUIRED");
const name=`excess-worker-${version}-${linux?"linux-x64":"win-x64"}`,stage=join(out,name);
const skip=path=>/\.(map|tsbuildinfo)$/.test(path)||/\.d\.(ts|cts|mts)$/.test(path)||(/\.(ts|cts|mts)$/.test(path)&&!/\.d\./.test(path));
const copyTree=(from,to)=>cp(from,to,{recursive:true,filter:async source=>{
  if(skip(source))return false;
  assertPublicBytes(Buffer.from(relative(root,source)));
  const info=await stat(source);if(info.isFile())assertPublicBytes(await readFile(source));
  return true;
}});
const safeCopy=async(from,to)=>{const bytes=await readFile(from);assertPublicBytes(bytes);await writeFile(to,bytes);};

for(const required of ["apps/worker/dist/main.js","packages/adapters/dist/index.js","packages/protocol/dist/index.js","node_modules/zod/package.json"])
  await stat(join(root,required)).catch(()=>{throw new Error("PACKAGE_INPUT_MISSING "+required+" (run npm.cmd run build)");});
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");

async function noLinks(path){
  const absolute=resolve(path),parts=absolute.split(sep);let current=parts.shift()+sep;
  for(const part of parts){if(!part)continue;current=join(current,part);
    const info=await lstat(current).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
    if(info?.isSymbolicLink())throw Error("PACKAGE_LINK_DENIED");
  }
}
const nativeRoot=resolve(option("--native-dir")??join(root,"packages","adapters","native"));
const helperFile=linux?"excess-sandbox":"ExcessSandbox.exe",pinFile=linux?"integrity.json":"integrity-win32.json";
const expectedProfile=linux?"linux-landlock-v1":"windows-appcontainer-v1";
let native;
await noLinks(nativeRoot);
const helperInfo=await lstat(join(nativeRoot,helperFile)).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
if(helperInfo){
  await noLinks(join(nativeRoot,helperFile));await noLinks(join(nativeRoot,pinFile));
  if(!helperInfo.isFile())throw Error("RUNTIME_SANDBOX_INPUT_INVALID");
  const helper=await readFile(join(nativeRoot,helperFile)),pinBytes=await readFile(join(nativeRoot,pinFile));
  assertPublicBytes(helper);assertPublicBytes(pinBytes);
  const pin=JSON.parse(pinBytes.toString("utf8")),hash=sha256(helper);
  if(pin.profile!==expectedProfile||pin.sha256!==hash)throw Error("RUNTIME_SANDBOX_INTEGRITY_INVALID");
  native={helper,pinBytes,profile:expectedProfile,sha256:hash};
}else if(linux||args.includes("--require-native"))throw Error("RUNTIME_SANDBOX_BUILD_REQUIRED");

if(resolve(stage)===out||relative(out,stage)!==name)throw Error("PACKAGE_OUTPUT_BOUNDARY_INVALID");
await noLinks(stage);
await rm(stage,{recursive:true,force:true});
await mkdir(join(stage,"licenses"),{recursive:true});
const pinnedNode=await nodeRuntime(root,platform);
const nodeVersion=pinnedNode.version,nodeLicenseIncluded=true;
await mkdir(join(stage,"node",...(linux?["bin"]:[])),{recursive:true});
await writeFile(join(stage,"node",...(linux?["bin","node"]:["node.exe"])),pinnedNode.binary);
await writeFile(join(stage,"licenses","node-LICENSE.txt"),pinnedNode.license);
if(nodeLicense)await safeCopy(resolve(nodeLicense),join(stage,"licenses","node-LICENSE.txt"));

await mkdir(join(stage,"app","worker"),{recursive:true});
await safeCopy(join(root,"apps/worker/package.json"),join(stage,"app","worker","package.json"));
await copyTree(join(root,"apps/worker/dist"),join(stage,"app","worker","dist"));
for(const pkg of ["adapters","protocol"]){
  const target=join(stage,"app","node_modules","@excess",pkg);
  await mkdir(target,{recursive:true});
  await safeCopy(join(root,"packages",pkg,"package.json"),join(target,"package.json"));
  await copyTree(join(root,"packages",pkg,"dist"),join(target,"dist"));
  if(pkg==="adapters"&&native){
    await mkdir(join(target,"native"),{recursive:true});
    await writeFile(join(target,"native",helperFile),native.helper);
    await writeFile(join(target,"native",pinFile),native.pinBytes);
  }
}
await copyTree(join(root,"node_modules","zod"),join(stage,"app","node_modules","zod"));
// Windows model installation verifies the pinned system Visual C++ redistributable.
// Its separately licensed files are not redistributed in this package.

if(linux){
  await writeFile(join(stage,"excess-worker"),[
    "#!/bin/sh","set -eu",
    "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    // systemd and other supervisors start services with no HOME; resolve it from the passwd entry so `set -u` cannot abort.
    ": \"${HOME:=$(getent passwd \"$(id -u)\" 2>/dev/null | cut -d: -f6)}\"",
    "[ -n \"$HOME\" ] || HOME=/tmp","export HOME",
    "DATA=${XDG_DATA_HOME:-$HOME/.local/share}/excess",
    ": \"${EXCESS_WORKER_HOME:=$DATA/worker}\"",": \"${EXCESS_MODEL_DIR:=$DATA/ai}\"","export EXCESS_WORKER_HOME EXCESS_MODEL_DIR",
    // Archives built on Windows carry no executable bits; restore them for the bundled Node only.
    "[ -x \"$DIR/node/bin/node\" ] || chmod u+x \"$DIR/node/bin/node\"",
    "exec \"$DIR/node/bin/node\" \"$DIR/app/worker/dist/main.js\" \"$@\"",""].join("\n"));
} else {
  await writeFile(join(stage,"excess-worker.cmd"),[
    "@echo off","setlocal",
    "if not defined EXCESS_WORKER_HOME set \"EXCESS_WORKER_HOME=%LOCALAPPDATA%\\EXCESS\\worker\"",
    "if not defined EXCESS_MODEL_DIR set \"EXCESS_MODEL_DIR=%LOCALAPPDATA%\\EXCESS\\ai\"",
    "\"%~dp0node\\node.exe\" \"%~dp0app\\worker\\dist\\main.js\" %*","exit /b %ERRORLEVEL%",""].join("\r\n"));
}
const cli=linux?"sh excess-worker":"excess-worker";
const newline=linux?"\n":"\r\n";
await writeFile(join(stage,"ONBOARDING.txt"),[
  `Excess Worker local candidate (${linux?"Linux x64":"Windows x64"})`,"",
  "UNRELEASED: isolated CPU/GPU execution has not passed the release gates. Model execution fails closed on unsupported isolation profiles.","",
  "Earn by running AI jobs on this computer: text answers, embeddings, speech-to-text or images. Jobs run locally, and you can see their inputs and outputs.","",
  linux?"In a terminal in this folder, then:":"Open Command Prompt in this folder, then:",
  `  1. ${cli} guide                      shows your next step at any time`,
  `  2. ${cli} pair https://<exchange> "My PC"   then approve the printed code in the web app (Supplier, Pair a device)`,
  `  3. ${cli} complete-pairing`,
  `  4. ${cli} models                     see every model (text, embedding, transcription, image) and whether this computer fits it`,
  `     ${cli} use qwen3-8b --gpu         choose one (--gpu uses ${linux?"Vulkan; install your GPU driver and libvulkan1":"an NVIDIA GPU through CUDA"}; omit it to run on the CPU; flux1-schnell is GPU-only)`,
  `  5. ${cli} install-model --accept-download --accept-licenses   downloads the chosen model (0.6 to 64 GB; checks free disk first)`,
  `     ${cli} import <model id> <file.gguf ...> --accept-licenses   already have the exact GGUF (LM Studio, llama.cpp)? use it instead of downloading`,
  `  6. ${cli} offer USDG <price>          per million output tokens (text), million input tokens (embedding), audio hour (transcription) or image`,
  `  7. ${cli} run                        keep it running to receive jobs${linux?" (for example under systemd)":""}`,
  "",`Stop: ${cli} drain (finish current work) or ${cli} stop-now. Status: ${cli} status.`,
  linux?"Data lives in ~/.local/share/excess. The device key is stored in a file readable only by your user and cannot move your wallet's funds."
    :"Data lives in %LOCALAPPDATA%\\EXCESS. The device key is protected with Windows DPAPI for your user and cannot move your wallet's funds.",
  "Earnings appear in the web app once each job settles and can be withdrawn from there. Withdrawals go to your paired wallet.",""].join(newline));
await safeCopy(join(root,"node_modules/zod/LICENSE"),join(stage,"licenses","zod-LICENSE.txt"));
const projectLicense=await readFile(join(root,"LICENSE")).catch(()=>readFile(join(root,"releases","WORKER-LICENSE.txt")));
assertPublicBytes(projectLicense);await writeFile(join(stage,"licenses","excess-worker-LICENSE.txt"),projectLicense);
await writeFile(join(stage,"licenses","NOTICE.txt"),[
  `Bundles Node.js ${nodeVersion} (MIT and bundled third-party licences): https://github.com/nodejs/node/blob/${nodeVersion}/LICENSE`,
  "Bundles zod (MIT). The model runtimes (llama.cpp and stable-diffusion.cpp, MIT) and models (each under its own listed licence) are downloaded only after explicit consent.",
  nodeLicenseIncluded?"The full Node.js licence text is included in node-LICENSE.txt.":"NOT FOR PUBLIC DISTRIBUTION: the full Node.js licence text was not included (build with --node-license).",""].join(newline));

let commit="unknown";
try{commit=execFileSync("git",["-c","safe.directory="+root.replaceAll("\\","/").replace(/\/$/,""),"rev-parse","HEAD"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();}catch{}
await writeFile(join(stage,"manifest.json"),JSON.stringify({product:"EXCESS",package:"worker",version,platform,node:nodeVersion,sourceCommit:commit,
  releaseSequence,licensesIncluded:nodeLicenseIncluded,publicDistributionReady:false,releaseGate:"isolated-hardware-execution-pending",codeSigned:false,
  execution:{profile:native?.profile??"unavailable",cpuVerified:false,gpuVerified:false},
  ...(native?{native:{profile:native.profile,file:"app/node_modules/@excess/adapters/native/"+helperFile,sha256:native.sha256}}:{}),
  builtAt:new Date(epoch*1000).toISOString()},null,2)+"\n");

async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory())result.push(...await files(path));else result.push(path);}return result;}
const sums=[];
for(const file of (await files(stage)).sort()){
  const rel=relative(stage,file).split(sep).join("/");
  if(rel==="SHA256SUMS.txt")continue;
  const bytes=await readFile(file);assertPublicBytes(Buffer.from(rel));assertPublicBytes(bytes);
  sums.push(sha256(bytes)+"  "+rel);
}
await writeFile(join(stage,"SHA256SUMS.txt"),sums.join("\n")+"\n");
let archive=null;
if(zip){
  const path=join(out,name+(linux?".tar.gz":".zip"));await rm(path,{force:true});
  await archiveDirectory(stage,name,path,platform,epoch);
  archive={path,sha256:sha256(await readFile(path)),bytes:(await stat(path)).size};
}
process.stdout.write(JSON.stringify({product:"EXCESS",package:name,platform,directory:stage,files:sums.length,archive,licensesIncluded:nodeLicenseIncluded,publicDistributionReady:false})+"\n");
