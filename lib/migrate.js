import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MEDIA_DIR, THUMB_DIR } from './config.js';
import { one, run, tx, now, createFolder, uniqueName, slugify } from './db.js';

/**
 * Converte a versão antiga (/data/albums/<id>/meta.json) para o banco novo.
 * Tudo vai para a pasta "Importados". Arquivos já baixados são movidos (não copiados);
 * os que faltavam voltam para a fila. A pasta antiga é renomeada, nunca apagada.
 */
export function migrateLegacy() {
  const old = path.join(DATA_DIR, 'albums');
  if (!fs.existsSync(old)) return;
  const albums = fs.readdirSync(old).map((id) => {
    try { return JSON.parse(fs.readFileSync(path.join(old, id, 'meta.json'), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  if (albums.length) {
    const folder = one("SELECT * FROM folders WHERE slug = 'importados'") || createFolder('Importados');
    let moved = 0, requeued = 0;
    for (const a of albums) {
      tx(() => {
        const imp = run(`INSERT INTO imports (folder_id, url, source_id, title, author, status, total, created_at, finished_at)
          VALUES (?, ?, ?, ?, ?, 'parsed', ?, ?, ?)`, folder.id, a.url, a.id, a.title || '', a.author || '',
          a.items.length, a.createdAt || now(), a.finishedAt || now());
        const importId = Number(imp.lastInsertRowid);
        const who = slugify(a.author) || 'erome';
        a.items.forEach((it, i) => {
          const ext = (it.file?.split('.').pop() || (it.type === 'image' ? 'jpg' : 'mp4')).toLowerCase();
          const name = uniqueName(folder.id, `${who}_${a.id}_${String(i + 1).padStart(3, '0')}`, ext);
          const src = path.join(old, a.id, it.file || '');
          const have = it.status === 'done' && it.file && fs.existsSync(src);
          const r = run(`INSERT INTO media (folder_id, import_id, position, type, source_url, source_kind, name, ext, size, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, folder.id, importId, i, it.type === 'image' ? 'image' : 'video',
            it.url || null, it.type === 'hls' ? 'hls' : 'http', name, ext, have ? it.size || fs.statSync(src).size : null,
            have ? 'ready' : 'queued', a.createdAt || now(), now());
          const id = Number(r.lastInsertRowid);
          if (have) {
            fs.renameSync(src, path.join(MEDIA_DIR, `${id}.${ext}`));
            const t = it.thumb && path.join(old, a.id, it.thumb);
            const hasThumb = t && fs.existsSync(t);
            if (hasThumb) fs.renameSync(t, path.join(THUMB_DIR, `${id}.jpg`));
            run('UPDATE media SET file = ?, thumb = ? WHERE id = ?', `${id}.${ext}`, hasThumb ? `${id}.jpg` : null, id);
            moved++;
          } else if (!it.url) {
            run("UPDATE media SET status = 'error', error = 'Sem link de origem (versão antiga).' WHERE id = ?", id);
          } else requeued++;
        });
      });
    }
    console.log(`[migração] ${albums.length} álbuns → pasta "Importados" (${moved} arquivos movidos, ${requeued} voltaram para a fila)`);
  }
  fs.renameSync(old, path.join(DATA_DIR, `albums.antigo-${Date.now()}`));
}
