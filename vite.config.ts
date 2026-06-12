import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    trailingComma: "none",
    printWidth: 80,
    experimentalSortPackageJson: false,
    ignorePatterns: [
      "examples/think-tanstack-start/src/routeTree.gen.ts",
      "packages/agents/CHANGELOG.md",
      "site/agents/.astro"
    ]
  },
  lint: {
    plugins: ["react", "jsx-a11y", "typescript"],
    categories: {
      correctness: "error"
    },
    rules: {
      "no-explicit-any": "error",
      "no-unused-expressions": "off",
      "typescript/no-deprecated": "warn",
      "no-this-alias": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "vite-plus/prefer-vite-plus-imports": "error"
    },
    ignorePatterns: [
      "**/env.d.ts",
      "examples/think-tanstack-start/src/routeTree.gen.ts"
    ],
    options: {
      typeAware: false,
      typeCheck: false
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin"
      }
    ],
    overrides: [
      {
        files: ["packages/agents/src/vite.ts"],
        rules: {
          "vite-plus/prefer-vite-plus-imports": "off"
        }
      }
    ]
  },
  run: {
    cache: {
      scripts: false,
      tasks: true
    },
    tasks: {
      build: {
        command: [
          "vp run --filter './packages/*' --filter './voice-providers/*' --concurrency-limit 1 build",
          "vp run --filter './examples/*' build"
        ],
        input: [
          { auto: true },
          "!**/.wrangler/**",
          "!**/build/**",
          "!**/dist/**",
          "!**/node_modules/.vite/**",
          "!**/*.tsbuildinfo"
        ],
        output: [
          { pattern: "examples/*/build/**", base: "workspace" },
          { pattern: "examples/*/dist/**", base: "workspace" },
          { pattern: "packages/*/dist/**", base: "workspace" },
          { pattern: "voice-providers/*/dist/**", base: "workspace" }
        ]
      },
      typecheck: {
        command: "tsx scripts/typecheck.ts"
      },
      "check:exports": {
        command: "tsx scripts/check-exports.ts"
      },
      check: {
        command:
          "sherif && vp run check:exports && vp check && vp run typecheck"
      },
      test: {
        command: "vp run build && vp run -r test"
      },
      ci: {
        command: "vp run build && vp run check && vp run test"
      },
      "test:e2e": {
        command: "vp run -r test:e2e --concurrency-limit 1"
      },
      "test:react": {
        command: "vp run agents#test:react"
      },
      "prepare:playwright": {
        command: "playwright install --with-deps chromium"
      }
    }
  },
  staged: {
    "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte,css}": "vp check --fix"
  }
});
