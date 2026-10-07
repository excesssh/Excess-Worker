#!/usr/bin/env python3
"""Exercise the compiled SD bearer/route boundary without a model or GPU."""
import argparse
import hashlib
import json
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description='Verify the fixed bearer and route boundary with a local CPU-only server.')
parser.add_argument('--root', required=True)
root_arg = Path(parser.parse_args().root)
if root_arg.is_symlink():
    raise SystemExit('BUILD_ROOT_SYMLINK_BLOCKED')
root = root_arg.resolve()
source = root/'sd'
header = source/'examples/server/excess_auth.hpp'
scratch = root/'sd-auth-check'
scratch.mkdir(exist_ok=True)
code = r'''#include "httplib.h"
#include "excess_auth.hpp"
#include <string>
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    const std::string key(43, 'x'); httplib::Server server;
    server.set_pre_routing_handler([&](const httplib::Request& request, httplib::Response& response) {
        if (!excess_sd_authorized(request.get_header_value("Authorization"), key)) {
            response.status = 401; return httplib::Server::HandlerResponse::Handled;
        }
        if (!excess_sd_route(request.method, request.path)) {
            response.status = 404; return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });
    server.Get("/v1/models", [](const auto&, auto& res) { res.set_content("{}", "application/json"); });
    server.Post("/v1/images/generations", [](const auto&, auto& res) { res.set_content("{}", "application/json"); });
    server.Get("/", [](const auto&, auto& res) { res.status = 200; });
    return server.listen("127.0.0.1", std::stoi(argv[1])) ? 0 : 3;
}'''
test = scratch/'server.cpp'
test.write_text(code, encoding='utf-8')
binary = scratch/'server'
subprocess.run(['g++','-std=c++17','-O2','-pthread','-I'+str(source/'thirdparty'),
    '-I'+str(header.parent),str(test),'-o',str(binary)], check=True, capture_output=True)
sock = socket.socket(); sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]; sock.close()
child = subprocess.Popen([str(binary),str(port)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
checks = []
def request(method, path, auth):
    headers = {} if auth is None else {'Authorization':auth}
    req = urllib.request.Request('http://127.0.0.1:'+str(port)+path, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=2) as response: return response.status
    except urllib.error.HTTPError as error: return error.code
try:
    for _ in range(50):
        try:
            if request('GET','/v1/models',None)==401: break
        except OSError: time.sleep(.02)
    else: raise RuntimeError('AUTH_HTTP_START_FAILED')
    key = 'Bearer '+'x'*43
    cases = [('GET','/v1/models',None,401),('POST','/v1/images/generations','Bearer wrong',401),
        ('GET','/v1/models',key,200),('POST','/v1/images/generations',key,200),
        ('GET','/',key,404),('POST','/sdapi/v1/options',key,404),
        ('GET','/v1/images/generations',key,404),('OPTIONS','/v1/models',key,404)]
    for method,path,auth,expected in cases:
        status=request(method,path,auth)
        if status!=expected: raise RuntimeError('AUTH_HTTP_BOUNDARY_FAILED')
        checks.append({'method':method,'path':path,'expected':expected,'actual':status})
finally:
    child.terminate(); child.wait(timeout=3)
report = {'format':1,'scope':'Compiled pinned HTTP library and derived bearer/route header; no SD model, GPU or buyer execution',
    'profile':'excess-sd-bearer-two-route-v1','headerSha256':hashlib.sha256(header.read_bytes()).hexdigest(),
    'checks':checks,'nativeProcessReaped':child.poll() is not None,'executionEvidence':False}
(root/'sd-auth-check.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'profile':report['profile'],'checksPassed':len(checks),'nativeProcessReaped':report['nativeProcessReaped']}))
