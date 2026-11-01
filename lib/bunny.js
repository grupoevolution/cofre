import path from 'node:path';
import { BUNNY } from './config.js';
import { uploadFile, requestJson } from './net.js';

const S = BUNNY.storage, V = BUNNY.stream;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4' };

function explain(service, status, text) {
  if (status === 401) return `${service}: chave de acesso${service === 'Storage' ? ', zona ou região' : ' ou biblioteca'} incorreta (401)`;
  if (status === 400 && /checksum/i.test(text)) return `${service}: o arquivo chegou diferente do original (checksum)`;
  return `${service} respondeu ${status}${text ? ': ' + String(text).slice(0, 150) : ''}`;
}

// ---------------- Storage (pastas com fotos e vídeos) ----------------
export const storageUrl = (remotePath) => (S.cdn ? `${S.cdn}/${enc(remotePath)}` : null);

/** Envia com Checksum SHA256: o Bunny recusa o arquivo se ele chegar diferente. */
export async function storageUpload({ file, remotePath, sha256, ext, onProgress, signal }) {
  const r = await uploadFile(`${S.base}/${encodeURIComponent(S.zone)}/${enc(remotePath)}`, {
    headers: { AccessKey: S.key, Checksum: sha256.toUpperCase(), 'Content-Type': MIME[ext] || 'application/octet-stream' },
    file, onProgress, signal,
  });
  if (r.status !== 201) throw new Error(explain('Storage', r.status, r.text));
}

/** Lista uma pasta do Storage: { nomeDoArquivo: { size, checksum } } */
export async function storageList(dir) {
  const r = await requestJson(`${S.base}/${encodeURIComponent(S.zone)}/${enc(dir)}/`, { headers: { AccessKey: S.key } });
  if (r.status === 404) return {};
  if (!r.ok || !Array.isArray(r.data)) throw new Error(explain('Storage', r.status, r.text));
  return Object.fromEntries(r.data.filter((o) => !o.IsDirectory)
    .map((o) => [o.ObjectName, { size: Number(o.Length), checksum: (o.Checksum || '').toLowerCase() }]));
}

/** Confere se o arquivo está no Bunny com o mesmo tamanho (e o mesmo checksum, quando o Bunny informa). */
export function storageCheck(listing, remotePath, size, sha256) {
  const o = listing[path.posix.basename(remotePath)];
  if (!o) return 'não encontrado no Bunny';
  if (o.size !== size) return `tamanho diferente no Bunny (${o.size} ≠ ${size})`;
  if (o.checksum && sha256 && o.checksum !== sha256.toLowerCase()) return 'checksum diferente no Bunny';
  return null;
}

// ---------------- Stream (pastas só de vídeo) ----------------
const lib = () => `${V.api}/library/${encodeURIComponent(V.library)}`;
const vh = () => ({ AccessKey: V.key });

export const streamUrl = (guid) => `https://iframe.mediadelivery.net/play/${V.library}/${guid}`;
export const streamHls = (guid) => (V.cdn ? `${V.cdn}/${guid}/playlist.m3u8` : null);

export async function streamCreateCollection(name) {
  const r = await requestJson(`${lib()}/collections`, { method: 'POST', headers: vh(), body: { name } });
  if (!r.ok || !r.data?.guid) throw new Error(explain('Stream', r.status, r.text));
  return r.data.guid;
}

export async function streamCreateVideo(title, collectionId) {
  const r = await requestJson(`${lib()}/videos`, { method: 'POST', headers: vh(),
    body: collectionId ? { title, collectionId } : { title } });
  if (!r.ok || !r.data?.guid) {
    const err = new Error(explain('Stream', r.status, r.text));
    err.collection = r.status === 400 || r.status === 404; // coleção pode ter sido apagada no painel
    throw err;
  }
  return r.data.guid;
}

export async function streamUpload({ guid, file, onProgress, signal }) {
  const r = await uploadFile(`${lib()}/videos/${encodeURIComponent(guid)}`, {
    headers: { ...vh(), 'Content-Type': 'application/octet-stream' }, file, onProgress, signal,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(explain('Stream', r.status, r.text));
}

// Status do Bunny Stream: 0 criado, 1 enviado, 2 processando, 3 convertendo, 4 pronto, 5 erro, 6 falha no envio
export async function streamGet(guid) {
  const r = await requestJson(`${lib()}/videos/${encodeURIComponent(guid)}`, { headers: vh() });
  if (r.status === 404) return { missing: true };
  if (!r.ok || !r.data) throw new Error(explain('Stream', r.status, r.text));
  return { status: Number(r.data.status), storageSize: Number(r.data.storageSize) || 0, progress: r.data.encodeProgress };
}
