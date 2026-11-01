import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LIMITS } from './config.js';

const HEADERS_TIMEOUT = 30_000;

function linkSignal(outer, ctrl) {
  if (!outer) return;
  if (outer.aborted) ctrl.abort(outer.reason);
  else outer.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true });
}

/**
 * Baixa uma URL para um arquivo, com:
 * - limite de tempo para o servidor responder;
 * - detecção de conexão parada (sem receber dados por STALL_TIMEOUT_SEC);
 * - SHA256 calculado durante o download.
 */
export async function downloadToFile(url, dest, { headers = {}, signal, onProgress, idleMs = LIMITS.idleTimeoutMs } = {}) {
  const ctrl = new AbortController();
  linkSignal(signal, ctrl);
  const tmp = dest + '.part';
  let timer = setTimeout(() => ctrl.abort(new Error('o servidor demorou demais para responder')), HEADERS_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    let got = 0;
    const resetIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new Error('download parado (sem receber dados)')), idleMs);
    };
    resetIdle();
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        got += chunk.length; hash.update(chunk); resetIdle();
        onProgress?.(got, total);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
    if (total && got !== total) throw new Error(`download incompleto (${got} de ${total} bytes)`);
    fs.renameSync(tmp, dest);
    return { size: got, sha256: hash.digest('hex') };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function hashFile(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Envia um arquivo com Content-Length (o Bunny precisa), com progresso e timeout de conexão parada. */
export function uploadFile(url, { method = 'PUT', headers = {}, file, onProgress, signal, idleMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method, headers: { ...headers, 'Content-Length': size } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: body }));
      res.on('error', reject);
    });
    req.setTimeout(idleMs, () => req.destroy(new Error('envio parado (sem resposta do Bunny)')));
    req.on('error', reject);
    const onAbort = () => req.destroy(new Error('cancelado'));
    signal?.addEventListener('abort', onAbort, { once: true });
    let sent = 0;
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => { sent += c.length; onProgress?.(sent, size); });
    rs.on('error', (e) => req.destroy(e));
    rs.pipe(req);
  });
}

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
  return { status: res.status, ok: res.ok, data, text };
}
