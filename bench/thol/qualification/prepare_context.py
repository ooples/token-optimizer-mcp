"""Build context from hash-verified public archives; never execute vendor code."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile


def prepare(cache, destination, products):
    destination.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(Path(__file__).with_name('Dockerfile'), destination / 'Dockerfile')
    receipts = []
    for name in products:
        archive = cache / 'archives' / (name + '.tgz')
        source = json.loads(archive.with_suffix('.json').read_text())
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != source['sha256']:
            raise ValueError('Archive changed: ' + name)
        target = destination / 'vendor' / name
        target.mkdir(parents=True)
        with tarfile.open(archive) as package:
            for member in package.getmembers():
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts:
                    raise ValueError('Unsafe archive path')
                relative = Path(*path.parts[1:])
                if not relative.parts:
                    continue
                if member.isdir():
                    (target / relative).mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    output = target / relative
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_bytes(package.extractfile(member).read())
                    output.chmod(member.mode & 0o777)
                else:
                    raise ValueError('Archive links/devices not admitted: ' + member.name)
        receipts.append({'name': name, **source})
    (destination / 'sources.json').write_text(json.dumps(receipts, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--products', default='caveman,ponytail,token-saving-hooks-codex')
    args = parser.parse_args()
    prepare(args.cache, args.output, args.products.split(','))
