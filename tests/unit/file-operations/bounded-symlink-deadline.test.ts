import { beforeEach, expect, it, jest } from '@jest/globals';

const targetStat =
  jest.fn<(...args: unknown[]) => Promise<{ isFile(): boolean }>>();
let entries: {
  fullpath(): string;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}[];
jest.unstable_mockModule('glob', () => ({
  globIterate: async function* () {
    yield* entries;
  },
}));
jest.unstable_mockModule('fs/promises', () => ({
  stat: targetStat,
  readdir: jest.fn(),
}));
const { boundedGlob } = await import(
  '../../../src/tools/shared/bounded-traversal.js'
);
beforeEach(() => {
  targetStat.mockReset();
  entries = [];
});

it('rejects special entries before they consume the file cap', async () => {
  entries = [
    {
      fullpath: () => '/tree/socket',
      isFile: () => false,
      isSymbolicLink: () => false,
    },
    {
      fullpath: () => '/tree/file',
      isFile: () => true,
      isSymbolicLink: () => false,
    },
  ];
  const result = await boundedGlob('*', { cwd: '/tree', nodir: true, cap: 1 });
  expect(result.items).toEqual(['file']);
  expect(targetStat).not.toHaveBeenCalled();
});

it('returns at the deadline while a symlink target remains pending', async () => {
  entries = [
    {
      fullpath: () => '/tree/link',
      isFile: () => false,
      isSymbolicLink: () => true,
    },
  ];
  let rejectTarget!: (error: Error) => void;
  targetStat.mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectTarget = reject;
      })
  );
  const result = await boundedGlob('*', {
    cwd: '/tree',
    nodir: true,
    deadlineMs: 20,
  });
  expect(result.items).toEqual([]);
  expect(result.truncatedBy).toBe('deadline');
  rejectTarget(new Error('late stat failure'));
  await new Promise((resolve) => setImmediate(resolve));
});
