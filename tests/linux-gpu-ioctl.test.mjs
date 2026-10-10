import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('GPU filter permits only the exact NUMA information query and denies mutations', {skip:process.platform!=='linux'}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'excess-gpu-ioctl-'));
  try {
    await writeFile(join(directory,'excess-sandbox.c'),await readFile(new URL('../native/linux/excess-sandbox.c',import.meta.url)));
    const fixture=join(directory,'probe.c'),binary=join(directory,'probe');
    await writeFile(fixture,`#define EXCESS_GPU_PROFILE 1
#define main excess_runtime_main
#include "excess-sandbox.c"
#undef main
#include <sys/socket.h>
void excess_gpu_preflight_failure(void) {}
int main(int argc,char **argv) {
    if(argc != 2 || prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)) return 2;
    unsigned long request=strtoul(argv[1],NULL,16);
    syscalls(); errno=0;
    int pair[2];
    long result=!strcmp(argv[1],"socket") ? socket(AF_UNIX,SOCK_SEQPACKET,0) :
        !strcmp(argv[1],"socketpair") ? socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair) :
        syscall(__NR_ioctl,-1,request,0);
    printf("%ld %d\\n",result,errno); return 0;
}
`);
    const built=spawnSync('gcc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation',fixture,'-o',binary],{encoding:'utf8'});
    assert.equal(built.status,0,'the production filter must compile');
    const run=request=>{const result=spawnSync(binary,[request],{encoding:'utf8'});assert.equal(result.status,0);return result.stdout.trim();};
    // EBADF establishes that seccomp let the query reach the kernel. No GPU,
    // device access or inference execution is established by this fixture.
    assert.equal(run('c23046d7'),'-1 9');
    for(const request of ['c00446d8','c23046d8','c22846d7','823046d7','423046d7','46d7','c23046d9','c23046cb','1c23046d7'])
      assert.equal(run(request),'-1 1',`unapproved encoding ${request} must remain denied`);
    assert.equal(run('socket'),'-1 1','Unix socket creation must remain denied');
    assert.equal(run('socketpair'),'-1 1','Unix socketpair creation must also be denied');
  } finally {await rm(directory,{recursive:true,force:true});}
});
