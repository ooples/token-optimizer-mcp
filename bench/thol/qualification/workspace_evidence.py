"""Retain workspace bytes for independent grading; never archive the agent HOME."""
import hashlib
import json
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
    with tarfile.open(destination / 'workspace.tar', 'w') as archive:
        for path in sorted(workspace.rglob('*')):
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise ValueError('Workspace links and special files require explicit handling')
            if path.is_file():
                relative = path.relative_to(workspace).as_posix()
                manifest[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
                archive.add(path, arcname=relative, recursive=False)
    digest = hashlib.sha256((destination / 'workspace.tar').read_bytes()).hexdigest()
    result = {'archiveSha256': digest, 'files': manifest}
    (destination / 'workspace.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def verify_archive(destination):
    destination = Path(destination)
    receipt = json.loads((destination / 'workspace.json').read_text())
    archive = destination / 'workspace.tar'
    if hashlib.sha256(archive.read_bytes()).hexdigest() != receipt['archiveSha256']:
        raise ValueError('Workspace archive hash changed')
    observed = {}
    with tarfile.open(archive) as package:
        for member in package.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not member.isfile() or member.name in observed:
                raise ValueError('Unsafe or duplicate workspace member')
            observed[member.name] = hashlib.sha256(package.extractfile(member).read()).hexdigest()
    if observed != receipt['files']:
        raise ValueError('Workspace contents do not match manifest')
    return receipt
