// eslint.config.js — ESLint v10 flat config (CommonJS)
// Environments: backend Node.js, test (node:test), frontend browser, game-server agent

const { defineConfig, globalIgnores } = require('eslint/config');
const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier/flat');
const tseslint = require('typescript-eslint');

// ── Shared rule presets ─────────────────────────────────────
const sharedRules = {
  // Allow == null / != null (intentional null+undefined check), require === elsewhere
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  // console.log is the project's logging mechanism (patched in index.js)
  'no-console': 'off',
  // Empty catch blocks are common (intentional silent catches) — allow them
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Unused vars: allow _-prefixed (conventional "intentionally unused")
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
};

module.exports = defineConfig([
  // ── Global ignores ──────────────────────────────────────────
  globalIgnores([
    'node_modules/',
    'data/',
    'dist/',
    'src/web-map/public/tailwind.css',
    'src/web-map/public/tiles/',
    'src/game-server/humanitz-agent.js',
    'qs-anticheat/',
    '.dev/',
    '_*.js',
    '*.bak',
    'temp/',
  ]),

  // ── Backend: Node.js CommonJS (.js) ─────────────────────────
  {
    name: 'backend/node-cjs',
    files: ['src/**/*.js', 'setup.js', 'eslint.config.js'],
    ignores: ['src/web-map/public/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      ...sharedRules,
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ── Backend TypeScript config ─────────────────────────────────
  {
    name: 'backend/node-ts',
    files: ['src/**/*.ts'],
    ignores: ['src/web-map/public/**'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ── Test TypeScript config ──────────────────────────────────
  {
    name: 'tests/node-test-ts',
    files: ['test/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      'no-var': 'error',
      'prefer-const': 'error',
      // Tests use mocks with partial interfaces — these rules are too strict for test code
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // ── Tests: node:test framework (JS) ────────────────────────
  {
    name: 'tests/node-test',
    files: ['test/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      ...sharedRules,
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ── Frontend: browser JS (no bundler, CDN globals) ──────────
  {
    name: 'frontend/browser',
    files: ['src/web-map/public/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // CDN-loaded libraries
        L: 'readonly', // Leaflet
        Chart: 'readonly', // Chart.js
        gsap: 'readonly', // GSAP
        tippy: 'readonly', // Tippy.js
        lucide: 'readonly', // Lucide Icons
        i18next: 'readonly', // i18next core
        i18nextHttpBackend: 'readonly', // i18next HTTP backend plugin
        i18nextBrowserLanguageDetector: 'readonly', // i18next browser language detector
        // Cross-file globals (defined in other <script> files on the same page)
        authFetch: 'readonly', // app.js — authenticated fetch wrapper
        translateDOM: 'readonly', // js/i18n.js — DOM translation helper
        markersGroup: 'readonly', // app.js — Leaflet layer group
        map: 'readonly', // app.js — Leaflet map instance
        simplifyName: 'readonly', // app.js — UE4 name simplifier
        Panel: 'writable', // panel-core.js — modular panel namespace
        switchTab: 'writable', // panel-nav.js — global tab switcher
        // app.js — functions called from HTML onclick attributes
        selectPlayer: 'writable',
        closePlayerPanel: 'writable',
        refreshPlayers: 'writable',
        kickPlayer: 'writable',
        banPlayer: 'writable',
        sendMessage: 'writable',
      },
    },
    rules: {
      ...sharedRules,
      // Frontend uses var extensively (panel.js: 500+ usages) — no enforcement
      'no-var': 'off',
      'prefer-const': 'off',
      // var re-declarations are expected in non-modular 6000+ line file
      'no-redeclare': 'off',
      // Object.hasOwn() preferred but hasOwnProperty is widespread in legacy frontend — disabled
      'no-prototype-builtins': 'off',
    },
  },

  // ── Migration debt: files with untyped method bodies ──────────────
  // These files have typed class fields and constructor deps (Phase 9)
  // but method bodies still process untyped config/db/discord data.
  // Rules are relaxed per-file until full method-body typing is complete.
  // Track progress: grep -c 'no-unsafe' eslint.config.js
  {
    name: 'backend/migration-debt',
    files: ['src/db/database.ts', 'src/web-map/server.ts'],
    rules: {
      // Core any/unsafe rules — every file in the list needs these
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Arithmetic / template rules tripped by `any` operands
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      // Promise handling in event-driven modules
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Assertions & conditions on untyped data
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-unnecessary-template-expression': 'off',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Misc patterns in untyped method bodies
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
    },
  },

  // ── Prettier (must be last — disables conflicting format rules) ──
  prettierConfig,
]);
