import fs from 'node:fs';
import { cookiesFor } from './cookies.js';
import { PROXY_URL } from './net.js';
import { DESKTOP_UA } from './engines.js';

// Último recurso: abre a página num Chrome sem tela, dá play e anota os vídeos que o próprio site carrega.
// Pega players que só aparecem depois que a página roda (o que yt-dlp/gallery-dl não conhecem).

let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* sem a lib: recurso desligado */ }

const BIN = process.env.BROWSER_BIN
  || ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));

export const browserEnabled = () => process.env.BROWSER_FALLBACK !== '0' && !!puppeteer && !!BIN;

const VIDEO_URL = /\.(mp4|m4v|webm|mov)(\?|$)/i;
const HLS_URL = /\.m3u8(\?|$)/i;
const PLAY_SELECTORS = [
  '.vjs-big-play-button', '.jw-icon-display', '.plyr__control--overlaid', '.fp-play', '.mejs__overlay-play',
  'button[aria-label*="play" i]', 'button[title*="play" i]', '[class*="play-button" i]', '[class*="playButton" i]', '.play', '#play',
];

// Um navegador por vez (cada um gasta ~200-400 MB de memória).
let chain = Promise.resolve();
export function grabMedia(url, opts = {}) {
  const job = chain.then(() => grab(url, opts));
  chain = job.catch(() => {});
  return job;
}

async function grab(url, { proxy = false, timeoutMs = Number(process.env.BROWSER_TIMEOUT_SEC || 60) * 1000 } = {}) {
  if (!browserEnabled()) throw new Error('navegador invisível desligado');
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-gpu'];
  let auth = null;
  if (proxy && PROXY_URL) {
    const p = new URL(PROXY_URL);
    args.push(`--proxy-server=${p.protocol}//${p.host}`);
    if (p.username) auth = { username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) };
  }
  const browser = await puppeteer.launch({ executablePath: BIN, headless: true, args });
  const hardStop = setTimeout(() => browser.close().catch(() => {}), timeoutMs + 15e3);
  const found = new Map(); // url -> { url, type, size }
  let status = 0;
  try {
    const page = await browser.newPage();
    if (auth) await page.authenticate(auth);
    await page.setUserAgent(DESKTOP_UA);
    await page.setViewport({ width: 1280, height: 800 });
    const cookies = cookiesFor(url).map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly,
      ...(c.expires ? { expires: c.expires } : {}),
    }));
    if (cookies.length) await browser.setCookie(...cookies).catch(() => page.setCookie(...cookies));

    page.on('response', (r) => {
      const u = r.url();
      if (!/^https?:/i.test(u)) return;
      const h = r.headers();
      const ct = h['content-type'] || '';
      const total = Number((h['content-range'] || '').split('/')[1]) || Number(h['content-length']) || 0;
      if (HLS_URL.test(u) || /mpegurl/i.test(ct)) found.set(u, { url: u, type: 'hls', size: 0 });
      else if (/^video\//i.test(ct) || VIDEO_URL.test(u)) {
        const prev = found.get(u);
        found.set(u, { url: u, type: 'video', size: Math.max(prev?.size || 0, total) });
      }
    });

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch((e) => { throw new Error(`a página não abriu: ${e.message}`); });
    status = resp?.status() || 0;
    if (status >= 400 && !found.size) throw Object.assign(new Error(`o site respondeu ${status}`), { status });

    const deadline = Date.now() + Math.min(25e3, timeoutMs);
    let tries = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      // dá play em todos os <video> de todas as janelas (inclusive player embutido em iframe)
      for (const frame of page.frames()) {
        const srcs = await frame.evaluate(() => {
          const out = [];
          document.querySelectorAll('video').forEach((v) => {
            v.muted = true;
            v.play?.().catch(() => {});
            for (const s of [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((x) => x.src)]) if (s && /^https?:/.test(s)) out.push(s);
          });
          return out;
        }).catch(() => []);
        for (const s of srcs) if (!found.has(s)) found.set(s, { url: s, type: HLS_URL.test(s) ? 'hls' : 'video', size: 0 });
      }
      // clica no botão de play mais provável (só nas primeiras voltas)
      if (tries++ < 3) {
        for (const frame of page.frames()) {
          for (const sel of PLAY_SELECTORS) {
            const el = await frame.$(sel).catch(() => null);
            if (el) { await el.click().catch(() => {}); break; }
          }
        }
      }
      if ([...found.values()].some((f) => f.type === 'hls' || f.size > 300e3 || f.size === 0) && tries > 2) break;
    }
    const title = (await page.title().catch(() => '')).trim().slice(0, 200);
    return { title, media: pick([...found.values()]), status };
  } finally {
    clearTimeout(hardStop);
    await browser.close().catch(() => {});
  }
}

// Fica com os vídeos que parecem "o conteúdo" (descarta anúncio/prévia pequena).
function pick(list) {
  const videos = list.filter((f) => f.type === 'video' && (f.size === 0 || f.size >= 300e3))
    .sort((a, b) => b.size - a.size);
  const unique = [];
  for (const v of videos) {
    const key = v.url.split('?')[0];
    if (!unique.some((u) => u.url.split('?')[0] === key)) unique.push(v);
  }
  if (unique.length) return unique.slice(0, 10);
  const hls = list.filter((f) => f.type === 'hls');
  // a lista "mestre" (com todas as qualidades) costuma ser a primeira carregada
  return hls.slice(0, 1);
}
