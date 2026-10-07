/**
 * THE SSRF GUARD, AND THE ADDRESSES IT MUST REFUSE (CWE-918, issue #454).
 *
 * `smart_api_fetch` took a caller-supplied URL to `fetch` with
 * `redirect: 'follow'`, so anything able to invoke the tool -- a prompt
 * injection included -- could read loopback, RFC1918 and cloud metadata and
 * get status, headers and body back. Redirects went to any host with the
 * caller's headers re-sent, so an allowed first hop could hand an API key to a
 * second one.
 */
import { describe, expect, it } from '@jest/globals';
import { ssrfRefusal } from '../../../src/tools/api-database/ssrf-guard.js';

describe('what smart_api_fetch refuses to reach', () => {
  it('allows ordinary public http and https', () => {
    for (const url of [
      'https://api.example.com/v1/things',
      'http://example.org:8080/path?q=1',
      'https://8.8.8.8/resolve',
    ])
      expect(ssrfRefusal(url)).toBeNull();
  });

  it('refuses every scheme that is not http or https', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://example.com/',
      'data:text/plain,hello',
      'ftp://example.com/x',
    ])
      expect(ssrfRefusal(url)).toMatch(/refusing scheme/);
  });

  it('refuses loopback by address and by name', () => {
    for (const url of [
      'http://127.0.0.1:17094/v1/messages',
      'http://127.1.2.3/',
      'http://[::1]:8080/',
      'http://localhost:3000/',
      'http://ip6-localhost/',
      'http://app.localhost/',
    ])
      expect(ssrfRefusal(url)).not.toBeNull();
  });

  it('refuses the cloud metadata endpoints, which hand out credentials', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/computeMetadata/v1/',
    ])
      expect(ssrfRefusal(url)).not.toBeNull();
  });

  it('refuses the private and carrier ranges', () => {
    for (const url of [
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
    ])
      expect(ssrfRefusal(url)).not.toBeNull();
  });

  it('refuses the unspecified address, which reaches loopback on many stacks', () => {
    expect(ssrfRefusal('http://0.0.0.0:8080/')).not.toBeNull();
    expect(ssrfRefusal('http://[::]/')).not.toBeNull();
  });

  it('refuses an IPv4-mapped IPv6 address, which carries the v4 rules', () => {
    expect(ssrfRefusal('http://[::ffff:127.0.0.1]/')).not.toBeNull();
    expect(ssrfRefusal('http://[::ffff:169.254.169.254]/')).not.toBeNull();
  });

  it('allows a public address just outside each blocked range', () => {
    // THE POSITIVE CONTROL for the range arithmetic: a guard that refused
    // everything would pass every case above and be useless.
    for (const url of [
      'http://11.0.0.1/',
      'http://172.15.0.1/',
      'http://172.32.0.1/',
      'http://192.169.0.1/',
      'http://100.63.255.255/',
      'http://169.253.0.1/',
    ])
      expect(ssrfRefusal(url)).toBeNull();
  });

  it('refuses something that is not a URL at all', () => {
    expect(ssrfRefusal('not a url')).not.toBeNull();
    expect(ssrfRefusal('')).not.toBeNull();
  });
});
