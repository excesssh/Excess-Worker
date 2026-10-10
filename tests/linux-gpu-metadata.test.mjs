import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('GPU discovery grants read-only exact files and deny other proc and thread access', {skip:process.platform!=='linux'}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'excess-gpu-metadata-'));
  try {
    await writeFile(join(directory,'excess-sandbox.c'),await readFile(new URL('../native/linux/excess-sandbox.c',import.meta.url)));
    const fixture=join(directory,'probe.c'),binary=join(directory,'probe');
    await writeFile(fixture,`#define EXCESS_GPU_PROFILE 1
#define main excess_runtime_main
#include "excess-sandbox.c"
#undef main
void excess_gpu_preflight_failure(void) {}
int main(void) {
    if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)) return 2;
    struct excess_ruleset attr={.handled_access_fs=(1ULL << 16)-1};
    int rules=syscall(SYS_landlock_create_ruleset,&attr,sizeof(attr),0); if(rules<0) return 3;
    gpu_metadata_rules(rules);
    if(syscall(SYS_landlock_restrict_self,rules,0)||close(rules)) return 4;
    const char *allowed[]={"/proc/self/maps","/proc/self/status","/proc/devices","/proc/sys/vm/mmap_min_addr"};
    for(size_t i=0;i<sizeof(allowed)/sizeof(allowed[0]);i++) {int fd=open(allowed[i],O_RDONLY); if(fd<0||close(fd))return 5;}
    char parent[128],comm[128];
    snprintf(parent,sizeof(parent),"/proc/%d/maps",getppid());
    snprintf(comm,sizeof(comm),"/proc/self/task/%d/comm",getpid());
    const char *denied[]={"/proc/self/cgroup",parent,comm,"/etc/passwd"};
    for(size_t i=0;i<sizeof(denied)/sizeof(denied[0]);i++) {errno=0;int fd=open(denied[i],O_RDONLY);if(fd!=-1||errno!=EACCES)return 6;}
    errno=0; if(open(comm,O_WRONLY|O_TRUNC)!=-1||errno!=EACCES)return 7;
    errno=0; if(open("/proc/sys/vm/mmap_min_addr",O_WRONLY)!=-1||errno!=EACCES)return 8;
    puts("exact_reads_passed_other_access_denied"); return 0;
}
`);
    const built=spawnSync('gcc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation',fixture,'-o',binary],{encoding:'utf8'});
    assert.equal(built.status,0,'the production metadata grant function must compile');
    const result=spawnSync(binary,[],{encoding:'utf8'});
    assert.equal(result.status,0,'exact grants must pass Linux Landlock enforcement');
    assert.equal(result.stdout.trim(),'exact_reads_passed_other_access_denied');
  } finally {await rm(directory,{recursive:true,force:true});}
});
