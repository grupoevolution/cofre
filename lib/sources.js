// Reconhece os links aceitos num texto (pode vir vários misturados).
//  - erome:   álbum inteiro (fotos e vídeos)
//  - xvideos: um vídeo
//  - tiktok:  um vídeo (sem marca d'água)
const URL_RE = /https?:\/\/[^\s"'<>]+|(?:www\.|m\.|vm\.|vt\.)?(?:erome|xvideos\d*|tiktok)\.[a-z.]+\/[^\s"'<>]+/gi;

export const SITE_LABEL = { erome: 'erome', xvideos: 'xvideos', tiktok: 'TikTok' };

export function classify(raw) {
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let m;
  if ((m = url.match(/erome\.com\/a\/([A-Za-z0-9_-]+)/i))) {
    return { kind: 'erome', id: m[1], url: `https://www.erome.com/a/${m[1]}` };
  }
  if ((m = url.match(/xvideos\d*\.[a-z.]+\/(video[.\w-]+|prof-video-click\/[^/\s]+\/[^/\s]+\/([\w.]+))/i))) {
    return { kind: 'xvideos', id: 'xv-' + (m[2] || m[1]).replace(/^video\.?/, ''), url: url.replace(/[#?].*$/, '') };
  }
  if ((m = url.match(/tiktok\.com\/(?:@[\w.-]+\/(?:video|photo)\/(\d+)|v\/(\d+)|t\/([A-Za-z0-9]+))/i))
    || (m = url.match(/(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/i))) {
    const id = m[1] || m[2] || m[3];
    return { kind: 'tiktok', id: 'tt-' + id, url: url.replace(/[#?].*$/, '') };
  }
  return null;
}

export function linksFromText(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text || '').match(URL_RE) || []) {
    const c = classify(raw.replace(/[),.;]+$/, ''));
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}
