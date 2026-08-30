import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * The dashboard must not reach the network.
 *
 * It shipped with `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/...">`
 * and no integrity attribute, which meant three things at once: charts broke
 * offline or air-gapped, a third-party request went out from a page displaying
 * the user's own project data, and a compromised CDN could run arbitrary code
 * in it.
 *
 * This is the guard rather than a note in a review, because a single pasted
 * <script> tag is all it takes to undo.
 */
const PUBLIC = join(process.cwd(), 'src', 'dashboard', 'public');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

describe('the dashboard is self-contained', () => {
  const assets = filesUnder(PUBLIC).filter((f) => /\.(html|js|css)$/.test(f));

  it('has assets to check', () => {
    expect(assets.length).toBeGreaterThan(3);
  });

  it.each(assets.map((f) => [f.replace(PUBLIC, '').replace(/\\/g, '/'), f]))(
    '%s loads nothing from a remote origin',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');

      // Any absolute URL in a src=, href= or url() is a network dependency.
      const remoteRefs = [
        ...source.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']/gi),
        ...source.matchAll(/url\(\s*["']?(https?:)?\/\/[^)"']+/gi),
        ...source.matchAll(/@import\s+(?:url\()?["'](https?:)?\/\//gi),
      ].map((m) => m[0]);

      expect(remoteRefs).toEqual([]);
    }
  );

  it.each(assets.map((f) => [f.replace(PUBLIC, '').replace(/\\/g, '/'), f]))(
    '%s does not fetch a remote origin at runtime',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const calls = [
        ...source.matchAll(/fetch\(\s*[`'"](https?:)?\/\//gi),
        ...source.matchAll(
          /new\s+(?:WebSocket|EventSource)\(\s*[`'"][a-z]+:\/\//gi
        ),
        ...source.matchAll(
          /XMLHttpRequest[\s\S]{0,80}?open\([^)]*[`'"]https?:\/\//gi
        ),
      ].map((m) => m[0]);

      expect(calls).toEqual([]);
    }
  );

  it('vendors chart.js locally instead of pulling it from a CDN', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    );

    // Pinned exactly: a caret range would let the dependency change under us,
    // which is the supply-chain half of what was wrong with the CDN.
    expect(pkg.dependencies['chart.js']).toBe('4.4.0');

    // The vendoring step moved out of an inline `node -e` in copy:assets and
    // into scripts/copy-assets.mjs, so that a missing chart.js could fail with a
    // remedy instead of a bare ENOENT. Assert it where it now lives -- deleting
    // the vendoring from that module must still fail this test.
    expect(pkg.scripts['copy:assets']).toContain('scripts/copy-assets.mjs');
    const copyAssets = readFileSync(
      join(process.cwd(), 'scripts', 'copy-assets.mjs'),
      'utf8'
    );
    expect(copyAssets).toContain('chart.umd.min.js'); // the vendored target
    expect(copyAssets).toContain('chart.umd.js'); // sourced from the local package
    expect(copyAssets).not.toMatch(/https?:\/\/[^\s'"]*chart/i); // never a CDN

    // And the loader points at the local copy.
    const charts = readFileSync(join(PUBLIC, 'js', 'charts.js'), 'utf8');
    expect(charts).toContain('/vendor/chart.umd.min.js');
  });

  it('ships the vendored file when the assets have been built', () => {
    const built = join(
      process.cwd(),
      'dist',
      'dashboard',
      'public',
      'vendor',
      'chart.umd.min.js'
    );
    if (!existsSync(join(process.cwd(), 'dist', 'dashboard', 'public'))) return;
    expect(existsSync(built)).toBe(true);
  });

  it('never loads the charting library on first paint', () => {
    // Vendoring it is only half the win. Parsing 120 KB on every page load, for
    // pages that draw plain SVG, would be the other half thrown away -- so no
    // page may reference it with a static tag.
    for (const page of ['index.html', 'wiki.html']) {
      const html = readFileSync(join(PUBLIC, page), 'utf8');
      // The page must actually have scripts: a page with none satisfies the
      // absence below while being a different (and broken) page entirely.
      expect(html).toMatch(/<script/i);
      expect(html).not.toMatch(/<script[^>]+chart\.umd/i);
    }
  });
});
