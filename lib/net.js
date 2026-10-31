import { fetch as undiciFetch, ProxyAgent } from 'undici';

// Proxy opcional (ex.: residencial). PROXY_URL=http://usuario:senha@host:porta
// PROXY_MODE=fallback (padrão): tenta direto e só usa o proxy quando o site bloquear o servidor.
// PROXY_MODE=always: tudo passa pelo proxy.
export const PROXY_URL = process.env.PROXY_URL || '';
export const proxyMode = () => (!PROXY_URL ? 'off' : process.env.PROXY_MODE === 'always' ? 'always' : 'fallback');

let agent;
export function netFetch(url, opts = {}, { proxy = false } = {}) {
  if (proxy && PROXY_URL) {
    agent ||= new ProxyAgent(PROXY_URL);
    return undiciFetch(url, { ...opts, dispatcher: agent });
  }
  return fetch(url, opts);
}

/** Erro HTTP que costuma significar "o site bloqueou o servidor" (vale tentar pelo proxy). */
export const isBlockStatus = (s) => s === 403 || s === 429 || s === 503;

/**
 * Roda `fn(usarProxy)`. Se o modo for "always", já vai pelo proxy.
 * Se for "fallback" e der bloqueio, tenta de novo pelo proxy.
 */
export async function withProxyFallback(fn, looksBlocked) {
  const mode = proxyMode();
  if (mode === 'always') return fn(true);
  try {
    return await fn(false);
  } catch (e) {
    if (mode === 'fallback' && looksBlocked(e)) {
      try { return await fn(true); } catch (e2) { e2.viaProxy = true; throw e2; }
    }
    throw e;
  }
}
