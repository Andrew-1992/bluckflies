/**
 * npm run build:web -- --api https://<name>.ngrok-free.app [--site https://<project>.vercel.app]
 *
 * Builds web-dist/: the web client as a static site for Vercel, forwarding the
 * server's paths to --api (src/http/staticSite.ts; docs/TUNNEL-TEST.md).
 */
import { relative } from 'node:path';
import { buildWeb } from '../http/staticSite.js';

buildWeb(process.argv.slice(2)).then(
  ({ outDir, fingerprint, api }) => {
    console.log(`Built ${relative(process.cwd(), outDir) || outDir} (version ${fingerprint}). Server paths go to ${api}.`);
    console.log('Next: cd web-dist, then: npx vercel deploy --prod   (docs/TUNNEL-TEST.md)');
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
