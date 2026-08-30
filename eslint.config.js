import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import nodePlugin from 'eslint-plugin-n';
import prettierConfig from 'eslint-config-prettier';
import noVacuousAssertions from './eslint-rules/no-vacuous-assertions.mjs';

export default [
  {
    // TEST FILES ARE NOT IGNORED HERE, DELIBERATELY.
    //
    // They were, and that is why four vacuous-assertion defects shipped in one
    // day behind a green suite: no lint rule could ever have seen them. The
    // typed `src` block below is scoped to `src/**`, so tests were never part of
    // the TypeScript program anyway -- ignoring them bought nothing and cost the
    // only automated check that reads test QUALITY rather than test syntax.
    ignores: [
      '**/public/**/*.js',
      'dist/**',
      'node_modules/**',
    ],
  },
  {
    files: ['src/**/*.ts'],
    // Co-located test files are handled by the test block at the bottom of this
    // file. Excluded HERE rather than overridden there, because flat config
    // MERGES languageOptions and rules across every matching block: a later
    // block cannot take back this one's `parserOptions.project` (which rejects
    // any file tsconfig.json does not list) nor its typed rules.
    ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
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

  // Test files: only the rules that are about TEST QUALITY. Deliberately not
  // the full TypeScript program -- these run without type information so the
  // check stays fast and cannot fail on a fixture that does not typecheck.
  {
    // Listed explicitly: brace expansion crashes the minimatch bundled with
    // this @eslint/config-array (TypeError: expand is not a function).
    files: ['tests/**/*.js', 'tests/**/*.mjs', 'tests/**/*.cjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { local: { rules: { 'no-vacuous-assertions': noVacuousAssertions } } },
    rules: { 'local/no-vacuous-assertions': 'error' },
  },
  {
    // The same rule over TypeScript syntax. `project` is omitted on purpose:
    // this needs the PARSER, not the type checker, so the check stays fast and
    // cannot fail on a fixture that does not typecheck.
    // `src/**/*.test.ts` is here too, and must come AFTER the typed `src` block
    // so these languageOptions win. Those files are not listed in tsconfig.json,
    // so the typed block's `parserOptions.project` rejects them outright --
    // which is how three co-located test files ended up unlintable rather than
    // merely unchecked.
    files: [
      'tests/**/*.ts',
      'tests/**/*.mts',
      'tests/**/*.tsx',
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: {
      local: { rules: { 'no-vacuous-assertions': noVacuousAssertions } },
      // Declared but not enabled: test files carry inline disables for typed
      // rules, and an unresolvable rule name in a disable comment is itself an
      // error. Registering the plugin makes those names resolve without
      // dragging the type checker into the test lint.
      '@typescript-eslint': tseslint,
    },
    rules: { 'local/no-vacuous-assertions': 'error' },
  },
];
