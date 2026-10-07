"""Prepare only pinned stable-diffusion source and preserve exact upstream attribution."""
import argparse, importlib.util, json, sys
from pathlib import Path
sys.dont_write_bytecode = True
HERE=Path(__file__).resolve().parent

def module(name, path):
    spec=importlib.util.spec_from_file_location(name,path); value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',required=True)
    root=Path(parser.parse_args().root).resolve()
    build=module('image_build',HERE/'build.py');build.public(str(root).encode());build.no_links(root)
    if root.exists():raise RuntimeError('FRESH_SOURCE_ROOT_REQUIRED')
    root.mkdir(parents=True)
    existing=HERE.parent/'cuda-runtime-reproducibility'
    upstream=module('upstream_inputs',existing/'prepare-runtime.py');upstream.BASE=root
    pins={'sd':upstream.source('leejet/stable-diffusion.cpp',upstream.SD_COMMIT,'sd',{
        'CMakeLists.txt','LICENSE','cmake','ggml','include','src','thirdparty','examples','stable-diffusion.h'})}
    # This is the exact gitlink in the pinned upstream SD revision.
    pins['sd-ggml']=upstream.source('ggml-org/ggml','e20c3a14aa70ee84ca58499814206dd08d8026bc','sd/ggml',{
        'CMakeLists.txt','LICENSE','cmake','include','src'})
    (root/'source-pins.json').write_text(json.dumps(pins,indent=2)+'\n',encoding='utf-8')
    module('sd_auth',existing/'prepare-sd-auth.py').prepare(root)
    module('sd_vocab',existing/'prepare-sd-vocab.py').prepare(root)
    target=root/'sd/examples/server/main.cpp';body=target.read_text(encoding='utf-8')
    if body.count('std::getenv("SD_API_KEY")')!=1 or body.count('unsetenv("SD_API_KEY");')!=1:
        raise RuntimeError('AUTHENTICATION_ADAPTATION_REFUSED')
    body=body.replace('std::getenv("SD_API_KEY")','std::getenv("LLAMA_API_KEY")').replace('unsetenv("SD_API_KEY");','_putenv_s("LLAMA_API_KEY", "");')
    if body.count('        SDSvrParams svr_params;')!=1:
        raise RuntimeError('SOURCE_ADAPTATION_REFUSED')
    body=body.replace('        SDSvrParams svr_params;','    SDSvrParams svr_params;',1)
    build.public(body.encode());target.write_text(body,encoding='utf-8',newline='\n')
    build.verify(root/'sd',build.load('source-inputs.json')['files'],exact=True)
    print('Windows authenticated source matches every reviewed input pin')

if __name__=='__main__':
    try:main()
    except Exception as failure:
        print(type(failure).__name__+': '+(str(failure) if isinstance(failure,RuntimeError) else 'SOURCE_PREPARATION_DETAILS_SUPPRESSED'));raise SystemExit(1)
