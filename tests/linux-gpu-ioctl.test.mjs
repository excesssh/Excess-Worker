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
    const source=`#define EXCESS_GPU_PROFILE 1
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
    long result=!strcmp(argv[1],"unix-seqpacket") ? socket(AF_UNIX,SOCK_SEQPACKET,0) :
        !strcmp(argv[1],"unix-stream") ? socket(AF_UNIX,SOCK_STREAM,0) :
        !strcmp(argv[1],"unix-dgram") ? socket(AF_UNIX,SOCK_DGRAM,0) :
        !strcmp(argv[1],"inet-stream") ? socket(AF_INET,SOCK_STREAM,0) :
        !strcmp(argv[1],"inet-dgram") ? socket(AF_INET,SOCK_DGRAM,0) :
        !strcmp(argv[1],"socketpair") ? socketpair(AF_UNIX,SOCK_SEQPACKET,0,pair) :
        syscall(__NR_ioctl,-1,request,0);
    printf("%ld %d\\n",result,errno); return 0;
}
`;
    await writeFile(fixture,source);
    const built=spawnSync('gcc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation',fixture,'-o',binary],{encoding:'utf8'});
    assert.equal(built.status,0,'the production filter must compile');
    const run=request=>{const result=spawnSync(binary,[request],{encoding:'utf8'});assert.equal(result.status,0);return result.stdout.trim();};
    // EBADF establishes that seccomp let the query reach the kernel. No GPU,
    // device access or inference execution is established by this fixture.
    assert.equal(run('c23046d7'),'-1 9');
    assert.equal(run('17'),'-1 9','exact UVM create range-group ioctl 23 must reach the kernel');
    assert.equal(run('18'),'-1 9','exact UVM destroy range-group ioctl 24 must reach the kernel');
    for(const request of ['c00446d8','c23046d8','c22846d7','823046d7','423046d7','46d7','c23046d9','c23046cb','1c23046d7','9','100000017','40000017','40000018','30000017','30000018'])
      assert.equal(run(request),'-1 1',`unapproved encoding ${request} must remain denied`);
    const allowedSocket=run('unix-seqpacket'); assert.match(allowedSocket,/^\d+ 0$/,'only local seqpacket socket creation reaches the kernel');
    assert.match(run('inet-stream'),/^\d+ 0$/,'existing TCP stream support remains available');
    for(const kind of ['unix-stream','unix-dgram','inet-dgram','socketpair'])
      assert.equal(run(kind),'-1 1',`${kind} remains denied`);
    const cpuFixture=join(directory,'cpu-probe.c'),cpuBinary=join(directory,'cpu-probe');
    await writeFile(cpuFixture,source.replace('#define EXCESS_GPU_PROFILE 1\n',''));
    const cpuBuilt=spawnSync('gcc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation',cpuFixture,'-o',cpuBinary],{encoding:'utf8'});
    assert.equal(cpuBuilt.status,0,'the unchanged CPU profile must compile');
    const cpuRun=kind=>{const result=spawnSync(cpuBinary,[kind],{encoding:'utf8'});assert.equal(result.status,0);return result.stdout.trim();};
    assert.equal(cpuRun('unix-seqpacket'),'-1 1','the GPU-only seqpacket allowance must not change the CPU profile');
    assert.match(cpuRun('inet-stream'),/^\d+ 0$/,'the existing CPU TCP stream allowance is preserved');
  } finally {await rm(directory,{recursive:true,force:true});}
});
