import fs from 'node:fs';
import path from 'node:path';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const env = process.env;

export const DATA_DIR = path.resolve(env.DATA_DIR || './data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
for (const d of [MEDIA_DIR, THUMB_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

export const PORT = num(env.PORT, 3000);
export const PIN = env.APP_PIN || '';
export const IS_PROD = env.NODE_ENV === 'production';

// ---- Travas para não sobrecarregar a VPS ----
export const LIMITS = {
  imports: num(env.IMPORT_CONCURRENCY, 1),         // páginas de álbum lidas ao mesmo tempo
  downloads: num(env.DOWNLOAD_CONCURRENCY, 3),     // arquivos baixando ao mesmo tempo (no total)
  uploads: num(env.UPLOAD_CONCURRENCY, 2),         // envios ao Bunny ao mesmo tempo
  ffmpeg: num(env.FFMPEG_CONCURRENCY, 1),          // edições/miniaturas ao mesmo tempo
  ffmpegThreads: num(env.FFMPEG_THREADS, 2),       // núcleos que cada ffmpeg pode usar
  minFreeBytes: num(env.MIN_FREE_GB, 2) * 1e9,     // abaixo disso, downloads e edições pausam
  idleTimeoutMs: num(env.STALL_TIMEOUT_SEC, 60) * 1000, // conexão parada por mais que isso = falha
};

export const BUNNY = {
  storage: {
    zone: env.BUNNY_STORAGE_ZONE || '',
    key: env.BUNNY_STORAGE_KEY || '',
    host: env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com',
    cdn: (env.BUNNY_STORAGE_CDN || '').replace(/\/+$/, ''),
  },
  stream: {
    library: env.BUNNY_STREAM_LIBRARY_ID || '',
    key: env.BUNNY_STREAM_KEY || '',
    api: (env.BUNNY_STREAM_API || 'https://video.bunnycdn.com').replace(/\/+$/, ''),
    cdn: (env.BUNNY_STREAM_CDN || '').replace(/\/+$/, ''),
  },
};
BUNNY.storage.enabled = Boolean(BUNNY.storage.zone && BUNNY.storage.key);
BUNNY.stream.enabled = Boolean(BUNNY.stream.library && BUNNY.stream.key);
// Aceita "br.storage.bunnycdn.com" ou uma URL completa (útil em testes)
BUNNY.storage.base = /^https?:\/\//.test(BUNNY.storage.host)
  ? BUNNY.storage.host.replace(/\/+$/, '')
  : `https://${BUNNY.storage.host}`;

export function diskFree() {
  try {
    const s = fs.statfsSync(DATA_DIR);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return { free: Infinity, total: 0 }; }
}
