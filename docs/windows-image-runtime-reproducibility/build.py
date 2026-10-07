"""Build the exact authenticated Windows image runtime from verified prepared inputs.

MSVC Build Tools 2019 14.29.30133, CMake 3.31.8, Python 3.12.2/zlib 1.3.1.
CUDA uses NVIDIA CUDA 12.4.1, SM86, FlashAttention off and a consistent /MD CRT.
This build recipe does not certify hardware, paired execution or installation.
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, time, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
BLOCKED = bytes([97, 97, 114, 111, 110])
INVENTORIES = {
    'source-inputs.json': 'd6d9b8ac0b3d620da7901db938211dea967120cdac3f63fb6603596827a62cf8',
    'cmake-inputs.json': '40510ce78178f278a77b26af82bc4765c425505fe019238ea81206b101af9f0c',
    'cuda-toolchain-inputs.json': '1ac68f219ef73a75f03a82564bcdcd0fe18142c5794549708ee25c9eed717ce5',
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def public(data):
    low = data.lower()
    if any(BLOCKED.decode().encode(e) in low for e in ['utf-8', 'utf-16le', 'utf-16be']):
        raise RuntimeError('PRIVACY_IDENTIFIER_REFUSED')
    if re.search(rb'[a-z]:[\\/]Users[\\/]', data, re.I):
        raise RuntimeError('PERSONAL_PATH_REFUSED')

def no_links(path):
    for p in [path, *path.parents]:
        if p.exists() and (p.is_symlink() or getattr(p.stat(), 'st_file_attributes', 0) & 0x400):
            raise RuntimeError('BUILD_LINK_REFUSED')

def load(name):
    raw = (HERE/name).read_bytes()
    if digest(raw) != INVENTORIES[name]:
        raise RuntimeError('RECIPE_INVENTORY_PIN_MISMATCH')
    return json.loads(raw)

def verify(root, rows, exact=False):
    no_links(root)
    if exact:
        actual=set()
        for path in root.rglob('*'):
            no_links(path)
            if path.is_file():actual.add(path.relative_to(root).as_posix())
        expected={row.get('file',row.get('path')) for row in rows}
        if actual!=expected:raise RuntimeError('UNREVIEWED_BUILD_INPUT_REFUSED')
    for row in rows:
        name = row.get('file', row.get('path'))
        path = root/name
        if '..' in Path(name).parts or Path(name).is_absolute():
            raise RuntimeError('INPUT_PATH_REFUSED')
        no_links(path)
        body = path.read_bytes()
        if len(body) != row['bytes'] or digest(body) != row['sha256']:
            raise RuntimeError('BUILD_INPUT_PIN_MISMATCH')
        public(name.encode()); public(body)

def safe_log(raw):
    text = raw.decode('utf-8', 'replace')
    for value in [str(Path.home()), str(Path.home()).replace('\\', '/')]:
        text = text.replace(value, '~')
    text = re.sub(BLOCKED.decode(), '[private]', text, flags=re.I)
    return re.sub(r'[a-z]:[\\/]+Users[\\/]+[^\s/\\]+', '~', text, flags=re.I)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'cmake-root', 'vcvars', 'build']:
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--backend', choices=['cpu', 'cuda'], required=True)
    parser.add_argument('--cuda-root')
    args = parser.parse_args()
    roots = [Path(getattr(args, name)).resolve() for name in ['source', 'cmake_root', 'vcvars', 'build']]
    source, cmake, vcvars, build = roots
    for path in roots:
        public(str(path).encode()); no_links(path)
    if build.exists() or not vcvars.is_file():
        raise RuntimeError('FRESH_BUILD_AND_INSTALLED_TOOLCHAIN_REQUIRED')
    verify(source, load('source-inputs.json')['files'], exact=True)
    verify(cmake, load('cmake-inputs.json')['files'])
    cuda = None
    if args.backend == 'cuda':
        if not args.cuda_root:
            raise RuntimeError('PINNED_CUDA_ROOT_REQUIRED')
        cuda = Path(args.cuda_root).resolve(); public(str(cuda).encode())
        # The component report binds every selected file, including original EULA bytes.
        inputs = load('cuda-toolchain-inputs.json')
        rows=[row for component in inputs['components'] for row in component['selectedFiles']]
        verify(cuda, rows, exact=True)
    env = os.environ.copy()
    result = subprocess.run('cmd.exe /d /s /c "call "'+str(vcvars)+'" >nul && set"', capture_output=True)
    if result.returncode:
        raise RuntimeError('MSVC_ENVIRONMENT_UNAVAILABLE')
    for line in result.stdout.decode('utf-8', 'replace').splitlines():
        key, separator, value = line.partition('=')
        if separator and key:
            env[key] = value
    compiler = shutil.which('cl.exe', path=env['PATH'])
    if not compiler or '14.29.30133' not in compiler:
        raise RuntimeError('PINNED_MSVC_TOOLSET_REQUIRED')
    build.mkdir(parents=True)
    scratch = build/'temp'; scratch.mkdir()
    env.update(TEMP=str(scratch), TMP=str(scratch), SOURCE_DATE_EPOCH='1726185600')
    report = {'backend':args.backend, 'architecture':'sm86' if cuda else None, 'executionEvidence':False,
              'msvcToolset':'14.29.30133', 'compilerSha256':digest(Path(compiler).read_bytes()),
              'recipeInventories':INVENTORIES, 'steps':{}}
    flags = '/O2 /DNDEBUG /Brepro' + (' /MD' if cuda else '')
    command = [str(cmake/'bin/cmake.exe'), '-S', str(source), '-B', str(build), '-G', 'NMake Makefiles',
        '-DCMAKE_BUILD_TYPE=Release', '-DSD_BUILD_EXAMPLES=ON', '-DSD_CUDA='+('ON' if cuda else 'OFF'),
        '-DSD_VULKAN=OFF', '-DSD_OPENCL=OFF', '-DSD_SYCL=OFF', '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF',
        '-DCMAKE_C_FLAGS_RELEASE='+flags, '-DCMAKE_CXX_FLAGS_RELEASE='+flags,
        '-DCMAKE_EXE_LINKER_FLAGS=/Brepro', '-DCMAKE_SHARED_LINKER_FLAGS=/Brepro', '-DBUILD_SHARED_LIBS=OFF']
    if cuda:
        env['CUDA_PATH'] = str(cuda); env['CUDACXX'] = str(cuda/'bin/nvcc.exe')
        env['PATH'] = str(cuda/'bin')+';'+env['PATH']
        command += ['-DCMAKE_CUDA_ARCHITECTURES=86', '-DGGML_CUDA_FA=OFF', '-DCUDAToolkit_ROOT='+str(cuda),
                    '-DCMAKE_CUDA_COMPILER='+str(cuda/'bin/nvcc.exe'),
                    '-DCMAKE_CUDA_FLAGS=--objdir-as-tempdir -Xcompiler=/Brepro']
    for label, cmd in [('configure', command), ('compile', [str(cmake/'bin/cmake.exe'), '--build', str(build), '--target', 'sd-server', '--config', 'Release'])]:
        start = time.monotonic(); result = subprocess.run(cmd, cwd=build.parent, env=env, capture_output=True)
        log = build/(label+'.txt'); log.write_text(safe_log(result.stdout+result.stderr), encoding='utf-8', newline='\n')
        report['steps'][label] = {'exitCode':result.returncode,'seconds':round(time.monotonic()-start,2),'logSha256':digest(log.read_bytes())}
        (build/'build-report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
        if result.returncode:
            raise RuntimeError('WINDOWS_IMAGE_BUILD_FAILED')
    binary = (build/'bin/sd-server.exe').read_bytes(); public(binary)
    archive = build/('sd-07a85c7-win-x64-auth-'+args.backend+'.zip')
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as package:
        for name, body in sorted({'sd-server.exe':binary,'stable-diffusion-MIT.txt':(source/'LICENSE').read_bytes()}.items()):
            item=zipfile.ZipInfo(name,(2024,9,13,0,0,0));item.create_system=3;item.external_attr=0o100644<<16;item.compress_type=zipfile.ZIP_DEFLATED
            package.writestr(item,body,compresslevel=9)
    public(archive.read_bytes())
    report['binary']={'bytes':len(binary),'sha256':digest(binary)}
    report['archive']={'bytes':archive.stat().st_size,'sha256':digest(archive.read_bytes())}
    (build/'build-report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report['archive']))

if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        print(type(failure).__name__+': '+(str(failure) if isinstance(failure,RuntimeError) else 'BUILD_FAILED_DETAILS_SUPPRESSED'))
        raise SystemExit(1)
