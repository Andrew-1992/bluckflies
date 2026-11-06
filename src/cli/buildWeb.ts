/**
 * npm run build:web -- --api https://<name>.ngrok-free.app [--site https://<project>.vercel.app]
 *   web-dist/ for a folder upload (npx vercel deploy --prod inside web-dist).
 * npm run build:web -- --from-env
 *   web-dist/ on Vercel's own build from GitHub (address from BLUCKFLIES_API_URL).
 * npm run build:web -- --write-vercel-json
 *   regenerates the repository's vercel.json (after changing src/http/staticSite.ts).
 *
 * See src/http/staticSite.ts and docs/TUNNEL-TEST.md.
 */
import { relative } from 'node:path';
import { buildWeb, ROOT_VERCEL_JSON, writeGitVercelConfig } from '../http/staticSite.js';

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--write-vercel-json')) {
    await writeGitVercelConfig();
    console.log(`Wrote ${relative(process.cwd(), ROOT_VERCEL_JSON)}. Commit it with the change.`);
    return;
  }
  const { outDir, fingerprint, api, mode } = await buildWeb(argv);
  console.log(`Built ${relative(process.cwd(), outDir) || outDir} (version ${fingerprint}). Server paths go to ${api}.`);
  if (mode === 'upload') console.log('Next: cd web-dist, then: npx vercel deploy --prod   (docs/TUNNEL-TEST.md)');
  else if (!process.env['ORIGIN_SECRET']) console.warn('Warning: ORIGIN_SECRET is not set for this build; set it in the Vercel project, or the server will refuse every request.');
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
