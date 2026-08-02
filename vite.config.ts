import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// When the hex-world library repo sits next to this one, alias the package to
// its source so the editor tracks library HEAD with full HMR (no build step in
// the library needed). Cloners without the sibling repo fall through to the
// published npm package — package.json is untouched either way.
const libSrc = fileURLToPath(new URL('../hex-world/src/index.ts', import.meta.url));
const useLocalLib = existsSync(libSrc);

if (useLocalLib) {
  console.log('[hex-world-editor] using local library source at ../hex-world/src');
}

export default defineConfig({
  resolve: {
    alias: useLocalLib ? { '@loyalj/hex-world': libSrc } : {},
    // The sibling repo has its own three copy in node_modules; force a single
    // instance so instanceof checks and shader caches don't split.
    dedupe: ['three'],
  },
  server: {
    fs: {
      // Allow serving library source from outside the editor root in dev.
      allow: ['.', '..'],
    },
  },
});
