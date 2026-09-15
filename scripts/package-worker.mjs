import {cp,mkdir,rm,readdir,readFile,writeFile,copyFile,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join,resolve,relative,sep} from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

// Builds the Windows x64 supplier worker package: the pinned Node runtime running this script,
// the compiled worker and only its runtime dependencies, a launcher, onboarding notes and
// SHA-256 sums. Run `npm.cmd run build` first. It never downloads anything.
const root=fileURLToPath(new URL("../",import.meta.url));
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const out=resolve(option("--out")??join(root,".cache","package")),zip=!args.includes("--no-zip"),nodeLicense=option("--node-license");
if(process.platform!=="win32"||process.arch!=="x64")throw new Error("PACKAGE_REQUIRES_WINDOWS_X64");
if(!/^v24\./.test(process.version))throw new Error("PACKAGE_REQUIRES_NODE_24");
const version=JSON.parse(await readFile(join(root,"apps/worker/package.json"),"utf8")).version;
const name=`excess-worker-${version}-win-x64`,stage=join(out,name);
const skip=path=>/\.(map|tsbuildinfo)$/.test(path)||/\.d\.(ts|cts|mts)$/.test(path)||(/\.(ts|cts|mts)$/.test(path)&&!/\.d\./.test(path));
const copyTree=(from,to)=>cp(from,to,{recursive:true,filter:source=>!skip(source)});
for(const required of ["apps/worker/dist/main.js","packages/adapters/dist/index.js","packages/protocol/dist/index.js","node_modules/zod/package.json"])
  await stat(join(root,required)).catch(()=>{throw new Error("PACKAGE_INPUT_MISSING "+required+" (run npm.cmd run build)");});

await rm(stage,{recursive:true,force:true});
await mkdir(join(stage,"node"),{recursive:true});
await copyFile(process.execPath,join(stage,"node","node.exe"));
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

await writeFile(join(stage,"excess-worker.cmd"),[
  "@echo off","setlocal",
  "if not defined EXCESS_WORKER_HOME set \"EXCESS_WORKER_HOME=%LOCALAPPDATA%\\EXCESS\\worker\"",
  "if not defined EXCESS_MODEL_DIR set \"EXCESS_MODEL_DIR=%LOCALAPPDATA%\\EXCESS\\ai\"",
  "\"%~dp0node\\node.exe\" \"%~dp0app\\worker\\dist\\main.js\" %*","exit /b %ERRORLEVEL%",""].join("\r\n"));
await writeFile(join(stage,"ONBOARDING.txt"),[
  "EXCESS supplier worker (Windows x64, CPU)","",
  "Earn by running AI text jobs on this computer. Jobs run locally, and you can see their prompts and outputs.","",
  "Open Command Prompt in this folder, then:",
  "  1. excess-worker guide                      shows your next step at any time",
  "  2. excess-worker pair https://<exchange> \"My PC\"   then approve the printed code in the web app (Supplier, Pair a device)",
  "  3. excess-worker complete-pairing",
  "  4. excess-worker models                     see which models this computer can run (CPU or NVIDIA GPU)",
  "     excess-worker use qwen3-8b --gpu         choose one (omit --gpu to run on the CPU)",
  "  5. excess-worker install-model --accept-download --accept-licenses   downloads the chosen model (2.5 to 19 GB)",
  "  6. excess-worker offer USDG <price per million output tokens>",
  "  7. excess-worker run                        keep this window open to receive jobs",
  "","Stop: excess-worker drain (finish current work) or excess-worker stop-now. Status: excess-worker status.",
  "Data lives in %LOCALAPPDATA%\\EXCESS. The device key is protected with Windows DPAPI for your user and cannot move your wallet's funds.",
  "Earnings appear in the web app and become withdrawable after the review window. Withdrawals go to your paired wallet.",""].join("\r\n"));
await mkdir(join(stage,"licenses"),{recursive:true});
if(nodeLicense)await copyFile(resolve(nodeLicense),join(stage,"licenses","node-LICENSE.txt"));
await copyFile(join(root,"node_modules/zod/LICENSE"),join(stage,"licenses","zod-LICENSE.txt")).catch(()=>{});
await writeFile(join(stage,"licenses","NOTICE.txt"),[
  `Bundles Node.js ${process.version} (MIT and bundled third-party licences): https://github.com/nodejs/node/blob/${process.version}/LICENSE`,
  "Bundles zod (MIT). The model runtime (llama.cpp, MIT) and model (Qwen3-4B, Apache-2.0) are downloaded only after explicit consent.",
  nodeLicense?"The full Node.js licence text is included in node-LICENSE.txt.":"NOT FOR PUBLIC DISTRIBUTION: the full Node.js licence text was not included (build with --node-license).",""].join("\r\n"));

let commit="unknown";
try{commit=execFileSync("git",["-c","safe.directory="+root.replaceAll("\\","/").replace(/\/$/,""),"rev-parse","HEAD"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();}catch{}
await writeFile(join(stage,"manifest.json"),JSON.stringify({product:"EXCESS",package:"worker",version,platform:"win32-x64",node:process.version,sourceCommit:commit,
  publicDistributionReady:Boolean(nodeLicense),codeSigned:false,builtAt:new Date().toISOString()},null,2)+"\n");

async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory())result.push(...await files(path));else result.push(path);}return result;}
const sums=[];
for(const file of (await files(stage)).sort()){
  const rel=relative(stage,file).split(sep).join("/");
  if(rel==="SHA256SUMS.txt")continue;
  sums.push(createHash("sha256").update(await readFile(file)).digest("hex")+"  "+rel);
}
await writeFile(join(stage,"SHA256SUMS.txt"),sums.join("\n")+"\n");
let archive=null;
if(zip){
  archive=join(out,name+".zip");await rm(archive,{force:true});
  execFileSync(join(process.env.SystemRoot??"C:\\Windows","System32","tar.exe"),["-a","-c","-f",archive,"-C",out,name],{stdio:["ignore","ignore","pipe"]});
  archive={path:archive,sha256:createHash("sha256").update(await readFile(archive)).digest("hex"),bytes:(await stat(archive)).size};
}
process.stdout.write(JSON.stringify({product:"EXCESS",package:name,directory:stage,files:sums.length,archive,publicDistributionReady:Boolean(nodeLicense)})+"\n");
