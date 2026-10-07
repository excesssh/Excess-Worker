"""Download only hash-pinned, reviewed CMake/CUDA component files to a fresh root."""
import argparse, importlib.util, io, json, sys, urllib.request, zipfile
from pathlib import Path, PurePosixPath
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('build_inputs',HERE/'build.py');build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)

def fetch(url, expected, size=None):
    with urllib.request.urlopen(url,timeout=90) as response:body=response.read(512*1024*1024+1)
    if len(body)>512*1024*1024 or build.digest(body)!=expected or size is not None and len(body)!=size:
        raise RuntimeError('UPSTREAM_ARCHIVE_PIN_MISMATCH')
    return body

def selected_archive(raw, root, rows):
    expected={row.get('file',row.get('path')):row for row in rows}
    selected={}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for entry in archive.infolist():
            parts=PurePosixPath(entry.filename).parts
            if len(parts)<2 or entry.is_dir():continue
            path=PurePosixPath(*parts[1:]);name=path.as_posix()
            if name not in expected:continue
            if path.is_absolute() or '..' in path.parts or (entry.external_attr>>16)&0o170000==0o120000 or name in selected:
                raise RuntimeError('UPSTREAM_ARCHIVE_PATH_OR_LINK_REFUSED')
            row=expected[name];body=archive.read(entry)
            if len(body)!=row['bytes'] or build.digest(body)!=row['sha256']:
                raise RuntimeError('SELECTED_TOOL_FILE_PIN_MISMATCH')
            build.public(name.encode());build.public(body);selected[name]=body
    if set(selected)!=set(expected):raise RuntimeError('REQUIRED_TOOL_FILE_MISSING')
    # Inspect every selected path and byte before writing this component.
    for name,body in selected.items():
        path=root/name;build.no_links(path)
        if path.exists():
            if path.read_bytes()!=body:raise RuntimeError('COMPONENT_FILE_COLLISION')
        else:path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',required=True);parser.add_argument('--cuda',action='store_true')
    args=parser.parse_args();root=Path(args.root).resolve();build.public(str(root).encode());build.no_links(root)
    if root.exists():raise RuntimeError('FRESH_TOOL_ROOT_REQUIRED')
    root.mkdir(parents=True)
    cmake=build.load('cmake-inputs.json');selected_archive(fetch(cmake['url'],cmake['archiveSha256']),root/'cmake',cmake['files'])
    build.verify(root/'cmake',cmake['files'],exact=True)
    if args.cuda:
        cuda=build.load('cuda-toolchain-inputs.json')
        for component in cuda['components']:
            selected_archive(fetch(component['url'],component['archiveSha256'],component['archiveBytes']),root/'cuda-12.4',component['selectedFiles'])
        build.verify(root/'cuda-12.4',[row for c in cuda['components'] for row in c['selectedFiles']],exact=True)
    print(json.dumps({'prepared':True,'cuda':args.cuda,'executionEvidence':False}))

if __name__=='__main__':
    try:main()
    except Exception as failure:
        print(type(failure).__name__+': '+(str(failure) if isinstance(failure,RuntimeError) else 'TOOL_PREPARATION_DETAILS_SUPPRESSED'));raise SystemExit(1)
