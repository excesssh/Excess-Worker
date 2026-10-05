import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const source = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <netinet/in.h>
#include <arpa/inet.h>
static int readable(const char *p) { int fd=open(p,O_RDONLY); if(fd<0)return 0; close(fd);return 1; }
static int write_denied(const char *p) {int fd=open(p,O_WRONLY|O_TRUNC);if(fd>=0){close(fd);return 0;}return errno==EROFS||errno==EACCES;}
int main(int argc,char **argv) {
 if(argc!=2||getuid()==0||getuid()!=geteuid())return 20;
 int fd=open("/state/output",O_WRONLY|O_CREAT|O_EXCL,0600);if(fd>=0){close(fd);return 21;}if(errno!=EROFS&&errno!=EACCES)return 21;
 fd=open("/scratch/output",O_WRONLY|O_CREAT|O_EXCL,0600);if(fd<0)return 34;close(fd);
 if(!readable("/app/input")||!readable("/ai/models/input")||!write_denied("/app/input")||!write_denied("/ai/models/input")||readable("/ai/private-input"))return 22;
 if(readable(argv[1])||readable("/proc/1/root/etc/passwd")||readable("/etc/passwd"))return 23;
 errno=0;if(syscall(SYS_unshare,CLONE_NEWNET)!=-1||errno!=EPERM)return 24;
 errno=0;if(chroot("/state")!=-1||errno!=EPERM)return 25;
 errno=0;if(mount("tmpfs","/scratch","tmpfs",0,NULL)!=-1||errno!=EPERM)return 26;
 errno=0;if(socket(AF_INET,SOCK_RAW,IPPROTO_ICMP)!=-1||errno!=EPERM)return 27;
 int internet=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in remote={.sin_family=AF_INET,.sin_port=htons(443)};
 inet_pton(AF_INET,"203.0.113.1",&remote.sin_addr);if(internet<0||connect(internet,(void*)&remote,sizeof(remote))!=-1||errno!=ENETUNREACH)return 28;close(internet);
 int unixfd=socket(AF_UNIX,SOCK_STREAM,0);struct sockaddr_un peer={.sun_family=AF_UNIX};strcpy(peer.sun_path,"/broker/socket");
 if(unixfd<0||connect(unixfd,(void*)&peer,sizeof(peer)))return 29;char ack[2];if(write(unixfd,"OK",2)!=2||read(unixfd,ack,2)!=2||memcmp(ack,"OK",2))return 30;close(unixfd);
 if(fcntl(3,F_GETFD)!=-1||errno!=EBADF)return 31;
 FILE *status=fopen("/proc/self/status","r");if(!status)return 32;char line[256];int zero=0,nnp=0;
 while(fgets(line,sizeof(line),status)){if(!strcmp(line,"CapEff:\t0000000000000000\n"))zero++;if(!strcmp(line,"CapPrm:\t0000000000000000\n"))zero++;if(!strcmp(line,"CapBnd:\t0000000000000000\n"))zero++;if(!strcmp(line,"NoNewPrivs:\t1\n"))nnp++;}fclose(status);if(zero!=3||nnp!=1)return 33;
 puts("controller-readonly-state-broker-no-host-network=ok");return 0;
}
`;

test('Linux controller has private mounts/processes/network, readonly payload/state and closed startup descriptors', {
  skip: process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0,
  timeout: 25000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'excess-controller-'));
  const directories = ['root', 'app', 'ai', 'state', 'scratch', 'broker'];
  for (const name of directories) { mkdirSync(join(dir, name), { mode: 0o700 }); chmodSync(join(dir, name), 0o700); }
  let broker, child;
  try {
    const helper = join(dir, 'helper'), probe = join(dir, 'app', 'probe');
    writeFileSync(join(dir, 'probe.c'), source);
    execFileSync('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-misleading-indentation', join(dir, 'probe.c'), '-o', probe], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', resolve('native/linux/excess-controller.c'), '-o', helper], { stdio: ['ignore', 'ignore', 'pipe'] });
    for (const part of ['models', 'runtimes']) mkdirSync(join(dir, 'ai', part), { mode: 0o700 });
    writeFileSync(join(dir, 'app', 'input'), 'fixture-app'); writeFileSync(join(dir, 'ai', 'models', 'input'), 'fixture-ai');
    writeFileSync(join(dir, 'ai', 'private-input'), 'fixture-unmounted');
    writeFileSync(join(dir, 'private-input'), 'fixture-outside');
    let brokerHits = 0;
    broker = createServer(socket => { brokerHits++; socket.once('data', data => { if (data.toString() === 'OK') socket.end('OK'); else socket.destroy(); }); });
    const socket = join(dir, 'broker', 'socket');
    await new Promise((res, rej) => { broker.once('error', rej); broker.listen(socket, res); }); chmodSync(socket, 0o600);
    child = spawn(helper, [...directories.slice(0, 5).map(name => join(dir, name)), socket, socket, '--', '/app/probe', join(dir, 'private-input')],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', ready = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.stdio[3].on('data', chunk => {
      ready += chunk; if (!ready.endsWith('\n')) return;
      const event = JSON.parse(ready);
      assert.deepEqual(Object.keys(event).sort(), ['netDev', 'netIno', 'profile']);
      assert.equal(event.profile, 'linux-controller-namespaces-v1');
      assert.match(event.netDev, /^[0-9]+$/); assert.match(event.netIno, /^[0-9]+$/);
      child.stdio[3].write('OK');
    });
    const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
    assert.equal(code, 0, errors); assert.equal(brokerHits, 1);
    assert.match(output, /controller-readonly-state-broker-no-host-network=ok/);
    assert.deepEqual(readdirSync(join(dir, 'root')), [], 'mount namespace must leave the outer root empty');
    assert.equal(readFileSync(join(dir, 'app', 'input'), 'utf8'), 'fixture-app');
    assert.equal(readFileSync(join(dir, 'ai', 'models', 'input'), 'utf8'), 'fixture-ai');
    assert.equal(existsSync(join(dir, 'state', 'output')), false, 'controller cannot create host state files directly');
    console.log(JSON.stringify({ nativeControllerSource: createHash('sha256').update(readFileSync('native/linux/excess-controller.c')).digest('hex'), proof: 'fixture-kernel-boundary', brokerHits }));
  } finally {
    child?.kill('SIGKILL');
    await new Promise(res => broker ? broker.close(res) : res());
    rmSync(dir, { recursive: true, force: true });
  }
});
