"""Fetch and inspect public source/package artifacts. Never executes vendor code."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request

MAX_DOWNLOAD = 25 * 1024 * 1024


def fetch(url, maximum=MAX_DOWNLOAD):
    request = urllib.request.Request(url, headers={'User-Agent': 'token-optimizer-free-qualification/1.0'})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError('Artifact exceeds 25 MiB admission cap; choose a smaller official package')
    return data


def inspect(entry, destination):
    name = entry['name']
    if not re.fullmatch(r'[\w-]+', name):
        raise ValueError('Unsafe product name')
    result = {'name': name, 'checkedAt': datetime.now(timezone.utc).isoformat(),
              'activationQualified': False, 'paidCalls': 0}
    try:
        if name in ['tokenade', 'cto', 'tokenjuice', 'claude-mem', 'token-optimizer']:
            package = {'tokenade': '@tokenade/cli', 'cto': 'claude-token-optimizer', 'tokenjuice': 'tokenjuice', 'claude-mem': 'claude-mem', 'token-optimizer': 'token-optimizer'}[name]
            version = entry['latestPackage']
            metadata_url = f"https://registry.npmjs.org/{package.replace('/', '%2f')}/{version}"
            metadata = json.loads(fetch(metadata_url))
            url = metadata['dist']['tarball']
            expected = metadata['dist'].get('integrity')
            result.update(package=package, version=version, integrity=expected, metadataSource=metadata_url)
        elif name == 'headroom':
            version = entry['latestPackage']
            metadata_url = f'https://pypi.org/pypi/headroom-ai/{version}/json'
            metadata = json.loads(fetch(metadata_url))
            distribution = next(r for r in metadata['urls'] if r['packagetype'] == 'sdist')
            url = distribution['url']
            expected = 'sha256-' + base64.b64encode(bytes.fromhex(distribution['digests']['sha256'])).decode()
            result.update(package='headroom-ai', version=version, integrity=expected, metadataSource=metadata_url)
        else:
            repo = entry.get('canonicalRepo') or entry.get('repo')
            if not entry.get('head'):
                raise ValueError('Canonical upstream unresolved; no artifact downloaded')
            ref = entry.get('productRelease') or entry.get('release')
            ref = ref or entry['head']
            url = f'https://codeload.github.com/{repo}/tar.gz/{ref}'
            expected = None
            result.update(repository=repo, ref=ref)
        cache = destination / 'archives' / (name + '.tgz')
        provenance = cache.with_suffix('.json')
        if cache.exists() and provenance.exists() and json.loads(provenance.read_text())['url'] == url:
            data = cache.read_bytes()
        else:
            # Copium's official source includes assets; allow its larger archive
            # rather than excluding a product because of our download default.
            data = fetch(url, 100 * 1024 * 1024 if name == 'copium' else MAX_DOWNLOAD)
        if expected:
            algorithm, encoded = expected.split('-', 1)
            if algorithm not in ['sha512', 'sha256'] or hashlib.new(algorithm, data).digest() != base64.b64decode(encoded):
                raise ValueError('Registry artifact integrity mismatch')
        digest = hashlib.sha256(data).hexdigest()
        cache.write_bytes(data)
        provenance.write_text(json.dumps({'url': url, 'sha256': digest}, indent=2), encoding='utf-8')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            members = archive.getmembers()
            if sum(m.size for m in members) > 200 * 1024 * 1024:
                raise ValueError('Uncompressed archive exceeds 200 MiB admission cap')
            regular = [m for m in members if m.isfile()]
            readmes = [m for m in regular if Path(m.name).name.lower() in ['readme.md', 'readme.rst', 'readme'] and m.size < 2 * 1024 * 1024]
            readmes.sort(key=lambda m: (m.name.count('/'), m.name))
            body = archive.extractfile(readmes[0]).read().decode('utf-8', errors='replace') if readmes else ''
            (destination / 'readmes' / (name + '.md')).write_text(body, encoding='utf-8')
            configs = [m.name for m in regular if re.search(r'(?:hooks?|mcp|codex|opencode|install|setup)', m.name, re.I)]
            definitions = [m for m in regular if Path(m.name).name in ['package.json', 'pyproject.toml', 'Cargo.toml'] and m.name.count('/') <= 2 and m.size < 100000]
            definition_text = {m.name: archive.extractfile(m).read().decode('utf-8', errors='replace') for m in definitions[:8]}
        result.update(status='source_verified', source=url, sha256=digest, bytes=len(data),
                      documentedClients=[client for client in ['codex', 'claude', 'opencode', 'gemini', 'cursor', 'copilot'] if re.search(r'\b' + client + r'\b', body, re.I)],
                      integrationFiles=configs[:160], packageDefinitions=definition_text,
                      requiresPaidProviderReview=bool(re.search(r'API.key|embedding|OpenAI|Anthropic', body, re.I)))
        if name == 'tokf':
            result['pending'] = 'Map monorepo product release; catalog-types release is not a product pin'
        if name == 'squeez':
            result['pending'] = 'Qualify GitHub v1.49.3 artifact; registry stable is older'
    except Exception as error:
        result.update(status='source_blocked', error=str(error))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--matrix', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for child in ['archives', 'readmes']:
        (args.output / child).mkdir(parents=True, exist_ok=True)
    matrix = json.loads(args.matrix.read_text(encoding='utf-8'))['entries']
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda entry: inspect(entry, args.output), matrix))
    (args.output / 'source-inventory.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'products': len(results), 'sourceVerified': sum(r['status'] == 'source_verified' for r in results),
                      'blocked': [{'name': r['name'], 'error': r.get('error')} for r in results if r['status'] != 'source_verified'],
                      'activationQualified': 0, 'paidCalls': 0}, indent=2), flush=True)


if __name__ == '__main__':
    main()
