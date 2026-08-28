import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import nodePlugin from 'eslint-plugin-n';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.test.js',
      '**/*.spec.js',
      '**/public/**/*.js',
      'dist/**',
      'node_modules/**',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      n: nodePlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // SYNCHRONOUS I/O IS THE DEFECT CLASS BEHIND #335, and this is the
      // industry-standard detector for it rather than another bespoke test.
      //
      // A `*Sync` call blocks the event loop for its whole duration, so while
      // one runs this server cannot answer a ping, a cancel, or anything else.
      // That is why the reported hangs had to be KILLED rather than timing out:
      // `globSync` over a large tree held the loop for 178 seconds. It is also
      // why the cost compounds -- 12,000 serial `readFileSync` calls at ~2 ms
      // each is 25 seconds that overlapping I/O would have hidden.
      //
      // ERROR, NOT WARN, because this codebase already carries ~538 warnings
      // and one more would be invisible. The existing 63 call sites are
      // recorded in `eslint-suppressions.json` instead, so they neither block
      // the build nor quietly become permanent: `--prune-suppressions` fails
      // once a suppressed site is fixed and not removed, which is what makes
      // the list shrink-only.
      //
      // `allowAtRootLevel` permits module-initialisation reads, where blocking
      // is the correct behaviour -- nothing is being served yet.
      'n/no-sync': ['error', { allowAtRootLevel: true }],
    },
  },
  prettierConfig,
];
