import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Independently checks the frozen probe's answer and full recovery data.
 * This is a fixture oracle, not a general decoder or model-quality evaluation.
 */
export async function auditChatProbe(directory) {
  const samples = JSON.parse(
    await readFile(join(directory, 'wire.json'), 'utf8')
  );
  const checks = [];
  for (const sample of samples.filter((row) => row.arm === 'proxy')) {
    const sent = JSON.parse(sample.wire);
    const content = sent.messages[3].content;
    const expected = Array.from({ length: 80 + sample.sample }, (_, id) => ({
      id: `case-${sample.sample}-row-${id}`,
      state: id === 17 ? 'failed' : 'ready',
      region: 'east',
      description: 'Shared diagnostic record description',
      value: id * 17 + sample.sample,
    }));
    const answerVisible = content.includes(JSON.stringify(expected[17]));
    const location = content.match(/ -> ([^\r\n]+\.json)\]\]/)?.[1];
    let recoverable = false;
    if (location) {
      const root = resolve(tmpdir(), 'token-optimizer-spill');
      const path = resolve(location);
      if (!path.startsWith(root + (process.platform === 'win32' ? '\\' : '/')))
        throw Error('Unexpected recovery location');
      const recovered = JSON.parse(await readFile(path, 'utf8'));
      recoverable = JSON.stringify(recovered) === JSON.stringify(expected);
    }
    checks.push({
      sample: sample.sample,
      answerVisible,
      recoverable,
      metadataPreserved: sample.preserved,
    });
  }
  const passed =
    checks.length === 8 &&
    checks.every(
      (row) => row.answerVisible && row.recoverable && row.metadataPreserved
    );
  return { passed, checks };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await auditChatProbe(process.argv[2]);
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
