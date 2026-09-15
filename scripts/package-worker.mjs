import {cp,mkdir,rm,readdir,readFile,writeFile,copyFile,stat,mkdtemp} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join,resolve,relative,sep} from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

// Builds the supplier worker package for Windows x64 (default) or Linux x64 (--platform linux-x64): a Node runtime,
// the compiled worker and only its runtime dependencies, a launcher, onboarding notes and SHA-256 sums.
// Run `npm.cmd run build` first. The Windows package bundles the Node running this script; the Linux package uses the
// pinned official Node tarball below, downloaded once into .cache/node and checked against its SHA-256.
const root=fileURLToPath(new URL("../",import.meta.url));
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const platform=option("--platform")??"win32-x64";
if(!["win32-x64","linux-x64"].includes(platform))throw new Error("PACKAGE_PLATFORM_UNSUPPORTED "+platform);
const linux=platform==="linux-x64";
const out=resolve(option("--out")??join(root,".cache","package")),zip=!args.includes("--no-zip"),nodeLicense=option("--node-license");
if(!linux&&(process.platform!=="win32"||process.arch!=="x64"))throw new Error("PACKAGE_REQUIRES_WINDOWS_X64");
if(!/^v24\./.test(process.version))throw new Error("PACKAGE_REQUIRES_NODE_24");
const LINUX_NODE={version:"v24.11.1",file:"node-v24.11.1-linux-x64.tar.gz",sha256:"58a5ff5cc8f2200e458bea22e329d5c1994aa1b111d499ca46ec2411d58239ca"};
const tarTool=process.platform==="win32"?join(process.env.SystemRoot??"C:\\Windows","System32","tar.exe"):"tar";
const version=JSON.parse(await readFile(join(root,"apps/worker/package.json"),"utf8")).version;
const name=`excess-worker-${version}-${linux?"linux-x64":"win-x64"}`,stage=join(out,name);
const skip=path=>/\.(map|tsbuildinfo)$/.test(path)||/\.d\.(ts|cts|mts)$/.test(path)||(/\.(ts|cts|mts)$/.test(path)&&!/\.d\./.test(path));
const copyTree=(from,to)=>cp(from,to,{recursive:true,filter:source=>!skip(source)});
for(const required of ["apps/worker/dist/main.js","packages/adapters/dist/index.js","packages/protocol/dist/index.js","node_modules/zod/package.json"])
  await stat(join(root,required)).catch(()=>{throw new Error("PACKAGE_INPUT_MISSING "+required+" (run npm.cmd run build)");});
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");

await rm(stage,{recursive:true,force:true});
await mkdir(join(stage,"licenses"),{recursive:true});
let nodeVersion=process.version,nodeLicenseIncluded=false;
if(linux) {
  const cacheDir=join(root,".cache","node"),archive=join(cacheDir,LINUX_NODE.file);
  await mkdir(cacheDir,{recursive:true});
  let bytes=await readFile(archive).catch(()=>null);
  if(!bytes||sha256(bytes)!==LINUX_NODE.sha256){
    const response=await fetch(`https://nodejs.org/dist/${LINUX_NODE.version}/${LINUX_NODE.file}`,{redirect:"error"});
    if(!response.ok)throw new Error("PACKAGE_NODE_DOWNLOAD_FAILED "+response.status);
    bytes=Buffer.from(await response.arrayBuffer());
    if(sha256(bytes)!==LINUX_NODE.sha256)throw new Error("PACKAGE_NODE_HASH_MISMATCH");
    await writeFile(archive,bytes);
  }
  const unpack=await mkdtemp(join(cacheDir,"unpack-"));
  try{
    const top=LINUX_NODE.file.replace(/\.tar\.gz$/,"");
    execFileSync(tarTool,["-xzf",archive,"-C",unpack,`${top}/bin/node`,`${top}/LICENSE`],{stdio:["ignore","ignore","pipe"]});
    await mkdir(join(stage,"node","bin"),{recursive:true});
    await copyFile(join(unpack,top,"bin","node"),join(stage,"node","bin","node"));
    await copyFile(join(unpack,top,"LICENSE"),join(stage,"licenses","node-LICENSE.txt"));
  }finally{await rm(unpack,{recursive:true,force:true});}
  nodeVersion=LINUX_NODE.version;nodeLicenseIncluded=true;
} else {
  await mkdir(join(stage,"node"),{recursive:true});
  await copyFile(process.execPath,join(stage,"node","node.exe"));
  if(nodeLicense){await copyFile(resolve(nodeLicense),join(stage,"licenses","node-LICENSE.txt"));nodeLicenseIncluded=true;}
}
await mkdir(join(stage,"app","worker"),{recursive:true});
await copyFile(join(root,"apps/worker/package.json"),join(stage,"app","worker","package.json"));
await copyTree(join(root,"apps/worker/dist"),join(stage,"app","worker","dist"));
for(const pkg of ["adapters","protocol"]){
  const target=join(stage,"app","node_modules","@excess",pkg);
  await mkdir(target,{recursive:true});
  await copyFile(join(root,"packages",pkg,"package.json"),join(target,"package.json"));
  await copyTree(join(root,"packages",pkg,"dist"),join(target,"dist"));
}
await copyTree(join(root,"node_modules","zod"),join(stage,"app","node_modules","zod"));
if(!linux){
  // The Visual C++ runtime files llama.cpp needs, copied from this build machine and checked against the adapter's pins.
  const {RUNTIME_REDIST}=await import(new URL("../packages/adapters/dist/manifest.js",import.meta.url).href);
  await mkdir(join(stage,"redist"),{recursive:true});
  for(const file of RUNTIME_REDIST){
    const bytes=await readFile(join(process.env.SystemRoot??"C:\\Windows","System32",file.name));
    if(bytes.length!==file.bytes||sha256(bytes)!==file.sha256)throw new Error("PACKAGE_REDIST_MISMATCH "+file.name+" (install the pinned Visual C++ Redistributable 14.51.36247.0)");
    await writeFile(join(stage,"redist",file.name),bytes);
  }
}

if(linux){
  await writeFile(join(stage,"excess-worker"),[
    "#!/bin/sh","set -eu",
    "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
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
    "if not defined EXCESS_REDIST_DIR set \"EXCESS_REDIST_DIR=%~dp0redist\"",
    "\"%~dp0node\\node.exe\" \"%~dp0app\\worker\\dist\\main.js\" %*","exit /b %ERRORLEVEL%",""].join("\r\n"));
}
const cli=linux?"sh excess-worker":"excess-worker";
const newline=linux?"\n":"\r\n";
await writeFile(join(stage,"ONBOARDING.txt"),[
  `EXCESS supplier worker (${linux?"Linux x64":"Windows x64"})`,"",
  "Earn by running AI text jobs on this computer. Jobs run locally, and you can see their prompts and outputs.","",
  linux?"In a terminal in this folder, then:":"Open Command Prompt in this folder, then:",
  `  1. ${cli} guide                      shows your next step at any time`,
  `  2. ${cli} pair https://<exchange> "My PC"   then approve the printed code in the web app (Supplier, Pair a device)`,
  `  3. ${cli} complete-pairing`,
  `  4. ${cli} models                     see which models this computer can run`,
  `     ${cli} use qwen3-8b --gpu         choose one (--gpu uses ${linux?"Vulkan; install your GPU driver and libvulkan1":"an NVIDIA GPU through CUDA"}; omit it to run on the CPU)`,
  `  5. ${cli} install-model --accept-download --accept-licenses   downloads the chosen model (2.5 to 19 GB)`,
  `  6. ${cli} offer USDG <price per million output tokens>`,
  `  7. ${cli} run                        keep it running to receive jobs${linux?" (for example under systemd)":""}`,
  "",`Stop: ${cli} drain (finish current work) or ${cli} stop-now. Status: ${cli} status.`,
  linux?"Data lives in ~/.local/share/excess. The device key is stored in a file readable only by your user and cannot move your wallet's funds."
    :"Data lives in %LOCALAPPDATA%\\EXCESS. The device key is protected with Windows DPAPI for your user and cannot move your wallet's funds.",
  "Earnings appear in the web app and become withdrawable after the review window. Withdrawals go to your paired wallet.",""].join(newline));
await copyFile(join(root,"node_modules/zod/LICENSE"),join(stage,"licenses","zod-LICENSE.txt")).catch(()=>{});
await writeFile(join(stage,"licenses","NOTICE.txt"),[
  `Bundles Node.js ${nodeVersion} (MIT and bundled third-party licences): https://github.com/nodejs/node/blob/${nodeVersion}/LICENSE`,
  "Bundles zod (MIT). The model runtime (llama.cpp, MIT) and models (Apache-2.0) are downloaded only after explicit consent.",
  nodeLicenseIncluded?"The full Node.js licence text is included in node-LICENSE.txt.":"NOT FOR PUBLIC DISTRIBUTION: the full Node.js licence text was not included (build with --node-license).",""].join(newline));

let commit="unknown";
try{commit=execFileSync("git",["-c","safe.directory="+root.replaceAll("\\","/").replace(/\/$/,""),"rev-parse","HEAD"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();}catch{}
await writeFile(join(stage,"manifest.json"),JSON.stringify({product:"EXCESS",package:"worker",version,platform,node:nodeVersion,sourceCommit:commit,
  publicDistributionReady:nodeLicenseIncluded,codeSigned:false,builtAt:new Date().toISOString()},null,2)+"\n");

async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory())result.push(...await files(path));else result.push(path);}return result;}
const sums=[];
for(const file of (await files(stage)).sort()){
  const rel=relative(stage,file).split(sep).join("/");
  if(rel==="SHA256SUMS.txt")continue;
  sums.push(sha256(await readFile(file))+"  "+rel);
}
await writeFile(join(stage,"SHA256SUMS.txt"),sums.join("\n")+"\n");
let archive=null;
if(zip){
  const path=join(out,name+(linux?".tar.gz":".zip"));await rm(path,{force:true});
  execFileSync(tarTool,linux?["-czf",path,"-C",out,name]:["-a","-c","-f",path,"-C",out,name],{stdio:["ignore","ignore","pipe"]});
  archive={path,sha256:sha256(await readFile(path)),bytes:(await stat(path)).size};
}
process.stdout.write(JSON.stringify({product:"EXCESS",package:name,platform,directory:stage,files:sums.length,archive,publicDistributionReady:nodeLicenseIncluded})+"\n");
