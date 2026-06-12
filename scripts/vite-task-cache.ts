type CacheInput = Array<
  string | { auto: true } | { pattern: string; base: "workspace" }
>;

const input: CacheInput = [
  { auto: true },
  "!.wrangler/**",
  "!build/**",
  "!dist/**",
  "!node_modules/.vite/**",
  "!src/vendor/typescript.browser.js",
  { pattern: "!node_modules/.vite-temp/**", base: "workspace" }
];

export const packageBuildTask = {
  command: "tsx ./scripts/build.ts",
  input,
  output: ["dist/**"]
};

export const viteBuildTask = {
  command: "vp build",
  input,
  output: ["build/**", "dist/**"]
};
