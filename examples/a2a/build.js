import { build } from 'esbuild';

await build({
  bundle: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  entryPoints: ['src/server.ts'],
  external: [
    'express',
    'cloudflare:workers'
  ],
  format: 'esm',
  logLevel: 'info',
  mainFields: ['module', 'main'],
  minify: true,
  outfile: 'dist/server.js',
  platform: 'node',
  sourcemap: true,
  target: 'es2022',
}); 