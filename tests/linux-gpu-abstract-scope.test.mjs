import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

test('GPU sandbox permits seqpacket creation but scopes abstract peers outside its process domain', {skip:process.platform!=='linux'}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'excess-gpu-scope-'));
  let server;
  try {
    await writeFile(join(directory,'excess-sandbox.c'),await readFile(new URL('../native/linux/excess-sandbox.c',import.meta.url)));
    const fixture=join(directory,'probe.c'),binary=join(directory,'probe');
    await writeFile(fixture,`#define EXCESS_GPU_PROFILE 1
#define main excess_runtime_main
#include "excess-sandbox.c"
#undef main
#include <sys/un.h>
void excess_gpu_preflight_failure(void) {}
static socklen_t address_for(struct sockaddr_un *address,pid_t pid) {
    memset(address,0,sizeof(*address));address->sun_family=AF_UNIX;
    int n=snprintf(address->sun_path+1,sizeof(address->sun_path)-1,"excess-scope-%ld",(long)pid);
    return (socklen_t)(offsetof(struct sockaddr_un,sun_path)+1+n);
}
int main(int argc,char **argv) {
    if(argc==2&&!strcmp(argv[1],"server")) {
      int fd=socket(AF_UNIX,SOCK_SEQPACKET,0);if(fd<0)return 2;
      struct sockaddr_un address;socklen_t length=address_for(&address,getpid());
      if(bind(fd,(struct sockaddr *)&address,length)||listen(fd,1))return 3;
      puts("ready");fflush(stdout);int peer=accept(fd,NULL,NULL);return peer<0?4:0;
    }
    if(argc!=2)return 5;
    pid_t peer=(pid_t)strtol(argv[1],NULL,10);int fd=socket(AF_UNIX,SOCK_SEQPACKET,0);if(fd<0)return 6;
    struct excess_ruleset attr={.handled_access_net=LANDLOCK_ACCESS_NET_BIND_TCP|LANDLOCK_ACCESS_NET_CONNECT_TCP,
      .scoped=LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET|LANDLOCK_SCOPE_SIGNAL};
    if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))return 7;
    if(syscall(SYS_landlock_create_ruleset,NULL,0,LANDLOCK_CREATE_RULESET_VERSION)<6)return 77;
    int rules=syscall(SYS_landlock_create_ruleset,&attr,sizeof(attr),0);if(rules<0)return 8;
    if(syscall(SYS_landlock_restrict_self,rules,0)||close(rules))return 8;
    syscalls();struct sockaddr_un address;socklen_t length=address_for(&address,peer);
    int result=connect(fd,(struct sockaddr *)&address,length);
    return result==0||errno!=EPERM?20:0;
}
`);
    const built=spawnSync('gcc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation',fixture,'-o',binary],{stdio:'ignore'});
    assert.equal(built.status,0,'the actual source policy fixture must compile');
    server=spawn(binary,['server'],{stdio:['ignore','pipe','ignore']});
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('LISTENER_START_TIMEOUT')),5000);
      let text='';server.stdout.setEncoding('utf8');
      server.stdout.on('data',chunk=>{text+=chunk;if(text.includes('ready\n')){clearTimeout(timer);resolve(true);}});
      server.once('error',()=>{clearTimeout(timer);reject(Error('LISTENER_START_FAILED'));});
      server.once('exit',()=>{clearTimeout(timer);reject(Error('LISTENER_EXITED_EARLY'));});
    });
    assert.equal(ready,true);
    const client=spawnSync(binary,[String(server.pid)],{stdio:'ignore',timeout:5000});
    if(client.status===77){t.skip('kernel lacks the required Landlock scope ABI');return;}
    assert.equal(client.status,0,'sandboxed client must not connect to a sibling-domain abstract listener');
  } finally {
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}
    await rm(directory,{recursive:true,force:true});
  }
});
