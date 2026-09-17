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
    const expected = Array.from({ length: 80 + sample.sample }, (_, id) => ({
      id: `case-${sample.sample}-row-${id}`,
      state: id === 17 ? 'failed' : 'ready',
      region: 'east',
      description: 'Shared diagnostic record description',
      value: id * 17 + sample.sample,
    }));
    const payloads = [];
    for (let repeat = 0; repeat < (sample.sample % 3) + 1; repeat++) {
      const index = 3 + repeat * 2;
      const message = sent.messages?.[index];
      const content =
        typeof message?.content === 'string' ? message.content : '';
      let answerVisible = content.includes(JSON.stringify(expected[17]));
      let recoverable = false;
      try {
        recoverable =
          JSON.stringify(JSON.parse(content)) === JSON.stringify(expected);
      } catch {
        /* Compressed text is checked through its recovery location. */
      }
      if (recoverable) answerVisible = true;
      const reference =
        /^\[Repeated observation: identical content to messages\[(\d+)\]\.content\.\]$/.exec(
          content
        );
      if (reference) {
        const prior = payloads.find((p) => p.index === Number(reference[1]));
        answerVisible = prior?.answerVisible ?? false;
        recoverable = prior?.recoverable ?? false;
      }
      const location = content.match(/ -> ([^\r\n]+\.json)\]\]/)?.[1];
      if (location) {
        const root = resolve(tmpdir(), 'token-optimizer-spill');
        const path = resolve(location);
        if (
          !path.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))
        )
          throw Error('Unexpected recovery location');
        try {
          const recovered = JSON.parse(await readFile(path, 'utf8'));
          recoverable = JSON.stringify(recovered) === JSON.stringify(expected);
        } catch {
          recoverable = false;
        }
      }
      payloads.push({
        index,
        answerVisible,
        recoverable,
        metadataPreserved:
          message?.role === 'tool' &&
          message?.tool_call_id === `call-${repeat}`,
      });
    }
    checks.push({
      sample: sample.sample,
      payloads,
      answerVisible: payloads.every((p) => p.answerVisible),
      recoverable: payloads.every((p) => p.recoverable),
      metadataPreserved:
        sample.preserved &&
        payloads.every((p) => p.metadataPreserved) &&
        sent.messages?.length === 2 + payloads.length * 2,
    });
  }
  const passed =
    checks.length === 8 &&
    new Set(checks.map((row) => row.sample)).size === 8 &&
    checks.every(
      (row) => Number.isInteger(row.sample) && row.sample >= 0 && row.sample < 8
    ) &&
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
