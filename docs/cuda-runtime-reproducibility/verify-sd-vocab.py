#!/usr/bin/env python3
"""Check the native compressed table loader against the original byte hashes."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description='Verify exact decoded tokenizer bytes with a local native helper.')
parser.add_argument('--root', required=True)
root_arg = Path(parser.parse_args().root)
if root_arg.is_symlink():
    raise SystemExit('BUILD_ROOT_SYMLINK_BLOCKED')
ROOT = root_arg.resolve()


def main():
    report = json.loads((ROOT/'vocab-storage-patch.json').read_text(encoding='utf-8'))
    folder = ROOT/'vocab-check'
    folder.mkdir(exist_ok=True)
    names = ['load_clip_merges', 'load_qwen2_merges', 'load_mistral_merges', 'load_mistral_vocab_json',
             'load_t5_tokenizer_json', 'load_umt5_tokenizer_json', 'load_gemma_merges', 'load_gemma_vocab_json']
    source = '#include "../sd/src/tokenizers/vocab/vocab.cpp"\n#include <iostream>\nint main(int argc,char**argv){if(argc!=2)return 2;std::string value;switch(std::atoi(argv[1])){\n'
    for index, name in enumerate(names):
        source += 'case '+str(index)+':value='+name+'();break;\n'
    source += 'default:return 2;}std::cout.write(value.data(),value.size());return 0;}\n'
    (folder/'check.cpp').write_text(source, encoding='utf-8')
    result = subprocess.run(['g++', '-std=c++17', '-O2', '-s', '-ffile-prefix-map='+str(ROOT)+'=.',
                             str(folder/'check.cpp'), '-o', str(folder/'check')], capture_output=True)
    if result.returncode:
        raise RuntimeError('NATIVE_VOCAB_CHECK_BUILD_FAILED')
    leafs = ['clip_merges.hpp', 'qwen_merges.hpp', 'mistral_merges.hpp', 'mistral_vocab.hpp',
             't5.hpp', 'umt5.hpp', 'gemma_merges.hpp', 'gemma_vocab.hpp']
    checks = []
    for index, leaf in enumerate(leafs):
        result = subprocess.run([str(folder/'check'), str(index)], capture_output=True, timeout=10)
        expected = report['src/tokenizers/vocab/'+leaf]
        digest = hashlib.sha256(result.stdout).hexdigest()
        if result.returncode or len(result.stdout) != expected['decodedBytes'] or digest != expected['decodedSha256']:
            raise RuntimeError('NATIVE_VOCAB_BYTE_PRESERVATION_FAILED')
        checks.append({'table': leaf, 'bytes': len(result.stdout), 'sha256': digest, 'result': 'passed'})
    value = {'scope': 'native tokenizer byte preservation; no GPU execution', 'checks': checks}
    (ROOT/'vocab-native-check.json').write_text(json.dumps(value, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(value))


if __name__ == '__main__':
    main()
