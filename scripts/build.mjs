// Bundles the Electron main process, preload script and renderer into dist/.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await Promise.all([
  // Dependencies stay in node_modules (native DAVE module, discord.js...).
  build({ ...common, entryPoints: ['src/app/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', packages: 'external', external: ['electron'] }),
  // Sandboxed preloads cannot require local files: bundle everything.
  build({ ...common, entryPoints: ['src/app/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', target: 'chrome130' }),
]);

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/style.css', 'dist/renderer/style.css');
cpSync('build/icon.png', 'dist/icon.png');
