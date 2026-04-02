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

  // ── Shared TypeScript config ─────────────────────────────────
  // Extracted to avoid duplication between backend and test configs.
  ...[
    { name: 'backend/node-ts', files: ['src/**/*.ts'], ignores: ['src/web-map/public/**'] },
    { name: 'tests/node-test-ts', files: ['test/**/*.ts'] },
  ].map((target) => ({
    ...target,
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
  })),

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

  // ── Prettier (must be last — disables conflicting format rules) ──
  prettierConfig,
]);
