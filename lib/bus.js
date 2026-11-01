import { EventEmitter } from 'node:events';

// Avisa o app (via SSE) que algo mudou, sem inundar: agrupa mudanças a cada 300ms.
export const bus = new EventEmitter();
bus.setMaxListeners(100);

const changed = new Set();
let timer = null;
export function changedFolder(folderId) {
  changed.add(folderId ?? 0);
  if (!timer) timer = setTimeout(() => {
    timer = null;
    const ids = [...changed]; changed.clear();
    bus.emit('msg', { t: 'c', f: ids });
  }, 300);
}

// Progresso de download/envio (em memória, não vai para o banco)
export const progress = new Map(); // mediaId -> { k: 'dl'|'up'|'ed', got, total }
const lastSent = new Map();
export function setProgress(id, k, got, total) {
  progress.set(id, { k, got, total });
  const t = Date.now();
  if (t - (lastSent.get(id) || 0) < 700) return;
  lastSent.set(id, t);
  bus.emit('msg', { t: 'p', id, k, p: total ? Math.min(99, Math.floor((got / total) * 100)) : null, got });
}
export function clearProgress(id) { progress.delete(id); lastSent.delete(id); }
