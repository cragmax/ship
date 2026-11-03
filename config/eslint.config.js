import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import jsdoc from 'eslint-plugin-jsdoc';
import sonarjs from 'eslint-plugin-sonarjs';
import tsdoc from 'eslint-plugin-tsdoc';
import tseslint from 'typescript-eslint';

// This repository's TypeScript, and its tests alone.
const TEST_FILES = ['test/**/*.{ts,mts,cts}'];

// sonarjs recommended rules whose target library or API appears nowhere in
// this codebase — zero findings, ~2.3s of gate:lint. Re-enable a group if its
// target lands (an HTTP server, TLS, XML parsing, …).
const IRRELEVANT_SONAR_RULES = [
  // AWS CDK
  'aws-apigateway-public-api',
  'aws-ec2-rds-dms-public',
  'aws-ec2-unencrypted-ebs-volume',
  'aws-efs-unencrypted',
  'aws-iam-all-privileges',
  'aws-iam-privilege-escalation',
  'aws-iam-public-access',
  'aws-opensearchservice-domain',
  'aws-rds-unencrypted-databases',
  'aws-restricted-ip-admin-access',
  'aws-s3-bucket-granted-access',
  'aws-s3-bucket-insecure-http',
  'aws-s3-bucket-public-access',
  'aws-s3-bucket-versioning',
  'aws-sagemaker-unencrypted-notebook',
  'aws-sns-unencrypted-topics',
  'aws-sqs-unencrypted-queue',
  // Web server: HTTP headers, cookies, sessions, uploads, template engines
  'content-length',
  'content-security-policy',
  'cookie-no-httponly',
  'cors',
  'csrf',
  'disabled-auto-escaping',
  'dynamically-constructed-templates',
  'file-uploads',
  'frame-ancestors',
  'hidden-files',
  'insecure-cookie',
  'no-ip-forward',
  'no-mime-sniff',
  'no-mixed-content',
  'no-referrer-policy',
  'no-session-cookies-on-static-assets',
  'production-debug',
  'session-regeneration',
  'strict-transport-security',
  'x-powered-by',
  // Browser, HTML, React, Angular
  'disabled-resource-integrity',
  'jsx-no-leaked-render',
  'link-with-target-blank',
  'no-angular-bypass-sanitization',
  'no-hook-setter-in-body',
  'no-intrusive-permissions',
  'no-table-as-layout',
  'no-uniq-key',
  'no-useless-react-setstate',
  'object-alt-content',
  'post-message',
  'prefer-read-only-props',
  'table-header',
  'table-header-reference',
  // Mocha / Chai (tests use vitest)
  'chai-determinate-assertion',
  'disabled-timeout',
  'no-incomplete-assertions',
  // TLS, ciphers, JWT, XML, archives, wallets (`hashing` stays: createHash is used)
  'encryption-secure-mode',
  'insecure-jwt-token',
  'no-unsafe-unzip',
  'no-weak-cipher',
  'no-weak-keys',
  'review-blockchain-mnemonic',
  'unverified-certificate',
  'unverified-hostname',
  'weak-ssl',
  'xml-parser-xxe',
];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  sonarjs.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {
      tsdoc: tsdoc,
      jsdoc: jsdoc,
      '@stylistic': stylistic,
    },
    // jsdoc's default `typescript` mode treats `typeParam` as an alias of `template` and
    // autofixes it into `@template`, a tag `tsdoc/syntax` rejects; TSDoc's tag is `@typeParam`.
    settings: { jsdoc: { tagNamePreference: { template: 'typeParam' } } },
    languageOptions: {
      parserOptions: {
        project: '../tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TSDoc syntax validation
      'tsdoc/syntax': 'error',

      // JSDoc presence enforcement for exported functions/classes
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      'jsdoc/require-description': [
        'error',
        {
          contexts: ['FunctionDeclaration', 'MethodDefinition', 'ClassDeclaration'],
        },
      ],
      'jsdoc/require-param': ['error', { checkDestructured: false }],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/no-types': 'error',
      'jsdoc/check-tag-names': [
        'error',
        {
          // Rejects the tags a type checker makes redundant, `@public` among them.
          typed: true,
          definedTags: ['silences', 'integrationTier'],
        },
      ],
      // Catch real bugs
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // Code quality
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',

      // Relax rules that are too noisy for this project
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // TODOs are intentional stubs for unbuilt features — disable the tag warning
      'sonarjs/todo-tag': 'off',
      // Nested template literals are readable in simple cases like log lines
      'sonarjs/no-nested-template-literals': 'off',
      // Duplicates @typescript-eslint/no-deprecated (strictTypeChecked) at ~3.5s of lint time
      'sonarjs/deprecation': 'off',
      ...Object.fromEntries(IRRELEVANT_SONAR_RULES.map((rule) => [`sonarjs/${rule}`, 'off'])),
      // Stricter complexity threshold for production code
      'sonarjs/cognitive-complexity': ['error', 8],

      // Blank lines between a function's paragraphs; Prettier keeps them but never adds one.
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['multiline-const', 'multiline-let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: '*', next: ['return', 'throw'] },
        { blankLine: 'always', prev: '*', next: 'multiline-block-like' },
        { blankLine: 'always', prev: 'multiline-block-like', next: '*' },
      ],
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
    },
  },
  {
    // A tag only where it carries a claim.
    files: ['src/**/*.ts', 'hooks/**/*.ts', ...TEST_FILES],
    ignores: ['**/*.test.ts'],
    rules: {
      'jsdoc/require-param': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/informative-docs': 'error',
      // 90: a collapsed one-line doc still fits 100 columns at four-space indent.
      'jsdoc/multiline-blocks': [
        'error',
        { noMultilineBlocks: true, minimumLengthForMultiline: 90 },
      ],
    },
  },
  {
    // The CLIs, the build scripts and the hooks shell out to git, gh and npm by design.
    files: ['src/cli/**/*.ts', 'src/build/**/*.ts', 'hooks/**/*.ts'],
    rules: {
      'sonarjs/no-os-command-from-path': 'off',
      'sonarjs/os-command': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
    },
  },
  {
    // The tool configs' plain JS sits in no tsconfig program, so it lints untyped.
    files: ['config/**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Test files get relaxed rules
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'sonarjs/publicly-writable-directories': 'off',
      'sonarjs/cognitive-complexity': ['error', 15],
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-returns-description': 'off',
    },
  },
  {
    // No vitest `typecheck` config runs, so `expectTypeOf` asserts nothing at runtime.
    files: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='expectTypeOf']",
          message: 'expectTypeOf is a runtime no-op here: use @ts-expect-error.',
        },
      ],
    },
  },
  {
    ignores: [
      'dist/',
      // The rendered saved workflows: build output, linted where a consumer installs them.
      'workflows/',
      'node_modules/',
      'coverage/',
      // A fixture repository a child vitest runs from its own folder, outside tsconfig.json.
      'test/fixtures/worktree-fixture-template/',
      // A CommonJS tool config, typed by JSDoc `@type` tags, which TSDoc rejects.
      'config/**/*.cjs',
    ],
  },
);
