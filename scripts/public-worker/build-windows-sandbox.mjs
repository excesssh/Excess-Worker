import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertPublicBytes } from './privacy.mjs';

if(process.platform!=='win32'||process.arch!=='x64')throw Error('SANDBOX_BUILD_REQUIRES_WINDOWS_X64');
const output=resolve(process.argv[2]??'packages/adapters/native');
const toolchain=resolve(process.argv[3]??'.cache/native-toolchain/windows');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inventoryHash='051d04fab3d3756d47d766b01e009fab3000445134d4db909bc0a034e71ac3bd';
const inventoryBytes=await readFile(join(toolchain,'inputs.json'));
if(hash(inventoryBytes)!==inventoryHash)throw Error('NATIVE_TOOLCHAIN_INVENTORY_MISMATCH');
const inventory=JSON.parse(inventoryBytes.toString('utf8'));
for(const entry of inventory.files){
  const target=resolve(toolchain,entry.file),path=relative(toolchain,target);
  if(!path||isAbsolute(path)||path==='..'||path.startsWith('..'+sep))throw Error('NATIVE_TOOLCHAIN_PATH_DENIED');
  const bytes=await readFile(target);
  if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)throw Error('NATIVE_TOOLCHAIN_INPUT_MISMATCH');
  assertPublicBytes(bytes);
}
const source=await readFile('native/windows/ExcessSandbox.cs');assertPublicBytes(source);
await mkdir(output,{recursive:true});
const scratch=await mkdtemp(join(output,'.build-'));
try{
  await writeFile(join(scratch,'source.cs'),source,{flag:'wx'});
  const compiler=join(toolchain,'microsoft.net.compilers.toolset/tasks/net472/csc.exe');
  const referenceRoot=join(toolchain,'microsoft.netframework.referenceassemblies.net48/build/.NETFramework/v4.8');
  const references=['mscorlib.dll','System.dll','System.Core.dll','System.Web.dll','System.Web.Extensions.dll','System.Xml.dll','System.Data.dll'];
  const args=['/nologo','/noconfig','/nostdlib+','/target:exe','/platform:x64','/optimize+','/debug-','/deterministic+',
    '/langversion:5','/codepage:65001','/preferreduilang:en-US','/utf8output',
    '/pathmap:'+scratch+'=/src/excess,'+toolchain+'=/build-tools','/out:ExcessSandbox.exe',
    ...references.map(name=>'/reference:'+join(referenceRoot,name)),'source.cs'];
  try{execFileSync(compiler,args,{cwd:scratch,windowsHide:true,env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',
    WINDIR:process.env.WINDIR??'C:\\Windows',TEMP:scratch,TMP:scratch},stdio:['ignore','pipe','pipe'],maxBuffer:65536,timeout:60000});}
  catch{throw Error('WINDOWS_SANDBOX_COMPILE_FAILED');}
  const bytes=await readFile(join(scratch,'ExcessSandbox.exe'));assertPublicBytes(bytes);
  const pin={profile:'windows-appcontainer-v1',sha256:hash(bytes),sourceSha256:hash(source),
    toolchainInventorySha256:inventoryHash,compiler:'Microsoft.Net.Compilers.Toolset 4.14.0',references:'Microsoft.NETFramework.ReferenceAssemblies.net48 1.0.3',
    deterministic:true,debugSymbols:false};
  await writeFile(join(output,'ExcessSandbox.exe'),bytes);
  await writeFile(join(output,'integrity-win32.json'),JSON.stringify(pin)+'\n');
  console.log(JSON.stringify({profile:pin.profile,sha256:pin.sha256,sourceSha256:pin.sourceSha256,toolchainInventorySha256:inventoryHash,privacy:'passed'}));
}finally{
  if(dirname(scratch)!==output||!scratch.startsWith(join(output,'.build-')))throw Error('NATIVE_BUILD_CLEANUP_BOUNDARY_DENIED');
  await rm(scratch,{recursive:true,force:true});
}
