import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('GPU preload is embedded in a sealed fixed descriptor and narrows one proc comm open', {skip:process.platform!=='linux'}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'excess-gpu-preload-'));
  try {
    const native=new URL('../native/linux/',import.meta.url);
    const sandbox=await readFile(new URL('excess-sandbox.c',native));
    const gpu=await readFile(new URL('excess-gpu-sandbox.c',native));
    const shim=await readFile(new URL('cuda-threadname.c',native));
    await writeFile(join(directory,'excess-sandbox.c'),sandbox);
    const gpuTestSource=gpu.toString('utf8').replace('int main(int argc, char **argv) {','int excess_gpu_main(int argc, char **argv) {');
    assert.notEqual(gpuTestSource,gpu.toString('utf8'),'the fixture must rename only the production entry point');
    await writeFile(join(directory,'excess-gpu-sandbox.c'),gpuTestSource);
    const shimSource=join(directory,'shim.c'),shimFile=join(directory,'threadname.so');
    await writeFile(shimSource,shim);
    const shimBuild=spawnSync('gcc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIC','-shared','-Wl,-z,relro,-z,now','-Wl,--build-id=none','-fno-ident','-s',shimSource,'-ldl','-o',shimFile],{stdio:'ignore'});
    assert.equal(shimBuild.status,0,'the pinned shim source must compile without shell output');
    const shimBytes=await readFile(shimFile);
    const rows=[];
    for(let at=0;at<shimBytes.length;at+=16) rows.push('  '+[...shimBytes.subarray(at,at+16)].map(b=>`0x${b.toString(16).padStart(2,'0')}`).join(', '));
    await writeFile(join(directory,'cuda-threadname-blob.h'),
      '#ifndef EXCESS_CUDA_THREADNAME_BLOB_H\n#define EXCESS_CUDA_THREADNAME_BLOB_H\n'+
      'static const unsigned char excess_cuda_threadname_blob[] = {\n'+rows.join(',\n')+'\n};\n'+
      `static const unsigned long excess_cuda_threadname_blob_size = ${shimBytes.length}UL;\n#endif\n`);
    const fixture=join(directory,'probe.c'),binary=join(directory,'probe');
    await writeFile(fixture,`#include "excess-gpu-sandbox.c"
static int child_check(void) {
    const char *preload=getenv("LD_PRELOAD");
    const char *libraryPath=getenv("LD_LIBRARY_PATH");
    if(!preload||strcmp(preload,"/proc/self/fd/200")||getenv("LD_AUDIT")||!libraryPath||strcmp(libraryPath,"/usr/lib:/lib"))return 31;
    if(fcntl(200,F_GETFD)&FD_CLOEXEC)return 32;
    int seals=fcntl(200,F_GET_SEALS);
    if(seals<0||(seals&(F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK|F_SEAL_SEAL))!=(F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK|F_SEAL_SEAL))return 33;
    errno=0;if(pwrite(200,"x",1,0)!=-1||errno!=EPERM)return 34;
    errno=0;if(ftruncate(200,0)!=-1||errno!=EPERM)return 35;
    errno=0;if(ftruncate(200,excess_cuda_threadname_blob_size+1)!=-1||errno!=EPERM)return 49;
    char before[16]={0},after[16]={0};if(prctl(PR_GET_NAME,before))return 36;
    char self[128];snprintf(self,sizeof(self),"/proc/self/task/%ld/comm",(long)syscall(SYS_gettid));
    FILE *f=fopen(self,"w");if(!f)return 37;if(fputs("ignored-thread-name",f)<0||fclose(f))return 38;
    f=fopen64(self,"wb");if(!f)return 39;if(fputs("ignored-thread-name",f)<0||fclose(f))return 40;
    if(prctl(PR_GET_NAME,after)||strcmp(before,after))return 41;
    errno=0;f=fopen(self,"w+");if(f){fclose(f);return 42;}if(errno!=EACCES)return 43;
    errno=0;if(open(self,O_WRONLY|O_TRUNC)!=-1||errno!=EACCES)return 44;
    char other[160];snprintf(other,sizeof(other),"/proc/%ld/task/%ld/comm",(long)getpid(),(long)syscall(SYS_gettid));
    errno=0;f=fopen(other,"w");if(f){fclose(f);return 45;}if(errno!=EACCES)return 46;
    snprintf(other,sizeof(other),"/proc/self/task/%ld/comm-extra",(long)syscall(SYS_gettid));
    errno=0;f=fopen(other,"w");if(f){fclose(f);return 47;}if(errno!=ENOENT)return 48;
    snprintf(other,sizeof(other),"/proc/self/task/%ld/mem",(long)syscall(SYS_gettid));
    errno=0;if(open(other,O_RDONLY)!=-1||errno!=EACCES)return 49;
    return 0;
}
int main(int argc,char **argv) {
    if(argc==2&&!strcmp(argv[1],"child"))return child_check();
    if(argc!=1||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||install_threadname_memfd())return 10;
    if(setenv("LD_PRELOAD","/untrusted/unsealed.so",1)||setenv("LD_AUDIT","/untrusted/audit.so",1)||
       setenv("LD_LIBRARY_PATH","/usr/lib:/lib",1))return 11;
    struct excess_ruleset attr={.handled_access_fs=(1ULL<<16)-1};
    int rules=syscall(SYS_landlock_create_ruleset,&attr,sizeof(attr),0);if(rules<0)return 12;
    const char *libs[]={"/usr/lib","/lib","/lib64","/etc/ld.so.cache","/dev/null"};
    for(size_t n=0;n<sizeof(libs)/sizeof(libs[0]);n++) {
      uint64_t rights=LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR|LANDLOCK_ACCESS_FS_EXECUTE;
      if(!strcmp(libs[n],"/dev/null"))rights=LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_TRUNCATE;
      if(access(libs[n],F_OK)&&errno==ENOENT)continue;
      path_rule(rules,libs[n],rights);
    }
    path_rule(rules,argv[0],LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_EXECUTE);
    gpu_preload_policy();
    if(syscall(SYS_landlock_restrict_self,rules,0)||close(rules))return 13;
    if(syscall(SYS_close_range,3,199,0)||syscall(SYS_close_range,201,~0U,0))return 14;
    char *next[]={argv[0],"child",NULL};execv(argv[0],next);return 15;
}
`);
    const built=spawnSync('gcc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation',fixture,'-ldl','-o',binary],{stdio:'ignore'});
    assert.equal(built.status,0,'the helper-boundary fixture must compile');
    const run=spawnSync(binary,[],{stdio:'ignore',timeout:10000});
    assert.equal(run.status,0,'memfd loader, sealed bytes and exact open interception must pass');
  } finally {await rm(directory,{recursive:true,force:true});}
});
