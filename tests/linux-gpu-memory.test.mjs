import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('GPU cgroup sampler parses only complete kernel memory counters and fails closed', {skip:process.platform!=='linux'}, async()=>{
  const source=await readFile(new URL('../native/linux/excess-gpu-sandbox.c',import.meta.url),'utf8');
  const start=source.indexOf('static int cgroup_memory('),end=source.indexOf('\nstatic int memory(',start);
  assert.ok(start>=0&&end>start);
  const directory=await mkdtemp(join(tmpdir(),'excess-gpu-memory-'));
  try {
    const fixture=join(directory,'probe.c'),binary=join(directory,'probe');
    await writeFile(fixture,`#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/vfs.h>
static const char *counter; static long filesystem; static int closed;
static int fixture_open(const char *path,int flags){if(strcmp(path,"/gpu-budget/memory.current")||flags!=(O_RDONLY|O_CLOEXEC|O_NOFOLLOW))return -1;return 11;}
static ssize_t fixture_read(int fd,void *data,size_t length){if(fd!=11)return -1;size_t n=strlen(counter);if(n>length)n=length;memcpy(data,counter,n);return (ssize_t)n;}
static int fixture_fstatfs(int fd,struct statfs *value){if(fd!=11)return -1;value->f_type=filesystem;return 0;}
static int fixture_close(int fd){closed++;return fd==11?0:-1;}
#define open fixture_open
#define read fixture_read
#define fstatfs fixture_fstatfs
#define close fixture_close
${source.slice(start,end)}
int main(int argc,char **argv){if(argc!=3)return 2;counter=argv[1];filesystem=strtol(argv[2],NULL,16);uint64_t value=777;int ok=cgroup_memory(&value);printf("%d %llu %d\\n",ok,(unsigned long long)value,closed);return 0;}
`);
    const built=spawnSync('gcc',['-D_GNU_SOURCE','-std=c11','-O2','-Wall','-Wextra','-Werror',fixture,'-o',binary],{encoding:'utf8'});
    assert.equal(built.status,0,'sampler fixture must compile');
    const run=(counter,fs='63677270')=>{const result=spawnSync(binary,[counter,fs],{encoding:'utf8'});assert.equal(result.status,0);return result.stdout.trim();};
    for(const [counter,value] of [['0\n','0'],['32768\n','32768'],['1048576','1048576'],['18446744073709551615\n','18446744073709551615']])assert.equal(run(counter),`1 ${value} 1`);
    for(const counter of ['', 'max\n','-1\n',' 12\n','12\r\n','12\n13','12x','18446744073709551616\n','9'.repeat(128)])assert.equal(run(counter),'0 777 1');
    assert.equal(run('12\n','1021994'),'0 777 1','ordinary files cannot impersonate cgroup counters');
  } finally {await rm(directory,{recursive:true,force:true});}
});
