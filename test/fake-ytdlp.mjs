// Imita a saída do yt-dlp para o teste local.
//  .../ytpage   → baixa normal
//  .../ytblock  → "not a bot" sem proxy; baixa com --proxy
//  .../ytlogin  → pede login; baixa se --cookies tiver a conta
//  .../ytdrm    → vídeo com DRM
//  outros       → Unsupported URL
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.10.01-fake'); process.exit(0); }
const url = args[args.length - 1];
const out = args[args.indexOf('-o') + 1];
const dir = path.dirname(out);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

const ok = (id, title) => {
  for (const p of [10, 55, 100]) console.log(`[download]  ${p}.0% of 1.00MiB`);
  const dest = path.join(dir, `${id}.mp4`);
  fs.copyFileSync(path.join(process.env.TEST_MEDIA, 'v2.mp4'), dest);
  console.log(`COFRE\t${dest}\t${title}\tfulano\t`);
  process.exit(0);
};

if (/ytpage/.test(url)) ok('abc123', 'Meu video');
if (/ytblock/.test(url)) {
  if (!opt('--proxy')) fail('[youtube] xyz: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.');
  ok('blk1', 'Video bloqueado');
}
if (/ytlogin/.test(url)) {
  const c = opt('--cookies');
  if (!c || !fs.readFileSync(c, 'utf8').includes('sessao')) fail('[instagram] abc: Requested content is not available, rate-limit reached or login required. Use --cookies for the authentication.');
  ok('log1', 'Video com login');
}
if (/ytdrm/.test(url)) fail('[generic] This video is DRM protected');
fail(`Unsupported URL: ${url}`);
