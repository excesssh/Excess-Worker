import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,copyFileSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';

// Real Windows ACL operations through both native lease classes. This is a
// permission regression fixture, not hardware inference or a signed-package job.
const source=`
using System; using System.IO; using System.Reflection;
using System.Security.Principal; using System.Security.AccessControl;
class LeaseFixture {
 static Type Lease(string path) { foreach(var t in Assembly.LoadFrom(path).GetTypes()) if(t.Name=="AclLease")return t;throw new Exception("lease-type"); }
 static object Create(Type t,SecurityIdentifier sid){foreach(var c in t.GetConstructors(BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic))if(c.GetParameters().Length==0)return c.Invoke(new object[0]);return Activator.CreateInstance(t,new object[]{sid});}
 static void Grant(Type t,object lease,string method,string path,SecurityIdentifier sid,FileSystemRights rights){var m=t.GetMethod(method);var prefix=m.GetParameters()[0].ParameterType==typeof(string)?new object[]{path,sid,rights}:new object[]{sid,path,rights};object[] args=prefix;if(method=="GrantDirectory"){args=new object[4];Array.Copy(prefix,args,3);args[3]=false;}m.Invoke(lease,args);}
 static void Restore(Type t,object lease){if(!(bool)t.GetMethod("Restore").Invoke(lease,null))throw new Exception("restore-failed");}
 static bool Has(FileSystemSecurity acl,SecurityIdentifier sid){foreach(FileSystemAccessRule r in acl.GetAccessRules(true,false,typeof(SecurityIdentifier)))if(r.IdentityReference.Equals(sid))return true;return false;}
 static void Require(bool value){if(!value)throw new Exception("acl-assertion");}
 static int Main(string[] args){try{
  var a=Lease(args[0]);var b=Lease(args[1]);string root=args[2];string file=Path.Combine(root,"selected.bin");string dir=Path.Combine(root,"granted");File.WriteAllText(file,"fixture");Directory.CreateDirectory(dir);
  var sidA=new SecurityIdentifier("S-1-15-2-101-102-103-104-105-106-107");var sidB=new SecurityIdentifier("S-1-15-2-201-202-203-204-205-206-207");var third=new SecurityIdentifier("S-1-5-21-701-702-703-704");
  string originalFile=File.GetAccessControl(file).GetSecurityDescriptorSddlForm(AccessControlSections.All);string originalDir=Directory.GetAccessControl(dir).GetSecurityDescriptorSddlForm(AccessControlSections.All);
  object first=Create(a,sidA),second=Create(b,sidB);
  try{
   Grant(a,first,"GrantFile",file,sidA,FileSystemRights.Read);Grant(a,first,"GrantDirectory",dir,sidA,FileSystemRights.ReadAndExecute);
   Grant(b,second,"GrantFile",file,sidB,FileSystemRights.ReadAndExecute);Grant(b,second,"GrantDirectory",dir,sidB,FileSystemRights.ReadAndExecute);
   var unrelated=File.GetAccessControl(file);unrelated.AddAccessRule(new FileSystemAccessRule(third,FileSystemRights.Read,AccessControlType.Allow));File.SetAccessControl(file,unrelated);
   Restore(a,first);Require(!Has(File.GetAccessControl(file),sidA));Require(Has(File.GetAccessControl(file),sidB));Require(Has(Directory.GetAccessControl(dir),sidB));Require(Has(File.GetAccessControl(file),third));
   Restore(b,second);Require(!Has(File.GetAccessControl(file),sidB));Require(!Has(Directory.GetAccessControl(dir),sidB));Require(Has(File.GetAccessControl(file),third));
   var final=File.GetAccessControl(file);final.PurgeAccessRules(third);File.SetAccessControl(file,final);
   Require(File.GetAccessControl(file).GetSecurityDescriptorSddlForm(AccessControlSections.All)==originalFile);Require(Directory.GetAccessControl(dir).GetSecurityDescriptorSddlForm(AccessControlSections.All)==originalDir);
   Console.WriteLine("native-acl-leases=live-grants-preserved; unrelated-change=preserved; cleanup=matched");return 0;
  }finally{Restore(a,first);Restore(b,second);File.Delete(file);Directory.Delete(dir);}
 }catch(Exception e){Console.WriteLine("native-acl-fixture-failed="+e.GetType().Name);return 1;}}
}
`;

test('native runtime and controller ACL cleanup preserves other live leases and unrelated permissions', {skip:process.platform!=='win32',timeout:30000},()=>{
 const base='C:/ExcessBuilds/tools/acl-lease-fixtures';
 // The parent is created without changing any existing permissions.
 const setup=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`New-Item -ItemType Directory -Force -Path '${base}' | Out-Null`],{windowsHide:true,encoding:'utf8'});
 assert.equal(setup.status,0);
 const root=mkdtempSync(join(base,'lease-')),cs=join(root,'fixture.cs'),exe=join(root,'fixture.exe');
 try{
  writeFileSync(cs,source);
  const compiler=join(process.env.SystemRoot??'C:/Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const helpers=[];
  for(const name of ['ExcessSandbox','ExcessController']){
   const copied=join(root,name+'.cs'),binary=join(root,name+'.exe');
   copyFileSync(resolve('native/windows/'+name+'.cs'),copied);
   const compiled=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/debug-','/out:'+binary,
    '/reference:'+join(process.env.SystemRoot??'C:/Windows','Microsoft.NET','Framework64','v4.0.30319','System.Web.Extensions.dll'),copied],{windowsHide:true,encoding:'utf8'});
   assert.equal(compiled.status,0,'neutral lease helper fixture must compile');helpers.push(binary);
  }
  const built=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/debug-','/out:'+exe,cs],{windowsHide:true,encoding:'utf8'});
  assert.equal(built.status,0,'neutral native ACL fixture must compile');
  const result=spawnSync(exe,[...helpers,root],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout);
  assert.match(result.stdout,/live-grants-preserved; unrelated-change=preserved; cleanup=matched/);
 }finally{for(const p of [cs,exe,...['ExcessSandbox','ExcessController'].flatMap(name=>[join(root,name+'.cs'),join(root,name+'.exe')])])if(existsSync(p))unlinkSync(p);rmdirSync(root);}
});
