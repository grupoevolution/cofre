import * as cheerio from 'cheerio';

// O erome libera o acesso para navegador de celular; o servidor se apresenta como um.
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

export const REFERER = 'https://www.erome.com/';

export function albumIdFromUrl(raw) {
  const m = String(raw || '').match(/erome\.com\/a\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// Extrai a primeira URL de um texto (útil quando o link vem pelo "Compartilhar" do celular).
export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

function headers(extra = {}) {
  const h = {
    'User-Agent': MOBILE_UA,
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    Referer: REFERER,
    ...extra,
  };
  if (process.env.EROME_COOKIE) h.Cookie = process.env.EROME_COOKIE;
  return h;
}

export async function fetchAlbumPage(url) {
  const res = await fetch(url, {
    headers: headers({ Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`O site respondeu ${res.status} ao abrir o álbum`);
  return res.text();
}

const cleanKey = (u) => u.split('?')[0];

/**
 * Lê o HTML de um álbum do erome e devolve título, autor e lista de mídias.
 * Cada post do álbum fica num <div class="media-group">: vídeos usam
 * <video><source src="...mp4">, imagens usam data-src (lazy load).
 */
export function parseAlbum(html, pageUrl) {
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('.page-content h1, h1').first().text().trim() ||
    '';
  const author = $('#user_name, a#user_name, .username').first().text().trim() || '';

  const items = [];
  const seen = new Set();
  const add = (src, type) => {
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    let url;
    try { url = new URL(src.trim(), pageUrl).href; } catch { return; }
    const key = cleanKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    if (type === 'video' && /\.m3u8(\?|$)/i.test(url)) type = 'hls';
    items.push({ url, type });
  };

  const videoSrcs = ($scope) => {
    const out = [];
    $scope.find('video source[src], video[src]').each((_, el) => out.push($(el).attr('src')));
    $scope.find('video[data-src]').each((_, el) => out.push($(el).attr('data-src')));
    return out.filter(Boolean);
  };
  const imageSrcs = ($scope) => {
    const out = [];
    $scope.find('.img[data-src], img[data-src]').each((_, el) => out.push($(el).attr('data-src')));
    if (!out.length) $scope.find('img.img-front[src], img.img-back[src]').each((_, el) => out.push($(el).attr('src')));
    return out;
  };

  const groups = $('.media-group');
  if (groups.length) {
    groups.each((_, g) => {
      const $g = $(g);
      const vids = videoSrcs($g);
      if (vids.length) vids.forEach((v) => add(v, 'video')); // capa do vídeo é ignorada
      else imageSrcs($g).forEach((i) => add(i, 'image'));
    });
  } else {
    // Plano B se o site mudar o layout: pega qualquer vídeo da página e as imagens lazy.
    const $b = $('body');
    videoSrcs($b).forEach((v) => add(v, 'video'));
    $b.find('[data-src]').each((_, el) => {
      const s = $(el).attr('data-src');
      if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(s || '')) add(s, 'image');
    });
    const ogv = $('meta[property="og:video"]').attr('content');
    if (ogv) add(ogv, 'video');
  }

  return { title, author, items };
}

export function mediaHeaders() {
  return headers({ Accept: '*/*' });
}
