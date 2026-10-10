import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { scanSafeTarGz } from "../packages/adapters/dist/tar.js";

// Tiny ustar fixtures, not runtime evidence.
const LIMITS={maxInputBytes:1024*1024,maxTotalBytes:1024*1024,maxEntryBytes:512*1024};
function header(name,{type="0",size=0,link=""}={}){
  const block=Buffer.alloc(512);
  block.write(name,0,100,"utf8");
  block.write("0000644\0",100);block.write("0000000\0",108);block.write("0000000\0",116);
  block.write(size.toString(8).padStart(11,"0")+"\0",124);block.write("00000000000\0",136);
  block.write("        ",148);block.write(type,156);block.write(link,157,100,"utf8");
  block.write("ustar\0",257);block.write("00",263);
  let sum=0;for(const byte of block)sum+=byte;
  block.write(sum.toString(8).padStart(6,"0")+"\0 ",148);
  return block;
}
function archive(entries,{corrupt=false}={}){
  const blocks=[];
  for(const [name,options={}] of entries){
    const data=Buffer.from(options.data??"");
    const head=header(name,{...options,size:data.length});
    if(corrupt)head[0]^=1;
    blocks.push(head);
    if(data.length){const padded=Buffer.alloc(Math.ceil(data.length/512)*512);data.copy(padded);blocks.push(padded);}
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const read=input=>{const out=[];scanSafeTarGz(input,LIMITS,entry=>out.push([entry.name,entry.data.toString()]));return out;};

test("worker tar scope is explicit and limited to app/node_modules/@excess",()=>{
  const path="root/app/node_modules/@excess/adapters/dist/index.js",input=archive([[path,{data:"SCOPED PACKAGE FIXTURE"}]]);
  assert.throws(()=>read(input),/UNSAFE_RUNTIME_ARCHIVE/);
  const entries=[];scanSafeTarGz(input,{...LIMITS,allowExcessWorkerScope:true},entry=>entries.push(entry.name));
  assert.deepEqual(entries,[path.slice(5)]);
  assert.throws(()=>scanSafeTarGz(archive([["root/a",{data:"x"}],["root/link",{type:"2",link:"a"}]]),{...LIMITS,allowExcessWorkerScope:true},()=>{}),/UNSAFE_RUNTIME_ARCHIVE/);
  for(const denied of ["root/app/node_modules/@other/a.js","root/else/node_modules/@excess/a.js","root/app/@excess/a.js","root/app/node_modules/@excess/../outside.js"])
    assert.throws(()=>scanSafeTarGz(archive([[denied,{data:"x"}]]),{...LIMITS,allowExcessWorkerScope:true},()=>{}),/UNSAFE_RUNTIME_ARCHIVE/);
});

test("tar.gz reader strips the top-level folder and materializes same-folder symlinks as copies",()=>{
  const entries=read(archive([
    ["llama-b1/",{type:"5"}],
    ["llama-b1/llama-server",{data:"SERVER FIXTURE"}],
    ["llama-b1/libllama.so.0.4.0",{data:"LIBRARY FIXTURE"}],
    ["llama-b1/libllama.so.0",{type:"2",link:"libllama.so.0.4.0"}],
    ["llama-b1/libllama.so",{type:"2",link:"libllama.so.0"}],
  ]));
  assert.deepEqual(entries,[["llama-server","SERVER FIXTURE"],["libllama.so.0.4.0","LIBRARY FIXTURE"],["libllama.so.0","LIBRARY FIXTURE"],["libllama.so","LIBRARY FIXTURE"]]);
});

test("explicit flat tar.gz layout accepts only root-level regular files and preserves their names",()=>{
  const input=archive([["llama-server",{data:"SERVER FIXTURE"}],["libggml-cuda.so",{data:"CUDA LIBRARY FIXTURE"}]]);
  assert.throws(()=>read(input),/UNSAFE_RUNTIME_ARCHIVE/);
  const entries=[];
  scanSafeTarGz(input,LIMITS,entry=>entries.push([entry.name,entry.data.toString()]),"flat-regular-files");
  assert.deepEqual(entries,[["llama-server","SERVER FIXTURE"],["libggml-cuda.so","CUDA LIBRARY FIXTURE"]]);
});

test("flat tar.gz layout refuses rooted, nested, directory, link, special and duplicate entries",()=>{
  const refuse=entries=>assert.throws(()=>scanSafeTarGz(archive(entries),LIMITS,()=>{},"flat-regular-files"),/UNSAFE_RUNTIME_ARCHIVE/);
  refuse([["root/server",{data:"x"}]]);
  refuse([["lib/server",{data:"x"}],["other.so",{data:"y"}]]);
  refuse([["runtime/",{type:"5"}],["server",{data:"x"}]]);
  refuse([["server",{data:"x"}],["link",{type:"2",link:"server"}]]);
  refuse([["server",{data:"x"}],["hard",{type:"1",link:"server"}]]);
  refuse([["device",{type:"3"}]]);
  refuse([["../outside",{data:"x"}]]);
  refuse([["server",{data:"x"}],["server",{data:"y"}]]);
});

test("tar.gz reader refuses traversal, escaping or dangling links, special files, mixed roots and corruption",()=>{
  const refuse=(entries,options)=>assert.throws(()=>read(archive(entries,options)),/UNSAFE_RUNTIME_ARCHIVE/);
  refuse([["root/../outside",{data:"x"}]]);
  refuse([["/root/absolute",{data:"x"}]]);
  refuse([["root/a",{data:"x"}],["other/b",{data:"y"}]]);
  refuse([["root/a",{data:"x"}],["root/link",{type:"2",link:"../a"}]]);
  refuse([["root/a",{data:"x"}],["root/link",{type:"2",link:"/etc/passwd"}]]);
  refuse([["root/a",{data:"x"}],["root/link",{type:"2",link:"missing"}]]);
  refuse([["root/a",{data:"x"}],["root/hard",{type:"1",link:"a"}]]);
  refuse([["root/a",{data:"x"}],["root/device",{type:"3"}]]);
  refuse([["root/a",{data:"x"}],["root/a",{data:"y"}]]);
  refuse([["root/a",{data:"x"}]],{corrupt:true});
  refuse([["root/a",{data:"x"}],["root/loop1",{type:"2",link:"loop2"}],["root/loop2",{type:"2",link:"loop1"}]]);
  assert.throws(()=>scanSafeTarGz(archive([["root/big",{data:"x".repeat(2048)}]]),{...LIMITS,maxEntryBytes:1024},()=>{}),/UNSAFE_RUNTIME_ARCHIVE/);
  assert.throws(()=>scanSafeTarGz(Buffer.from("not gzip at all, just text padding"),LIMITS,()=>{}),/UNSAFE_RUNTIME_ARCHIVE/);
});
