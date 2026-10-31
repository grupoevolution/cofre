// Imita a saída do yt-dlp para o teste local.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.10.01-fake'); process.exit(0); }
const url = args[args.length - 1];
const out = args[args.indexOf('-o') + 1];
if (!/ytpage/.test(url)) { console.error(`ERROR: Unsupported URL: ${url}`); process.exit(1); }
const dir = path.dirname(out);
for (const p of [10, 55, 100]) console.log(`[download]  ${p}.0% of 1.00MiB`);
const dest = path.join(dir, 'abc123.mp4');
fs.copyFileSync(path.join(process.env.TEST_MEDIA, 'v2.mp4'), dest);
console.log(`COFRE\t${dest}\tMeu video\tfulano\t`);
