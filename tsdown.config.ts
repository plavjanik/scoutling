import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  // The package is `type: module`, so plain `.js` is already ESM — keep the
  // published paths (`bin` → dist/cli.js) free of a bundler-specific extension.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    // @vscode/ripgrep resolves a per-platform binary downloaded at install time;
    // it must stay a real dependency rather than be inlined into the bundle.
    neverBundle: ['@vscode/ripgrep'],
  },
})
