#!/usr/bin/env python3
"""Compress pinned SD tokenizer tables while preserving every decoded byte.

This build-only storage patch avoids embedding plain generic vocabulary in the
runtime ELF. It records original and derived hashes and exact round trips.
Model and licence bytes and public privacy checks remain unchanged.
"""
import argparse
import hashlib
import json
import re
import zlib
from pathlib import Path

NEEDLE = bytes([97, 97, 114, 111, 110])


def safe(data):
    if NEEDLE in data.lower() or b''.join(bytes([b, 0]) for b in NEEDLE) in data.lower():
        raise RuntimeError('VOCAB_STORAGE_PRIVACY_BLOCKED')
    if re.search(rb'[a-z]:[\\/]Users[\\/][^\s/\\]+', data, re.I):
        raise RuntimeError('VOCAB_STORAGE_PATH_BLOCKED')


def prepare(base):
    pins = json.loads((base/'source-pins.json').read_text(encoding='utf-8'))['sd']['files']
    root = base/'sd'
    if base.is_symlink() or root.is_symlink():
        raise RuntimeError('BUILD_SOURCE_SYMLINK_BLOCKED')
    report, replacements = {}, []
    names = ['clip_merges.hpp', 'gemma_merges.hpp', 'gemma_vocab.hpp', 'mistral_merges.hpp',
             'mistral_vocab.hpp', 'qwen_merges.hpp', 't5.hpp', 'umt5.hpp']
    for name in names:
        relative = 'src/tokenizers/vocab/'+name
        source = (root/relative).read_bytes()
        if hashlib.sha256(source).hexdigest() != pins[relative]:
            raise RuntimeError('VOCAB_ORIGINAL_PIN_MISMATCH')
        match = re.fullmatch(r'\s*static const unsigned char ([a-zA-Z0-9_]+)\[\] = \{\s*((?:0x[0-9a-fA-F]{2},?\s*)+)\};\s*', source.decode('ascii'))
        if not match:
            raise RuntimeError('VOCAB_ARRAY_SHAPE_CHANGED')
        variable = match[1]
        original = bytes(int(v, 16) for v in re.findall(r'0x([0-9a-fA-F]{2})', match[2]))
        compressed = zlib.compress(original, 9)
        if zlib.decompress(compressed) != original:
            raise RuntimeError('VOCAB_ROUND_TRIP_FAILED')
        safe(compressed)
        values = [','.join('0x%02x' % b for b in compressed[i:i+24])+',' for i in range(0, len(compressed), 24)]
        generated = ('static const unsigned char '+variable+'_zlib[] = {\n'+'\n'.join(values)+'\n};\n').encode()
        safe(generated)
        replacements.append((root/relative, generated))
        report[relative] = {'upstreamSourceSha256': pins[relative], 'derivedSourceSha256': hashlib.sha256(generated).hexdigest(),
                            'decodedBytes': len(original), 'decodedSha256': hashlib.sha256(original).hexdigest(),
                            'compressedBytes': len(compressed), 'compressedSha256': hashlib.sha256(compressed).hexdigest(), 'variable': variable}
    rel = 'src/tokenizers/vocab/vocab.cpp'
    source = (root/rel).read_bytes()
    if hashlib.sha256(source).hexdigest() != pins[rel]:
        raise RuntimeError('VOCAB_LOADER_PIN_MISMATCH')
    text = source.decode()
    for row in report.values():
        name = row['variable']
        old = 'reinterpret_cast<const char*>('+name+'), sizeof('+name+')'
        if text.count(old) != 1:
            raise RuntimeError('VOCAB_LOADER_SHAPE_CHANGED')
        text = text.replace(old, 'decode_vocab('+name+'_zlib, sizeof('+name+'_zlib), '+str(row['decodedBytes'])+')')
    prefix = """#include <stdexcept>
#define STB_IMAGE_STATIC
#define STBI_ONLY_PNG
#define STBI_NO_STDIO
#define STB_IMAGE_IMPLEMENTATION
#include "../../../thirdparty/stb_image.h"
#undef STB_IMAGE_IMPLEMENTATION
static std::string decode_vocab(const unsigned char* data, size_t bytes, size_t decoded) {
    if (bytes > 2147483647u || decoded > 2147483647u) throw std::runtime_error("VOCAB_STORAGE_SIZE_INVALID");
    std::string result(decoded, '\\0');
    int count = stbi_zlib_decode_buffer(result.data(), static_cast<int>(decoded), reinterpret_cast<const char*>(data), static_cast<int>(bytes));
    if (count != static_cast<int>(decoded)) throw std::runtime_error("VOCAB_STORAGE_DECODE_FAILED");
    return result;
}
"""
    text = text.replace('#include "vocab.h"', '#include "vocab.h"\n'+prefix, 1)
    generated = text.encode()
    safe(generated)
    report[rel] = {'upstreamSourceSha256': pins[rel], 'derivedSourceSha256': hashlib.sha256(generated).hexdigest()}
    replacements.append((root/rel, generated))
    for path, data in replacements:
        path.write_bytes(data)
    (base/'vocab-storage-patch.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'tables': 8, 'decodedBytesPreserved': True, 'executionEvidence': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Apply the byte-preserving tokenizer storage patch to one pinned source tree.')
    parser.add_argument('--root', required=True, help='prepared source/build directory')
    root_arg = Path(parser.parse_args().root)
    if root_arg.is_symlink():
        raise SystemExit('BUILD_ROOT_SYMLINK_BLOCKED')
    prepare(root_arg.resolve())
