import { proxyMode } from './net.js';

// Traduz o erro técnico (yt-dlp, gallery-dl, HTTP, navegador) em: o que houve + o que fazer.
// A ordem importa: o primeiro que bater é o diagnóstico.
const RULES = [
  { code: 'drm', re: /DRM|Widevine|PlayReady|encrypted media/i,
    msg: () => 'Vídeo com proteção anticópia (DRM).', hint: () => 'Esse tipo de vídeo (Netflix, Prime, Globoplay…) não dá para baixar.' },
  // "login required" vem antes do bloqueio: o Instagram diz "rate-limit reached or login required"
  { code: 'login', re: /login required|log ?in to (view|see|access|continue)|sign ?in to (view|see|access|continue)|need to (log|sign) ?in|members only/i,
    msg: () => 'O site pediu login.', hint: (site) => `Suba os cookies da sua conta de ${site} em Contas e toque em "Tentar de novo".` },
  { code: 'blocked', re: /not a bot|HTTP Error 429|\b429\b|Too Many Requests|rate.?limit|captcha|cloudflare|\bblocked\b|HTTP Error 403|\b403\b|Forbidden|bloqueou/i,
    msg: () => 'O site bloqueou o servidor.',
    hint: (site, viaProxy) => viaProxy || proxyMode() !== 'off'
      ? `Bloqueou até pelo proxy. Suba os cookies da sua conta de ${site} em Contas e tente de novo.`
      : `Suba os cookies da sua conta de ${site} em Contas, ou configure um proxy (PROXY_URL no EasyPanel).` },
  { code: 'login', re: /log ?in|sign ?in|cookies|authenticat|account|members only|subscri(be|ption)|age.?restrict|confirm your age|private (account|profile)|pediu login|unauthorized|\b401\b/i,
    msg: () => 'O site pediu login.', hint: (site) => `Suba os cookies da sua conta de ${site} em Contas e toque em "Tentar de novo".` },
  { code: 'geo', re: /not available in your (country|region)|geo.?restrict|geo.?block/i,
    msg: () => 'Vídeo bloqueado para o país do servidor.', hint: () => 'Configure um proxy do país certo (PROXY_URL no EasyPanel).' },
  { code: 'live', re: /is live|live event|currently live|premieres in|will begin/i,
    msg: () => 'É uma transmissão ao vivo ou ainda não começou.', hint: () => 'Tente de novo depois que a live terminar.' },
  { code: 'gone', re: /\b404\b|not found|Video unavailable|has been removed|removed by|private video|deleted|does not exist|no longer available|não encontrado/i,
    msg: () => 'Vídeo removido, privado ou link errado.', hint: () => 'Abra o link no navegador para conferir se ainda existe.' },
  { code: 'timeout', re: /travou|tempo máximo|demorou|timed? ?out|ETIMEDOUT|ECONNRESET|sem resposta/i,
    msg: () => 'O site ficou sem responder.', hint: () => 'Toque em "Tentar de novo" daqui a pouco.' },
  { code: 'unsupported', re: /Unsupported URL|No suitable extractor|nenhum arquivo de mídia|nenhum vídeo|Nenhum vídeo/i,
    msg: () => 'Não achei vídeo nem foto nesse link.', hint: () => 'Cole o link direto do post ou do vídeo (não da página inicial).' },
  { code: 'engine', re: /não está instalado|ENOENT/i,
    msg: () => 'Motor de download ausente no servidor.', hint: () => 'Refaça o deploy pelo Dockerfile do Cofre.' },
];
const PRIORITY = [...new Set(RULES.map((r) => r.code))];

export function classify(text, site = 'esse site', viaProxy = false) {
  const t = String(text || '');
  for (const r of RULES) if (r.re.test(t)) return { code: r.code, msg: r.msg(site), hint: r.hint(site, viaProxy) };
  return { code: 'other', msg: 'Não consegui baixar.', hint: 'Toque em "Tentar de novo". Se repetir, me mande o detalhe abaixo.' };
}

/** Entre vários erros (um por motor), fica com o mais útil. */
export function pickError(errors, site) {
  const list = errors.map((e) => ({ ...classify(e.text, site, e.viaProxy), detail: e.text }));
  list.sort((a, b) => (PRIORITY.indexOf(a.code) + 99 * (a.code === 'other')) - (PRIORITY.indexOf(b.code) + 99 * (b.code === 'other')));
  return list[0] || null;
}
