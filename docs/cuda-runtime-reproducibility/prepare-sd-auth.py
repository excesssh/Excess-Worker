#!/usr/bin/env python3
"""Add bearer authentication and two fixed routes to the pinned SD server."""
import argparse
import hashlib
import json
from pathlib import Path

HEADER = r'''#pragma once
#include <string>
inline bool excess_sd_authorized(const std::string& supplied, const std::string& key) {
    const std::string expected = "Bearer " + key;
    if (supplied.size() != expected.size()) return false;
    unsigned int difference = 0;
    for (size_t n = 0; n < expected.size(); ++n)
        difference |= static_cast<unsigned char>(supplied[n]) ^ static_cast<unsigned char>(expected[n]);
    return difference == 0;
}
inline bool excess_sd_route(const std::string& method, const std::string& path) {
    return (method == "GET" && path == "/v1/models") ||
           (method == "POST" && path == "/v1/images/generations");
}
'''
AUTH = '''    svr.set_pre_routing_handler([api_key](const httplib::Request& req, httplib::Response& res) {
        if (!excess_sd_authorized(req.get_header_value("Authorization"), api_key)) {
            res.status = 401;
            res.set_content("{\\"error\\":\\"unauthorized\\"}", "application/json");
            return httplib::Server::HandlerResponse::Handled;
        }
        if (!excess_sd_route(req.method, req.path)) {
            res.status = 404;
            return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });'''

def prepare(root):
    name = 'examples/server/main.cpp'
    target = root/'sd'/name
    pins = json.loads((root/'source-pins.json').read_text(encoding='utf-8'))['sd']['files']
    original = target.read_bytes()
    if hashlib.sha256(original).hexdigest() != pins[name]:
        raise SystemExit('SD_AUTH_ORIGINAL_PIN_MISMATCH')
    text = original.decode('utf-8').replace('#include "httplib.h"', '#include "httplib.h"\n#include "excess_auth.hpp"')
    marker = '    SDSvrParams svr_params;'
    if text.count(marker) != 1:
        raise SystemExit('SD_AUTH_ENTRY_POINT_CHANGED')
    text = text.replace(marker, '''    const char* supplied_key = std::getenv("SD_API_KEY");
    if (!supplied_key) return EXIT_FAILURE;
    const std::string api_key(supplied_key);
    if (api_key.size() < 43 || api_key.size() > 128) return EXIT_FAILURE;
    unsetenv("SD_API_KEY");
    ''' + marker)
    start = text.index('    svr.set_pre_routing_handler(')
    end = text.index('\n    });', start) + len('\n    });')
    text = text[:start] + AUTH + text[end:]
    derived = text.encode('utf-8')
    needle = bytes([97, 97, 114, 111, 110])
    if needle in derived.lower() or needle in HEADER.encode().lower():
        raise SystemExit('SD_AUTH_PRIVACY_BLOCKED')
    target.write_bytes(derived)
    (target.parent/'excess_auth.hpp').write_text(HEADER, encoding='utf-8', newline='\n')
    report = {'profile':'excess-sd-bearer-two-route-v1', 'source':name,
        'originalSha256':pins[name], 'derivedSha256':hashlib.sha256(derived).hexdigest(),
        'headerSha256':hashlib.sha256(HEADER.encode()).hexdigest(),
        'allowedRoutes':['GET /v1/models','POST /v1/images/generations'], 'executionEvidence':False}
    (root/'sd-auth-patch.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print('Pinned SD authentication patch prepared; executionEvidence=false')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Apply the pinned two-route bearer patch to one source tree.')
    parser.add_argument('--root', required=True, help='prepared source/build directory')
    root_arg = Path(parser.parse_args().root)
    if root_arg.is_symlink() or (root_arg/'sd').is_symlink():
        raise SystemExit('BUILD_SOURCE_SYMLINK_BLOCKED')
    prepare(root_arg.resolve())
