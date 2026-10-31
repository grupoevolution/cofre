// Painel "Atividade": o que está acontecendo AGORA (em memória, atualiza várias vezes por segundo)
// + um diário curto por download (gravado no meta.json) para ver o histórico.

/** Mede velocidade (bytes/s) com média móvel e calcula o tempo restante. */
export class Meter {
  constructor() { this.bytes = 0; this.total = 0; this.speed = 0; this.lastT = Date.now(); this.lastB = 0; }
  add(n) { this.bytes += n; this.tick(); }
  set(bytes, total) { this.bytes = bytes; if (total) this.total = total; this.tick(); }
  tick() {
    const now = Date.now();
    const dt = (now - this.lastT) / 1000;
    if (dt >= 0.7) {
      const inst = (this.bytes - this.lastB) / dt;
      this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
      this.lastT = now; this.lastB = this.bytes;
    }
  }
  get eta() { return this.total && this.speed > 0 ? Math.max(0, Math.round((this.total - this.bytes) / this.speed)) : null; }
  get pct() { return this.total ? Math.min(100, Math.round((this.bytes / this.total) * 100)) : null; }
}

const live = new Map(); // id do download -> estado ao vivo

export function setLive(id, patch) {
  live.set(id, { ...(live.get(id) || { startedAt: new Date().toISOString() }), ...patch, updatedAt: Date.now() });
}
export const getLive = (id) => live.get(id) || null;
export const clearLive = (id) => live.delete(id);

// Envios pro Bunny em andamento
const uploads = new Map(); // chave do arquivo -> { meter, title, file }
export function setUpload(key, info) { uploads.set(key, info); }
export function endUpload(key) { uploads.delete(key); }
export const listUploads = () => [...uploads.entries()].map(([key, u]) => ({
  id: key, title: u.title, file: u.file, dir: u.dir,
  bytes: u.meter.bytes, total: u.meter.total, pct: u.meter.pct, speed: Math.round(u.meter.speed), eta: u.meter.eta,
}));

/** Diário do download (aparece no painel). Guarda as últimas 60 linhas. */
export function logEvent(album, msg) {
  album.log ||= [];
  album.log.push({ t: new Date().toISOString(), msg });
  if (album.log.length > 60) album.log.splice(0, album.log.length - 60);
}
