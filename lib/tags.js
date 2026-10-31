import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, albumDir, findItem, writeAlbum, allItems, setTagsResolver } from './store.js';
import { grabFrames } from './media.js';
import { tagsAllowed, onRelease } from './health.js';

// Legendas automáticas: um modelo de visão (CLIP) roda DENTRO do servidor, sem custo por arquivo.
// Ele compara cada foto (ou 3 quadros do vídeo) com frases em inglês e fica com a mais parecida
// de cada grupo, se a certeza passar do mínimo. Você corrige com um toque no app.
// Desliga com AUTO_TAGS=0 (gasta ~0,6–1 GB de RAM enquanto analisa).

export const TAG_GROUPS = [
  { group: 'cabelo', min: 0.45, needsPerson: true, labels: {
    loira: 'a photo of a woman with blonde hair',
    morena: 'a photo of a woman with brown hair',
    ruiva: 'a photo of a woman with red hair',
    'cabelo preto': 'a photo of a woman with black hair' } },
  { group: 'corpo', min: 0.5, needsPerson: true, labels: {
    magra: 'a photo of a slim skinny woman',
    curvilínea: 'a photo of a curvy woman with wide hips',
    gordinha: 'a photo of a plus-size chubby woman' } },
  { group: 'pessoas', min: 0.55, needsAnyPerson: true, labels: {
    solo: 'a photo of one person alone',
    casal: 'a photo of two people together',
    grupo: 'a photo of a group of people' } },
  { group: 'ambiente', min: 0.5, labels: {
    quarto: 'a photo taken in a bedroom',
    banheiro: 'a photo taken in a bathroom or shower',
    carro: 'a photo taken inside a car',
    'ao ar livre': 'a photo taken outdoors in nature',
    academia: 'a photo taken in a gym',
    cozinha: 'a photo taken in a kitchen',
    sala: 'a photo taken in a living room on a sofa' } },
  { group: 'estilo', min: 0.6, needsAnyPerson: true, labels: {
    selfie: 'a selfie taken with a phone held at arm length',
    espelho: 'a mirror selfie',
    profissional: 'a professional studio photo shoot' } },
  { group: 'detalhe', min: 0.62, needsPerson: true, labels: {
    tatuada: 'a photo of a woman with visible tattoos',
    _sem: 'a photo of a woman without tattoos' } },
];
const PERSON = { pessoa: 'a photo of a woman', homem: 'a photo of a man', _nada: 'a photo with no people' };

export const tagsEnabled = () => process.env.AUTO_TAGS !== '0';
export const tagState = { status: tagsEnabled() ? 'aguardando' : 'desligado', error: null, done: 0, queue: 0 };

let classifierP = null;
async function classifier() {
  if (!classifierP) {
    classifierP = (async () => {
      tagState.status = 'carregando modelo';
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(DATA_DIR, 'models'); // fica no volume: baixa 1x só (~150 MB)
      const model = process.env.TAG_MODEL || 'Xenova/clip-vit-base-patch32';
      const c = await pipeline('zero-shot-image-classification', model, { dtype: process.env.TAG_DTYPE || 'q8' });
      tagState.status = 'pronto';
      return c;
    })().catch((e) => { classifierP = null; tagState.status = 'erro'; tagState.error = String(e.message || e).slice(0, 300); throw e; });
  }
  return classifierP;
}

// Média das probabilidades de um grupo em vários quadros
async function scoreGroup(clf, images, labels) {
  const keys = Object.keys(labels);
  const sums = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const img of images) {
    const out = await clf(img, keys.map((k) => labels[k]));
    for (const r of out) sums[keys[keys.map((k) => labels[k]).indexOf(r.label)]] += r.score;
  }
  return keys.map((k) => ({ tag: k, score: sums[k] / images.length })).sort((a, b) => b.score - a.score);
}

/** Analisa uma imagem (ou quadros do vídeo) e devolve as legendas. */
export async function tagImages(images) {
  const clf = await classifier();
  const person = await scoreGroup(clf, images, PERSON);
  const hasWoman = person.find((p) => p.tag === 'pessoa').score >= 0.45;
  const hasPerson = person.find((p) => p.tag === '_nada').score < 0.4;
  const out = [];
  for (const g of TAG_GROUPS) {
    if (g.needsPerson && !hasWoman) continue;
    if (g.needsAnyPerson && !hasPerson) continue;
    const [best] = await scoreGroup(clf, images, g.labels);
    if (best && !best.tag.startsWith('_') && best.score >= g.min) out.push({ tag: best.tag, group: g.group, score: Math.round(best.score * 100) / 100 });
  }
  return out;
}

// ---------- Fila (um arquivo por vez, em segundo plano) ----------
const queue = [];
let running = false;

export function queueTagging(key) {
  if (!tagsEnabled() || queue.includes(key)) return;
  queue.push(key);
  tagState.queue = queue.length;
  pump();
}

// O modelo ocupa ~0,5–1 GB: sai da memória depois de alguns minutos sem uso (ou na hora, se o vigia pedir)
const IDLE_UNLOAD_MS = Number(process.env.TAG_IDLE_MIN || 5) * 60e3;
let idleT = null;
async function unloadModel() {
  clearTimeout(idleT);
  if (!classifierP || running || inUse) return;
  const p = classifierP;
  classifierP = null;
  try { const c = await p; await c.dispose?.(); } catch { /* já tinha falhado */ }
  if (tagState.status === 'pronto') tagState.status = 'aguardando';
}
onRelease(() => pump()); // vigia liberou: volta a legendar

async function pump() {
  if (running) return;
  running = true;
  clearTimeout(idleT);
  while (queue.length) {
    if (!tagsAllowed()) { tagState.status = 'pausado pelo vigia da VPS'; break; } // a fila espera
    const key = queue.shift();
    tagState.queue = queue.length;
    try { await tagOne(key); } catch (e) {
      if (tagState.status === 'erro') { queue.length = 0; break; } // modelo não carregou: para
      const f = findItem(key);
      if (f) { f.item.autoTags = []; f.item.tagError = String(e.message || e).slice(0, 200); writeAlbum(f.album); }
    }
  }
  tagState.queue = queue.length;
  running = false;
  if (!tagsAllowed()) unloadModel(); // memória apertada: devolve já
  else idleT = setTimeout(unloadModel, IDLE_UNLOAD_MS);
}

// "Direto pro Bunny" legenda antes de enviar; se o vigia pausou as legendas, vai pra fila e legenda depois (pela miniatura)
export const tagNow = (key) => (tagsAllowed() ? tagOne(key) : (queueTagging(key), Promise.resolve()));

let inUse = 0; // análises acontecendo agora (fila + "direto pro Bunny") — o modelo não pode sair no meio
async function tagOne(key) {
  inUse++;
  clearTimeout(idleT);
  try { return await tagOneInner(key); } finally {
    inUse--;
    if (!inUse && !running) idleT = setTimeout(unloadModel, tagsAllowed() ? IDLE_UNLOAD_MS : 0);
  }
}
async function tagOneInner(key) {
  const f = findItem(key);
  if (!f || f.item.status !== 'done') return;
  const { album, item } = f;
  const dir = albumDir(album.id);
  const file = path.join(dir, item.file);
  let images = [];
  let tmp = null;
  if (item.type === 'image' && item.local !== false && fs.existsSync(file)) images = [file];
  else if (item.type === 'video' && item.local !== false && fs.existsSync(file)) {
    tmp = path.join(dir, `.tags-${item.file}`);
    images = await grabFrames(file, item.duration, 3, tmp, 336);
  } else if (item.thumb && fs.existsSync(path.join(dir, item.thumb))) images = [path.join(dir, item.thumb)];
  try {
    if (!images.length) { item.autoTags = []; writeAlbum(album); return; }
    item.autoTags = await tagImages(images);
    item.tagError = null;
    tagState.done++;
    writeAlbum(album);
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Ao ligar o servidor: analisa o que ainda não tem legenda (aos poucos). */
export function backfillTags() {
  if (!tagsEnabled()) return;
  for (const { album, item } of allItems()) {
    if (item.status === 'done' && !item.autoTags && (item.type === 'image' || item.type === 'video')) queueTagging(`${album.id}/${item.file}`);
  }
}

/** Legendas que valem: as que você editou à mão, ou automáticas + manuais. */
export function effectiveTags(item) {
  if (item.tagsEdited) return item.tags || [];
  return [...new Set([...(item.autoTags || []).map((t) => t.tag), ...(item.tags || [])])];
}
setTagsResolver(effectiveTags);
