"""Retain workspace bytes for independent grading; never archive the agent HOME."""
import hashlib
import json
import os
import posixpath
from pathlib import Path
import tarfile


def retain(workspace, destination):
    workspace = Path(workspace).resolve()
    if not workspace.is_dir():
        raise ValueError('Workspace directory is missing')
    destination = Path(destination).resolve()
    if destination.is_relative_to(workspace):
        raise ValueError('Evidence must be outside the workspace')
    destination.mkdir(parents=True, exist_ok=False)
    manifest = {}
    links = {}
    with tarfile.open(destination / 'workspace.tar', 'w') as archive:
        for path in sorted(workspace.rglob('*')):
            if path.is_symlink():
                target = os.readlink(path)
                if Path(target).is_absolute() or not path.resolve().is_relative_to(workspace):
                    raise ValueError('Workspace link escapes the workspace or is absolute')
                relative = path.relative_to(workspace).as_posix()
                links[relative] = target
                archive.add(path, arcname=relative, recursive=False)
                continue
            if not (path.is_dir() or path.is_file()):
                raise ValueError('Workspace special file requires explicit handling')
            if path.is_file():
                relative = path.relative_to(workspace).as_posix()
                manifest[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
                info = archive.gettarinfo(str(path), arcname=relative)
                # Materialize hard-linked files; do not create implicit link members.
                info.type = tarfile.REGTYPE
                info.linkname = ''
                info.size = path.stat().st_size
                with path.open('rb') as stream:
                    archive.addfile(info, stream)
    digest = hashlib.sha256((destination / 'workspace.tar').read_bytes()).hexdigest()
    result = {'archiveSha256': digest, 'files': manifest, 'links': links}
    (destination / 'workspace.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def verify_archive(destination):
    destination = Path(destination)
    receipt = json.loads((destination / 'workspace.json').read_text())
    archive = destination / 'workspace.tar'
    if hashlib.sha256(archive.read_bytes()).hexdigest() != receipt['archiveSha256']:
        raise ValueError('Workspace archive hash changed')
    observed = {}
    links = {}
    with tarfile.open(archive) as package:
        for member in package.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or member.name in observed or member.name in links:
                raise ValueError('Unsafe or duplicate workspace member')
            if member.issym():
                links[member.name] = member.linkname
            elif member.isfile():
                observed[member.name] = hashlib.sha256(package.extractfile(member).read()).hexdigest()
            else:
                raise ValueError('Unsupported workspace member')
    def resolve(name, seen=()):
        normalized = posixpath.normpath(name)
        if normalized.startswith('/') or normalized == '..' or normalized.startswith('../'):
            raise ValueError('Workspace link escapes archive')
        parts = normalized.split('/')
        for end in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:end])
            if prefix in links:
                if prefix in seen:
                    raise ValueError('Cyclic archive link')
                target = links[prefix]
                if target.startswith('/'):
                    raise ValueError('Absolute archive link')
                return resolve(posixpath.join(posixpath.dirname(prefix), target, *parts[end:]), seen + (prefix,))
        return normalized
    for name in links:
        resolve(name)
    for name in list(observed) + list(links):
        parents = name.split('/')[:-1]
        if any('/'.join(parents[:end]) in links for end in range(1, len(parents) + 1)):
            raise ValueError('Archive member beneath a symlink')
    if observed != receipt['files'] or links != receipt.get('links', {}):
        raise ValueError('Workspace contents do not match manifest')
    return receipt
