/* Cofre — app (sem framework) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (b) => !b ? '0 MB' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtDur = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET', credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/api/login') { showScreen('login'); throw new Error('login'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro ' + res.status);
  return data;
}

// ---------- Avisos e janelas ----------
let toastT;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
const fail = (e) => { if (e?.message !== 'login') toast('⚠ ' + (e?.message || e), 5000); };

function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBox').innerHTML = ''; }
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };

/** Menu de opções: [{label, value, danger}] → valor escolhido (ou null) */
function menu(title, options) {
  return new Promise((resolve) => {
    $('#sheetBox').innerHTML = (title ? `<p class="sheet-title">${esc(title)}</p>` : '') +
      options.map((o, i) => `<button class="sheet-opt ${o.danger ? 'danger' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('') +
      '<button class="sheet-opt muted" data-i="-1">Cancelar</button>';
    $('#sheet').classList.remove('hidden');
    $('#sheetBox').onclick = (e) => {
      const b = e.target.closest('[data-i]'); if (!b) return;
      closeSheet(); resolve(+b.dataset.i < 0 ? null : options[+b.dataset.i].value);
    };
  });
}
function ask(title, { value = '', placeholder = '', ok = 'OK' } = {}) {
  return new Promise((resolve) => {
    $('#sheetBox').innerHTML = `<p class="sheet-title">${esc(title)}</p>
      <form class="sheet-form"><input id="askIn" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
      <div class="row2"><button type="button" class="btn ghost" id="askNo">Cancelar</button><button class="btn primary">${esc(ok)}</button></div></form>`;
    $('#sheet').classList.remove('hidden');
    const inp = $('#askIn'); setTimeout(() => inp.focus(), 50);
    $('#askNo').onclick = () => { closeSheet(); resolve(null); };
    $('.sheet-form').onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); closeSheet(); resolve(v || null); };
  });
}
function confirmBox(title, text, okLabel = 'Confirmar', danger = false) {
  return new Promise((resolve) => {
    $('#sheetBox').innerHTML = `<p class="sheet-title">${esc(title)}</p>${text ? `<p class="muted small sheet-text">${text}</p>` : ''}
      <div class="row2"><button class="btn ghost" id="cNo">Cancelar</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" id="cYes">${esc(okLabel)}</button></div>`;
    $('#sheet').classList.remove('hidden');
    $('#cNo').onclick = () => { closeSheet(); resolve(false); };
    $('#cYes').onclick = () => { closeSheet(); resolve(true); };
  });
}

// ---------- Telas ----------
function showScreen(id) {
  ['login', 'home', 'folder'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
  if (id !== 'folder') setSelectMode(false);
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { pin: $('#pin').value } });
    $('#pin').value = '';
    start();
  } catch (err) { $('#loginErr').textContent = err.message; }
};

// ---------- Estado ----------
const S = {
  view: 'home', folders: [], status: null, lastFolderId: 0,
  cur: null, tab: 'local', select: false, selected: new Set(), progress: new Map(),
};
try { S.lastFolderId = Number(localStorage.getItem('cofre.lastFolder') || 0); } catch { /* sem storage */ }
const remember = (id) => { S.lastFolderId = id; try { localStorage.setItem('cofre.lastFolder', id); } catch { /* ok */ } };

// ---------- Início ----------
async function loadHome() {
  const [folders, imports, status] = await Promise.all([api('/api/folders'), api('/api/imports'), api('/api/status')]);
  S.folders = folders; S.status = status;
  renderBanner();
  fillFolderSelect();
  renderFolders();
  renderActivity($('#activity'), imports, true);
  renderQuick();
  const d = status.disk;
  $('#diskInfo').textContent = d.total ? `Espaço livre na VPS: ${fmtBytes(d.free)} de ${fmtBytes(d.total)}` : '';
}

function renderQuick() {
  const q = S.status?.quick || {};
  const bunnyOn = S.status?.bunny.storage || S.status?.bunny.stream;
  $('#qSend').classList.toggle('hidden', !(q.sendable && bunnyOn));
  $('#qSend').textContent = `↑ Enviar tudo ao Bunny (${q.sendable} · ${fmtBytes(q.sendableBytes)})`;
  $('#qFree').classList.toggle('hidden', !q.freeable);
  $('#qFree').textContent = `🧹 Apagar do sistema o que já está no Bunny (${q.freeable} · ${fmtBytes(q.freeBytes)})`;
  $('#quick').classList.toggle('hidden', !(q.sendable && bunnyOn) && !q.freeable);
}

async function sendAll(folderId, count, where) {
  const ok = await confirmBox(`Enviar ${plural(count, 'mídia', 'mídias')} ao Bunny?`,
    `Vai tudo o que está pronto e ainda não foi enviado ${where}. Elas entram na fila e sobem aos poucos, respeitando o limite da VPS.<br><br>Fotos e vídeos de uma mesma pasta vão juntos para o <b>Storage</b>; pastas só com vídeos vão para o <b>Stream</b>.`,
    'Enviar tudo');
  if (!ok) return;
  try {
    const r = await api('/api/bulk/send-all', { method: 'POST', body: { folderId } });
    toast(r.queued ? `${plural(r.queued, 'mídia foi', 'mídias foram')} para a fila do Bunny` : 'Nada novo para enviar.');
    if (r.skipped?.length) await confirmBox(`${r.skipped.length} não ${r.skipped.length === 1 ? 'pôde' : 'puderam'} ir`, r.skipped.slice(0, 8).map(esc).join('<br>'), 'OK');
  } catch (e) { fail(e); }
  refresh();
}

async function freeAll(folderId, count, bytes, where, btn) {
  const ok = await confirmBox('Apagar do sistema o que já está no Bunny?',
    `${plural(count, 'mídia', 'mídias')} ${where} · ${fmtBytes(bytes)}.<br><br>Antes de apagar, confiro <b>cada arquivo no Bunny</b> (existe e está igual). Só o que for confirmado sai da VPS — o resto fica e aparece com erro. As pastas e o histórico continuam aqui.`,
    'Conferir e apagar', true);
  if (!ok) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Conferindo no Bunny…';
  try { showFreeResult(await api('/api/bulk/free-all', { method: 'POST', body: { folderId } })); } catch (e) { fail(e); }
  finally { btn.disabled = false; btn.textContent = label; }
  refresh();
}

async function showFreeResult(r) {
  if (r.freed) toast(`${fmtBytes(r.bytes)} liberados (${plural(r.freed, 'arquivo conferido', 'arquivos conferidos')} no Bunny)`, 4500);
  else if (!r.failed.length) toast('Nada para apagar.');
  if (r.failed.length) {
    await confirmBox(`${plural(r.failed.length, 'arquivo ficou', 'arquivos ficaram')} no sistema`,
      'Não deu para confirmar no Bunny, então não apaguei:<br>' + r.failed.slice(0, 8).map((f) => `${esc(f.name)} — ${esc(f.reason)}`).join('<br>'), 'OK');
  }
}

$('#qSend').onclick = () => sendAll(null, S.status.quick.sendable, 'em todas as pastas');
$('#qFree').onclick = (e) => freeAll(null, S.status.quick.freeable, S.status.quick.freeBytes, 'em todas as pastas', e.currentTarget);

function renderBanner() {
  const st = S.status, msgs = [];
  if (!st) return;
  if (st.paused === 'disk') msgs.push(`⚠ Pouco espaço na VPS (menos de ${fmtBytes(st.minFree)} livres). Downloads e edições estão pausados — libere espaço enviando ao Bunny.`);
  if (!st.bunny.storage && !st.bunny.stream) msgs.push('Bunny ainda não configurado: preencha as variáveis BUNNY_* no EasyPanel para poder enviar.');
  $('#banner').innerHTML = msgs.map(esc).join('<br>');
  $('#banner').classList.toggle('hidden', !msgs.length);
}

const pathLabel = (f) => (f.trail?.length ? f.trail.map((x) => x.name).join(' › ') : f.name);
/** Pastas em ordem de árvore: [{f, depth}] (principais na ordem de atividade, subpastas por nome) */
function folderTree(list = S.folders) {
  const kids = new Map();
  for (const f of list) { const k = f.parent_id || 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(f); }
  for (const [k, arr] of kids) if (k) arr.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const out = [];
  const walk = (pid, depth) => (kids.get(pid) || []).forEach((f) => { out.push({ f, depth }); walk(f.id, depth + 1); });
  walk(0, 0);
  return out;
}
const indentName = ({ f, depth }) => `${'\u00a0\u00a0\u00a0'.repeat(depth)}${depth ? '↳ ' : ''}${f.name}`;

function fillFolderSelect() {
  const sel = $('#addFolder');
  const keep = Number(sel.value) || S.lastFolderId;
  sel.innerHTML = (S.folders.length ? '' : '<option value="">— crie uma pasta —</option>') +
    folderTree().map((t) => `<option value="${t.f.id}">${esc(indentName(t))}</option>`).join('') +
    '<option value="new">+ Nova pasta…</option>';
  if (S.folders.some((f) => f.id === keep)) sel.value = keep;
}
$('#addFolder').onchange = async (e) => {
  if (e.target.value !== 'new') return remember(Number(e.target.value));
  const f = await newFolder();
  fillFolderSelect();
  if (f) $('#addFolder').value = f.id;
};

async function newFolder(parentId = null) {
  const parent = parentId && (S.folders.find((f) => f.id === parentId) || S.cur);
  const name = await ask(parent ? `Nova subpasta em "${parent.name}"` : 'Nome da nova pasta',
    { placeholder: parent ? 'Ex.: Fulana' : 'Ex.: Criativos de imagem', ok: 'Criar' });
  if (!name) return null;
  try {
    const f = await api('/api/folders', { method: 'POST', body: { name, parentId } });
    S.folders.unshift(f); remember(f.id); renderFolders(); fillFolderSelect();
    return f;
  } catch (e) { fail(e); return null; }
}
$('#newFolderBtn').onclick = async () => { const f = await newFolder(); if (f) location.hash = '#f/' + f.id; };

function folderLine(st, children) {
  const parts = [];
  if (children) parts.push(plural(children, 'subpasta', 'subpastas'));
  if (st.local) parts.push(`${st.local} no sistema`);
  if (st.sent) parts.push(`${st.sent} no Bunny`);
  return parts.join(' · ') || 'vazia';
}

function folderCard(f, showPath) {
  const st = f.deep || f.stats;
  const busy = (st.busy || 0) + (st.sending || 0);
  return `<a class="fcard" href="#f/${f.id}">
    <div class="fcover" ${f.cover ? `style="background-image:url('/thumb/${f.cover}')"` : ''}>${f.cover ? '' : '<span>📁</span>'}
      ${busy ? `<span class="badge live">${st.busy ? 'baixando' : 'enviando'} ${busy}</span>` : ''}
      ${st.errors ? `<span class="badge err">⚠ ${st.errors}</span>` : ''}</div>
    <div class="finfo"><div class="t">${f.children ? '📁 ' : ''}${esc(showPath ? pathLabel(f) : f.name)}</div>
      <div class="muted small">${esc(folderLine(st, f.children))}</div></div></a>`;
}

function renderFolders() {
  const q = $('#folderSearch').value.trim().toLowerCase();
  // sem busca: só as pastas principais; com busca: procura em todos os níveis
  const list = q ? S.folders.filter((f) => pathLabel(f).toLowerCase().includes(q)) : S.folders.filter((f) => !f.parent_id);
  $('#noFolders').classList.toggle('hidden', S.folders.length > 0);
  $('#folders').innerHTML = list.map((f) => folderCard(f, Boolean(q))).join('')
    || (q ? '<p class="muted center">Nenhuma pasta com esse nome.</p>' : '');
}
$('#folderSearch').oninput = renderFolders;

function renderActivity(el, imports, showFolder) {
  const items = imports.filter((i) => i.status !== 'parsed' || i.done + i.failed < i.total || i.failed);
  el.innerHTML = items.slice(0, 8).map((i) => {
    const label = i.status === 'queued' ? 'na fila' : i.status === 'parsing' ? 'lendo o álbum…'
      : i.status === 'error' ? esc(i.error) : `${i.done}/${i.total}${i.failed ? ` · ${i.failed} falharam` : ''}`;
    const err = i.status === 'error' || i.failed;
    return `<div class="act ${err ? 'is-err' : ''}" data-imp="${i.id}">
      <div class="act-t"><b>${esc(i.title || i.source_id)}</b>${showFolder ? ` <span class="muted">→ ${esc(i.folder_name)}</span>` : ''}
        <div class="small ${err ? 'err' : 'muted'}">${label}</div></div>
      ${err ? `<button class="btn small-btn" data-retry="${i.id}">Tentar de novo</button>` : ''}
      ${i.status === 'error' ? `<button class="btn ghost small-btn" data-dismiss="${i.id}">✕</button>` : ''}
    </div>`;
  }).join('');
}
async function activityClick(e) {
  const r = e.target.closest('[data-retry]'), d = e.target.closest('[data-dismiss]');
  try {
    if (r) { await api(`/api/imports/${r.dataset.retry}/retry`, { method: 'POST' }); toast('Tentando de novo…'); }
    if (d) await api(`/api/imports/${d.dataset.dismiss}`, { method: 'DELETE' });
    refresh();
  } catch (err) { fail(err); }
}
$('#activity').onclick = activityClick;
$('#importsF').onclick = activityClick;

// ---------- Adicionar links ----------
async function addLinks(text, folderId, msgEl) {
  text = (text || '').trim();
  if (!text) return false;
  if (!folderId) { msgEl.className = 'small err'; msgEl.textContent = 'Escolha ou crie uma pasta primeiro.'; return false; }
  msgEl.className = 'small muted'; msgEl.textContent = 'Enviando…';
  try {
    const r = await api('/api/imports', { method: 'POST', body: { text, folderId } });
    const parts = [];
    if (r.created) parts.push(`${plural(r.created, 'link entrou', 'links entraram')} na fila`);
    if (r.retried) parts.push(`${plural(r.retried, 'voltou', 'voltaram')} para a fila`);
    if (r.existed) parts.push(`${plural(r.existed, 'já estava', 'já estavam')} nesta pasta`);
    msgEl.className = 'small ok'; msgEl.textContent = parts.join(' · ') + '. Pode colar o próximo.';
    remember(folderId);
    refresh();
    return true;
  } catch (e) {
    if (e.message !== 'login') { msgEl.className = 'small err'; msgEl.textContent = e.message; }
    return false;
  }
}
$('#addForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#addBtn').disabled = true;
  if (await addLinks($('#urls').value, Number($('#addFolder').value) || 0, $('#addMsg'))) $('#urls').value = '';
  $('#addBtn').disabled = false;
};
$('#addForm2').onsubmit = async (e) => {
  e.preventDefault();
  $('#addBtn2').disabled = true;
  if (await addLinks($('#urls2').value, S.cur?.id, $('#addMsg2'))) $('#urls2').value = '';
  $('#addBtn2').disabled = false;
};
$('#pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    $('#urls').value = ($('#urls').value ? $('#urls').value + '\n' : '') + t;
  } catch { $('#urls').focus(); toast('Toque e segure no campo para colar.'); }
};

$('#homeMenu').onclick = async () => {
  const v = await menu('Cofre', [
    { label: 'Sair deste aparelho', value: 'out' },
    { label: 'Sair de todos os aparelhos', value: 'all', danger: true },
  ]);
  if (!v) return;
  await api(v === 'all' ? '/api/logout-all' : '/api/logout', { method: 'POST' }).catch(() => {});
  showScreen('login');
};

// ---------- Pasta ----------
async function openFolder(id) {
  if (S.cur?.id !== id) {
    S.cur = null; S.tab = 'local'; $('#grid').innerHTML = ''; $('#q').value = ''; $('#fType').value = ''; $('#fStatus').value = '';
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'local'));
    setSelectMode(false);
  }
  S.view = 'folder';
  showScreen('folder');
  remember(id);
  await loadFolder(id);
}

async function loadFolder(id = S.cur?.id) {
  if (!id) return;
  const data = await api('/api/folders/' + id);
  if (S.view !== 'folder' || location.hash !== '#f/' + id) return;
  S.cur = data;
  S.imports = new Map(data.imports.map((i) => [i.id, i]));
  S.progress = new Map(data.media.filter((m) => m.progress).map((m) => [m.id, m.progress]));
  renderFolderHead();
  renderGrid();
  renderActivity($('#importsF'), data.imports.filter((i) => i.status !== 'parsed' || i.failed), false);
}

function renderFolderHead() {
  const f = S.cur, st = f.stats;
  $('#fName').textContent = f.name;
  const dest = { auto: 'automático', storage: 'Storage', stream: 'Stream' }[f.dest];
  const crumbs = f.trail.slice(0, -1).map((x) => `<a href="#f/${x.id}">${esc(x.name)}</a> › `).join('');
  $('#fMeta').innerHTML = `${crumbs ? `<span class="crumb">${crumbs.replace(/ › $/, '')} ›</span>` : ''}${fmtBytes(st.bytes)} no sistema · destino: ${dest}`;
  $('#subfolders').innerHTML = f.subfolders.map((c) => folderCard(c)).join('') +
    `<button class="fcard add" id="addSubBtn" ${f.subfolders.length ? '' : 'style="grid-column:1/-1"'}>+ Subpasta</button>`;
  $('#cLocal').textContent = st.local || 0;
  $('#cBunny').textContent = st.sent || 0;
  // atalhos valem para a pasta + subpastas
  const q = f.quick, withSubs = f.subfolders.length ? ' · com subpastas' : '';
  const bunnyOn = !S.status || S.status.bunny.storage || S.status.bunny.stream;
  $('#freeBtn').textContent = `🧹 Apagar o que já está no Bunny (${q.freeable} · ${fmtBytes(q.freeBytes)}${withSubs})`;
  $('#freeBtn').classList.toggle('hidden', !q.freeable || S.tab !== 'local');
  $('#sendAllBtn').textContent = `↑ Enviar tudo ao Bunny (${q.sendable}${withSubs})`;
  $('#sendAllBtn').classList.toggle('hidden', !q.sendable || !bunnyOn || S.tab !== 'local');
  const work = [];
  if (st.busy) work.push(`${st.busy} baixando/editando`);
  if (st.sending) work.push(`${st.sending} indo pro Bunny`);
  $('#activityF').textContent = work.join(' · ');
  $('#selectBtn').classList.toggle('hidden', S.tab !== 'local');
  $('#fStatus').classList.toggle('hidden', S.tab !== 'local');
}

const BUSY = ['queued', 'downloading', 'edit_queued', 'editing', 'fix_queued', 'fixing'];
function visibleMedia() {
  if (!S.cur) return [];
  const q = $('#q').value.trim().toLowerCase(), type = $('#fType').value, st = $('#fStatus').value;
  return S.cur.media.filter((m) => {
    if (S.tab === 'local' ? !m.local : m.bunny_status !== 'sent') return false;
    if (type && m.type !== type) return false;
    if (q) {
      const imp = S.imports.get(m.import_id);
      const hay = `${m.name} ${imp?.title || ''} ${imp?.author || ''} ${imp?.source_id || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (S.tab === 'local' && st) {
      if (st === 'ready' && m.status !== 'ready') return false;
      if (st === 'notsent' && (m.status !== 'ready' || m.bunny_status === 'sent')) return false;
      if (st === 'sent' && m.bunny_status !== 'sent') return false;
      if (st === 'busy' && !BUSY.includes(m.status) && !['queued', 'uploading', 'verifying'].includes(m.bunny_status)) return false;
      if (st === 'error' && m.status !== 'error' && m.bunny_status !== 'error') return false;
      if (st === 'edited' && !m.edited) return false;
    }
    return true;
  });
}

function stateOf(m) {
  const p = S.progress.get(m.id);
  const pct = !p ? null : p.pct != null ? p.pct : p.total ? Math.min(99, Math.floor((p.got / p.total) * 100)) : null;
  if (m.status === 'queued') return { label: 'Na fila', cls: 'wait' };
  if (m.status === 'downloading' && p?.k === 'cv') return { label: 'Preparando vídeo…', cls: 'live' };
  if (m.status === 'fix_queued') return { label: 'Na fila p/ converter', cls: 'wait' };
  if (m.status === 'fixing') return { label: 'Convertendo…', cls: 'live' };
  if (m.status === 'downloading') return { label: `Baixando${pct != null ? ' ' + pct + '%' : '…'}`, cls: 'live', pct };
  if (m.status === 'edit_queued') return { label: 'Na fila de edição', cls: 'wait' };
  if (m.status === 'editing') return { label: 'Editando…', cls: 'live' };
  if (m.status === 'error') return { label: '⚠ Falhou', cls: 'err', title: m.error };
  if (m.bunny_status === 'queued') return { label: 'Na fila do Bunny', cls: 'wait' };
  if (m.bunny_status === 'uploading') return { label: `Enviando${pct != null ? ' ' + pct + '%' : '…'}`, cls: 'live', pct };
  if (m.bunny_status === 'verifying') return { label: m.bunny_target === 'stream' ? 'Bunny processando…' : 'Conferindo…', cls: 'live' };
  if (m.bunny_status === 'sent') return { label: '✓ No Bunny', cls: 'ok' };
  if (m.bunny_status === 'error') return { label: '⚠ Bunny', cls: 'err', title: m.bunny_error };
  return null;
}

function tileHtml(m) {
  const s = stateOf(m);
  const sel = S.selected.has(m.id);
  const thumb = m.thumb ? `style="background-image:url('/thumb/${m.id}?v=${m.size || 0}')"` : '';
  const ready = m.status === 'ready' && m.local;
  const sent = m.bunny_status === 'sent';
  const sending = ['queued', 'uploading', 'verifying'].includes(m.bunny_status);
  let btns;
  if (S.tab === 'bunny') {
    btns = `${m.bunny_url ? `<button data-act="copy">Copiar link</button><a data-act="open" href="${esc(m.bunny_url)}" target="_blank" rel="noopener noreferrer">Abrir</a>` : '<span class="muted small">sem link público</span>'}
      <button data-act="more" class="more">⋯</button>`;
  } else if (ready) {
    btns = `<button data-act="edit">✎ Editar</button>
      <button data-act="send" class="${sent ? 'is-ok' : 'is-pri'}" ${sent || sending ? 'disabled' : ''}>${sent ? '✓ Enviado' : sending ? '…' : '↑ Bunny'}</button>
      <button data-act="more" class="more">⋯</button>`;
  } else {
    btns = `${m.status === 'error' ? '<button data-act="retry">Tentar de novo</button>' : '<span></span>'}<span></span><button data-act="more" class="more">⋯</button>`;
  }
  const meta = S.tab === 'bunny'
    ? `${m.bunny_target === 'stream' ? 'Stream' : 'Storage'} · ${new Date(m.sent_at || m.created_at).toLocaleDateString('pt-BR')}${m.local ? ' · também no sistema' : ''}`
    : [m.type === 'video' && m.duration ? fmtDur(m.duration) : '', m.width ? `${m.width}×${m.height}` : '', m.size ? fmtBytes(m.size) : ''].filter(Boolean).join(' · ');
  return `<div class="tile ${sel ? 'sel' : ''} ${ready ? 'can-open' : ''}" data-id="${m.id}">
    <div class="tthumb" ${thumb}>
      ${m.thumb ? '' : `<span class="ph">${m.type === 'video' ? '🎬' : '🖼'}</span>`}
      ${m.type === 'video' ? `<span class="tkind">▶${m.duration ? ' ' + fmtDur(m.duration) : ''}</span>` : ''}
      ${m.edited ? '<span class="tkind ed">editado</span>' : ''}
      ${s && S.tab === 'local' ? `<span class="tstate ${s.cls}" ${s.title ? `title="${esc(s.title)}"` : ''}>${esc(s.label)}</span>` : ''}
      ${S.select ? `<span class="tcheck">${sel ? '✓' : ''}</span>` : ''}
      ${s?.pct != null ? `<div class="tprog"><i style="width:${s.pct}%"></i></div>` : ''}
    </div>
    <div class="tname" title="${esc(m.name)}">${esc(m.name)}</div>
    <div class="tmeta muted">${esc(meta)}</div>
    ${(m.status === 'error' && m.error) || (m.bunny_status === 'error' && m.bunny_error) ? `<div class="terr">${esc(m.status === 'error' ? m.error : m.bunny_error)}</div>` : ''}
    <div class="tbtns">${btns}</div>
  </div>`;
}

// Atualiza só os cards que mudaram (sem piscar a tela)
function renderGrid() {
  const grid = $('#grid');
  const list = visibleMedia();
  const existing = new Map($$('.tile', grid).map((el) => [el.dataset.id, el]));
  const tpl = document.createElement('template');
  let prev = null;
  for (const m of list) {
    const html = tileHtml(m);
    let el = existing.get(String(m.id));
    if (!el || el._html !== html) {
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstChild;
      fresh._html = html;
      if (el) el.replaceWith(fresh);
      el = fresh;
    }
    existing.delete(String(m.id));
    const want = prev ? prev.nextSibling : grid.firstChild;
    if (want !== el) grid.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  const empty = $('#emptyF');
  const total = S.cur ? S.cur.media.filter((m) => (S.tab === 'local' ? m.local : m.bunny_status === 'sent')).length : 0;
  empty.textContent = total ? 'Nada com esses filtros.' : S.tab === 'local'
    ? 'Nada no sistema nesta pasta. Cole links acima para baixar.' : 'Nada enviado ao Bunny ainda.';
  empty.classList.toggle('hidden', list.length > 0);
  updateSelBar();
}
['#q', '#fType', '#fStatus'].forEach((s) => { $(s).oninput = renderGrid; });

$$('.tab').forEach((t) => {
  t.onclick = () => {
    S.tab = t.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    setSelectMode(false);
    renderFolderHead(); renderGrid();
  };
});

const mediaById = (id) => S.cur?.media.find((m) => m.id === Number(id));

$('#grid').onclick = async (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const m = mediaById(tile.dataset.id);
  if (!m) return;
  const actEl = e.target.closest('[data-act]');
  if (S.select && !actEl) { toggleSel(m.id); return; }
  if (!actEl) { if (m.status === 'ready' && m.local) openViewer(m); else if (!m.local && m.bunny_url) window.open(m.bunny_url, '_blank'); return; }
  const act = actEl.dataset.act;
  if (act === 'open') return;
  e.preventDefault();
  try {
    if (act === 'edit') openEditor(m);
    else if (act === 'send') await sendIds([m.id]);
    else if (act === 'retry') await bulk('retry', [m.id]);
    else if (act === 'copy') copy(m.bunny_url);
    else if (act === 'more') await tileMenu(m);
  } catch (err) { fail(err); }
};

async function tileMenu(m) {
  const opts = [];
  if (m.status === 'ready' && m.local) opts.push({ label: '↓ Baixar arquivo', value: 'dl' });
  if (m.status === 'error' || m.bunny_status === 'error') opts.push({ label: 'Tentar de novo', value: 'retry' });
  if (m.bunny_url) opts.push({ label: 'Copiar link do Bunny', value: 'copy' });
  if (m.local && m.type === 'video' && m.status === 'ready') opts.push({ label: '🔧 Converter (se o vídeo não abre)', value: 'fix' });
  if (m.local) opts.push({ label: 'Mover para outra pasta', value: 'move' });
  if (m.local && m.bunny_status === 'sent') opts.push({ label: 'Liberar espaço (apagar só da VPS)', value: 'free' });
  opts.push({ label: m.local ? 'Apagar do sistema' : 'Remover do histórico', value: 'delete', danger: true });
  const v = await menu(m.name, opts);
  if (!v) return;
  if (v === 'dl') location.href = `/media/${m.id}?dl=1`;
  else if (v === 'copy') copy(m.bunny_url);
  else if (v === 'free') await freeIds([m.id]);
  else await bulk(v, [m.id]);
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Link copiado ✓'), () => ask('Copie o link', { value: text }));
}

// ---------- Seleção ----------
function setSelectMode(on) {
  S.select = on; S.selected.clear();
  $('#selectBtn').textContent = on ? 'Cancelar seleção' : 'Selecionar';
  $('#selBar').classList.toggle('hidden', !on);
  document.body.classList.toggle('selecting', on);
  if (S.cur) renderGrid();
}
function toggleSel(id) { S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id); renderGrid(); }
function updateSelBar() {
  $('#selCount').textContent = S.selected.size;
  const vis = visibleMedia();
  $('#selAll').textContent = vis.length && vis.every((m) => S.selected.has(m.id)) ? 'Limpar' : `Selecionar todas (${vis.length})`;
}
$('#selectBtn').onclick = () => setSelectMode(!S.select);
$('#selCancel').onclick = () => setSelectMode(false);
$('#selAll').onclick = () => {
  const vis = visibleMedia();
  if (vis.every((m) => S.selected.has(m.id))) S.selected.clear(); else vis.forEach((m) => S.selected.add(m.id));
  renderGrid();
};
$('#selBar').onclick = async (e) => {
  const b = e.target.closest('[data-bulk]'); if (!b) return;
  const list = [...S.selected];
  if (!list.length) return toast('Selecione pelo menos uma.');
  try {
    if (b.dataset.bulk === 'send') await sendIds(list);
    else if (b.dataset.bulk === 'zip') zipIds(list);
    else await bulk(b.dataset.bulk, list);
  } catch (err) { fail(err); }
};

async function sendIds(list) {
  const r = await api('/api/media/action', { method: 'POST', body: { action: 'send', ids: list } });
  if (r.queued) toast(`${plural(r.queued, 'arquivo foi', 'arquivos foram')} para a fila do Bunny`);
  else if (!r.skipped.length) toast('Já estavam no Bunny ou na fila.');
  if (r.skipped.length) {
    await confirmBox(`${r.skipped.length} não ${r.skipped.length === 1 ? 'pôde' : 'puderam'} ir`, r.skipped.slice(0, 8).map(esc).join('<br>'), 'OK');
  }
  if (S.select) setSelectMode(false);
  loadFolder();
}

async function bulk(action, list) {
  const items = list.map(mediaById).filter(Boolean);
  if (action === 'delete') {
    const unsafe = items.filter((m) => m.local && m.bunny_status !== 'sent').length;
    const history = items.filter((m) => !m.local).length;
    const txt = [unsafe && `<b>${plural(unsafe, 'arquivo ainda não foi', 'arquivos ainda não foram')} para o Bunny</b> e ${unsafe === 1 ? 'será perdido' : 'serão perdidos'}.`,
      history && `${plural(history, 'registro', 'registros')} só some${history === 1 ? '' : 'm'} do histórico (o Bunny não é afetado).`].filter(Boolean).join('<br>');
    if (!await confirmBox(`Apagar ${plural(items.length, 'item', 'itens')}?`, txt || 'Os arquivos já estão no Bunny; só somem do sistema.', 'Apagar', true)) return;
  }
  let folderId;
  if (action === 'move') {
    if (!S.folders.length) S.folders = await api('/api/folders');
    const others = folderTree().filter((t) => t.f.id !== S.cur.id);
    folderId = await menu('Mover para…', [...others.map((t) => ({ label: indentName(t), value: t.f.id })), { label: '+ Nova pasta…', value: 'new' }]);
    if (!folderId) return;
    if (folderId === 'new') { const f = await newFolder(); if (!f) return; folderId = f.id; }
  }
  await api('/api/media/action', { method: 'POST', body: { action, ids: list, folderId } });
  toast({ delete: 'Apagado.', move: 'Movido.', retry: 'Tentando de novo…', fix: 'Convertendo — o vídeo fica pronto em instantes.' }[action] || 'Feito.');
  if (S.select) setSelectMode(false);
  loadFolder();
  api('/api/folders').then((f) => { S.folders = f; }).catch(() => {});
}

function zipIds(list) {
  const form = document.createElement('form');
  form.method = 'POST'; form.action = '/api/zip';
  form.innerHTML = `<input type="hidden" name="ids" value="${list.join(',')}">`;
  document.body.appendChild(form); form.submit(); form.remove();
}

async function freeIds(list) {
  await showFreeResult(await api('/api/media/action', { method: 'POST', body: { action: 'free', ids: list } }));
  loadFolder();
}
$('#freeBtn').onclick = (e) => {
  const q = S.cur.quick;
  freeAll(S.cur.id, q.freeable, q.freeBytes, S.cur.subfolders.length ? 'desta pasta e das subpastas' : 'desta pasta', e.currentTarget);
};
$('#sendAllBtn').onclick = () => sendAll(S.cur.id, S.cur.quick.sendable, S.cur.subfolders.length ? 'nesta pasta e nas subpastas' : 'nesta pasta');
$('#subfolders').addEventListener('click', async (e) => {
  if (!e.target.closest('#addSubBtn')) return;
  const f = await newFolder(S.cur.id);
  if (f) { loadFolder(); refreshList(); }
});
const refreshList = () => api('/api/folders').then((f) => { S.folders = f; fillFolderSelect(); }).catch(() => {});

$('#folderMenu').onclick = async () => {
  const f = S.cur; if (!f) return;
  const v = await menu(f.name, [
    { label: '+ Nova subpasta', value: 'sub' },
    { label: 'Renomear', value: 'rename' },
    { label: `Destino no Bunny: ${{ auto: 'automático', storage: 'Storage', stream: 'Stream' }[f.dest]}`, value: 'dest' },
    { label: 'Baixar .zip do que está no sistema', value: 'zip' },
    { label: 'Apagar pasta', value: 'delete', danger: true },
  ]);
  try {
    if (v === 'sub') { if (await newFolder(f.id)) refreshList(); }
    else if (v === 'rename') {
      const name = await ask('Novo nome', { value: f.name, ok: 'Salvar' });
      if (name) { await api('/api/folders/' + f.id, { method: 'PATCH', body: { name } }); toast('Renomeada. No Bunny ela continua na mesma pasta.'); }
    } else if (v === 'dest') {
      const st = S.status?.bunny || {};
      const dest = await menu('Para onde vão os arquivos desta pasta?', [
        { label: 'Automático — vídeos enviados sozinhos vão pro Stream; fotos e vídeos enviados juntos vão pro Storage', value: 'auto' },
        { label: `Sempre Storage (pasta com fotos e vídeos)${st.storage === false ? ' — não configurado' : ''}`, value: 'storage' },
        { label: `Vídeos no Stream (fotos continuam no Storage)${st.stream === false ? ' — não configurado' : ''}`, value: 'stream' },
      ]);
      if (dest) await api('/api/folders/' + f.id, { method: 'PATCH', body: { dest } });
    } else if (v === 'zip') {
      const ids = f.media.filter((m) => m.local && m.status === 'ready').map((m) => m.id);
      ids.length ? zipIds(ids) : toast('Nada no sistema para baixar.');
    } else if (v === 'delete') {
      const unsafe = (f.deep.local || 0) - (f.deep.freeable || 0);
      const subs = f.subfolders.length ? `As subpastas (${f.subfolders.length}) também serão apagadas.<br>` : '';
      if (await confirmBox(`Apagar a pasta "${f.name}"?`, `${subs}${unsafe ? `<b>${plural(unsafe, 'arquivo', 'arquivos')} ainda não ${unsafe === 1 ? 'foi' : 'foram'} para o Bunny e ${unsafe === 1 ? 'será perdido' : 'serão perdidos'}.</b><br>` : ''}O que já está no Bunny não é afetado.`, 'Apagar pasta', true)) {
        await api('/api/folders/' + f.id, { method: 'DELETE' });
        S.folders = S.folders.filter((x) => x.id !== f.id);
        location.hash = f.parent_id ? '#f/' + f.parent_id : '';
      }
    }
    if (v && v !== 'delete') loadFolder();
  } catch (e) { fail(e); }
};

$('#backBtn').onclick = () => { location.hash = S.cur?.parent_id ? '#f/' + S.cur.parent_id : ''; };

// ---------- Visualizador ----------
let viewing = null;
function openViewer(m) {
  viewing = m;
  const src = `/media/${m.id}?v=${m.size || 0}`;
  $('#vBody').innerHTML = m.type === 'image' ? `<img src="${src}" alt="">` : `<video src="${src}" controls autoplay playsinline></video>`;
  const v = $('#vBody video');
  if (v) watchVideo(v, m);
  $('#vDl').href = `/media/${m.id}?dl=1`;
  $('#vSend').textContent = m.bunny_status === 'sent' ? '✓ No Bunny' : '↑ Bunny';
  $('#vSend').disabled = ['queued', 'uploading', 'verifying', 'sent'].includes(m.bunny_status);
  $('#viewer').classList.remove('hidden');
}
// Se o vídeo der erro ou não carregar em 10s, oferece converter
function watchVideo(v, m) {
  let done = false;
  const t = setTimeout(() => { if (!done && v.isConnected && v.readyState < 1) cantPlay(m); }, 10_000);
  v.addEventListener('loadedmetadata', () => {
    done = true; clearTimeout(t);
    if (!v.videoWidth) cantPlay(m); // só o áudio abriu: o codec de vídeo não é suportado (ex.: HEVC)
  }, { once: true });
  v.addEventListener('error', () => { if (!done) { done = true; clearTimeout(t); cantPlay(m); } }, { once: true });
}

async function cantPlay(m) {
  closeViewer(); if (ED.m) closeEditor();
  const ok = await confirmBox('Esse vídeo não abre no navegador',
    'O site entregou o vídeo num formato que o navegador não toca (ex.: HEVC/H.265). Converto para um MP4 comum — depois ele abre, edita e vai pro Bunny normalmente.',
    '🔧 Converter agora');
  if (ok) { await api('/api/media/action', { method: 'POST', body: { action: 'fix', ids: [m.id] } }).catch(fail); toast('Convertendo… acompanhe no card.'); loadFolder(); }
}

function closeViewer() { $('#vBody').innerHTML = ''; $('#viewer').classList.add('hidden'); viewing = null; }
$('#vClose').onclick = closeViewer;
$('#vEdit').onclick = () => { const m = viewing; closeViewer(); openEditor(m); };
$('#vSend').onclick = async () => { const m = viewing; closeViewer(); try { await sendIds([m.id]); } catch (e) { fail(e); } };

// ---------- Editor ----------
const ED = { m: null, el: null, nw: 0, nh: 0, fw: 0, fh: 0, crop: null, ar: null, trim: null, blur: null, toVideo: false, tab: 'crop', activeBlur: -1 };

function openEditor(m) {
  if (m.status !== 'ready' || !m.local) return toast('Essa mídia não está disponível para edição.');
  Object.assign(ED, { m, crop: { x: 0, y: 0, w: 1, h: 1 }, ar: null, trim: { start: 0, end: 0 }, blur: { all: false, areas: [], strength: 2 },
    toVideo: false, activeBlur: -1 });
  $('#edTitle').textContent = m.name;
  $('#edToVideo').checked = false; $('#edDur').value = 5;
  $$('#edAspect .chip').forEach((c) => c.classList.toggle('active', c.dataset.ar === ''));
  $$('[data-st]').forEach((c) => c.classList.toggle('active', c.dataset.st === '2'));
  $('[data-ed="trim"]').classList.toggle('hidden', m.type !== 'video');
  $('[data-ed="tovideo"]').classList.toggle('hidden', m.type !== 'image');
  const frame = $('#edFrame');
  frame.innerHTML = '';
  const el = document.createElement(m.type === 'video' ? 'video' : 'img');
  el.className = 'ed-media';
  if (m.type === 'video') { el.muted = true; el.playsInline = true; el.preload = 'auto'; el.loop = false; }
  el.src = `/media/${m.id}?v=${m.size || 0}`;
  ED.el = el;
  frame.appendChild(el);
  frame.insertAdjacentHTML('beforeend', '<div class="crop-box" id="cropBox"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div><div id="blurLayer"></div>');
  const ready = () => {
    ED.nw = el.naturalWidth || el.videoWidth; ED.nh = el.naturalHeight || el.videoHeight;
    if (!ED.nw) return; // vídeo sem imagem: watchVideo oferece converter
    if (m.type === 'video') { ED.trim = { start: 0, end: el.duration }; $('#edStart').value = 0; $('#edEnd').value = 1000; updateTrim(); }
    layoutEditor();
  };
  if (m.type === 'video') el.onloadedmetadata = ready; else el.onload = ready;
  if (m.type === 'video') watchVideo(el, m);
  else el.onerror = () => { toast('Não consegui abrir essa imagem.'); closeEditor(); };
  $('#editor').classList.remove('hidden');
  setEdTab('crop');
  attachRect($('#cropBox'), () => ED.crop, (r) => { ED.crop = r; }, () => ED.ar);
}

function closeEditor() {
  if (ED.el?.pause) ED.el.pause();
  $('#edFrame').innerHTML = ''; $('#editor').classList.add('hidden'); ED.m = null;
}
$('#edClose').onclick = closeEditor;
window.addEventListener('resize', debounce(() => { if (ED.m) layoutEditor(); }, 150));

function layoutEditor() {
  if (!ED.nw) return;
  const st = $('#edStage').getBoundingClientRect();
  const s = Math.min((st.width - 16) / ED.nw, (st.height - 16) / ED.nh);
  ED.fw = Math.round(ED.nw * s); ED.fh = Math.round(ED.nh * s);
  Object.assign($('#edFrame').style, { width: ED.fw + 'px', height: ED.fh + 'px' });
  drawOverlays();
}

const pctStyle = (r) => `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`;
function drawOverlays() {
  const cb = $('#cropBox');
  if (cb) {
    cb.style.cssText = pctStyle(ED.crop);
    const full = ED.crop.w > 0.995 && ED.crop.h > 0.995;
    cb.classList.toggle('full', full && ED.tab !== 'crop');
  }
  const blurPx = [0, 4, 10, 18][ED.blur.strength];
  ED.el.style.filter = ED.blur.all ? `blur(${blurPx}px)` : '';
  const layer = $('#blurLayer');
  if (layer.children.length !== ED.blur.areas.length) {
    layer.innerHTML = ED.blur.areas.map((_, i) => `<div class="blur-box" data-b="${i}"><button class="bx" data-del="${i}">✕</button><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div>`).join('');
    $$('.blur-box', layer).forEach((el) => {
      const i = +el.dataset.b;
      attachRect(el, () => ED.blur.areas[i], (r) => { ED.blur.areas[i] = r; }, () => null);
    });
  }
  $$('.blur-box', layer).forEach((el) => {
    const i = +el.dataset.b;
    el.style.cssText = pctStyle(ED.blur.areas[i]) + `;--bl:${blurPx}px`;
    el.classList.toggle('active', i === ED.activeBlur);
  });
  $('#edBlurAll').classList.toggle('active', ED.blur.all);
}
$('#edFrame').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { ED.blur.areas.splice(+del.dataset.del, 1); ED.activeBlur = -1; $('#blurLayer').innerHTML = ''; drawOverlays(); }
});

/** Arrastar/redimensionar uma caixa em frações (0–1) do quadro. */
function attachRect(el, get, set, aspect) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-del]')) return;
    // caixa de recorte ainda na imagem inteira: arrastar desenha um recorte novo (tratado no quadro)
    if (el.id === 'cropBox' && !e.target.dataset.h && isFull(ED.crop)) return;
    e.preventDefault(); e.stopPropagation();
    if (el.dataset.b !== undefined) { ED.activeBlur = +el.dataset.b; drawOverlays(); }
    const h = e.target.dataset.h || 'move';
    const r0 = { ...get() }, x0 = e.clientX, y0 = e.clientY;
    el.setPointerCapture(e.pointerId);
    const ar = aspect(); // proporção em pixels (largura/altura)
    const move = (ev) => {
      const dx = (ev.clientX - x0) / ED.fw, dy = (ev.clientY - y0) / ED.fh;
      let { x, y, w, hh } = { x: r0.x, y: r0.y, w: r0.w, hh: r0.h };
      if (h === 'move') {
        x = Math.min(1 - w, Math.max(0, r0.x + dx)); y = Math.min(1 - hh, Math.max(0, r0.y + dy));
      } else {
        const L = h.includes('w'), T = h.includes('n');
        let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
        if (L) x1 = Math.max(0, Math.min(x2 - 0.04, x1 + dx)); else x2 = Math.min(1, Math.max(x1 + 0.04, x2 + dx));
        if (T) y1 = Math.max(0, Math.min(y2 - 0.04, y1 + dy)); else y2 = Math.min(1, Math.max(y1 + 0.04, y2 + dy));
        x = x1; y = y1; w = x2 - x1; hh = y2 - y1;
        if (ar) { // mantém a proporção pela largura; se não couber, ajusta pela altura
          hh = (w * ED.fw) / (ar * ED.fh);
          if (T) y = y2 - hh;
          if (y < 0 || y + hh > 1) { hh = T ? y2 : 1 - y1; y = T ? 0 : y1; w = (hh * ED.fh * ar) / ED.fw; if (L) x = x2 - w; }
        }
      }
      set({ x, y, w, h: hh });
      drawOverlays();
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}

const isFull = (r) => r.x < 0.005 && r.y < 0.005 && r.w > 0.995 && r.h > 0.995;

// Recorte livre: arrastar sobre a imagem desenha o retângulo (respeita a proporção escolhida)
$('#edFrame').addEventListener('pointerdown', (e) => {
  if (!ED.m || ED.tab !== 'crop' || e.target.closest('i[data-h]')) return;
  if (e.target.closest('.crop-box') && !isFull(ED.crop)) return; // mover a caixa existente
  e.preventDefault();
  const frame = $('#edFrame'), box = frame.getBoundingClientRect();
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const ax = clamp((e.clientX - box.left) / ED.fw), ay = clamp((e.clientY - box.top) / ED.fh);
  const before = { ...ED.crop };
  frame.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const bx = clamp((ev.clientX - box.left) / ED.fw), by = clamp((ev.clientY - box.top) / ED.fh);
    let w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (ED.ar) { // mantém a proporção: usa a maior dimensão arrastada e limita à borda
      h = (w * ED.fw) / (ED.ar * ED.fh);
      const maxH = by >= ay ? 1 - ay : ay, maxW = bx >= ax ? 1 - ax : ax;
      if (h > maxH) { h = maxH; w = (h * ED.fh * ED.ar) / ED.fw; }
      if (w > maxW) { w = maxW; h = (w * ED.fw) / (ED.ar * ED.fh); }
    }
    const x = bx >= ax ? ax : ax - w, y = (ED.ar ? by >= ay : by >= ay) ? ay : ay - h;
    if (w < 0.03 || h < 0.03) return;
    ED.crop = { x, y, w, h };
    drawOverlays();
  };
  const up = () => {
    if (ED.crop.w < 0.03 || ED.crop.h < 0.03) ED.crop = before;
    frame.removeEventListener('pointermove', move); frame.removeEventListener('pointerup', up); frame.removeEventListener('pointercancel', up);
    drawOverlays();
  };
  frame.addEventListener('pointermove', move); frame.addEventListener('pointerup', up); frame.addEventListener('pointercancel', up);
});

function setEdTab(tab) {
  ED.tab = tab;
  $$('.ed-tabs .chip').forEach((c) => c.classList.toggle('active', c.dataset.ed === tab));
  $$('.ed-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  $('#edFrame').dataset.mode = tab;
  if (ED.m) drawOverlays();
}
$$('.ed-tabs .chip').forEach((c) => { c.onclick = () => setEdTab(c.dataset.ed); });

$('#edAspect').onclick = (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  if (c.id === 'edCropReset') { ED.ar = null; ED.crop = { x: 0, y: 0, w: 1, h: 1 }; $$('#edAspect .chip').forEach((x) => x.classList.toggle('active', x.dataset.ar === '')); return drawOverlays(); }
  $$('#edAspect .chip').forEach((x) => x.classList.toggle('active', x === c));
  ED.ar = c.dataset.ar ? Number(c.dataset.ar) : null;
  if (ED.ar) { // maior retângulo com essa proporção, centralizado
    const frameAr = ED.fw / ED.fh;
    let w = 1, h = 1;
    if (frameAr > ED.ar) w = (ED.ar * ED.fh) / ED.fw; else h = ED.fw / (ED.ar * ED.fh);
    ED.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  drawOverlays();
};

$('#edBlurAll').onclick = () => { ED.blur.all = !ED.blur.all; if (ED.blur.all) { ED.blur.areas = []; $('#blurLayer').innerHTML = ''; } drawOverlays(); };
$('#edBlurAdd').onclick = () => {
  ED.blur.all = false;
  ED.blur.areas.push({ x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
  ED.activeBlur = ED.blur.areas.length - 1;
  $('#blurLayer').innerHTML = ''; drawOverlays();
};
$$('[data-st]').forEach((c) => {
  c.onclick = () => { ED.blur.strength = +c.dataset.st; $$('[data-st]').forEach((x) => x.classList.toggle('active', x === c)); drawOverlays(); };
});

// Duração (vídeo)
function updateTrim() {
  const d = ED.el?.duration || 0;
  const a = +$('#edStart').value / 1000, b = +$('#edEnd').value / 1000;
  ED.trim = { start: +(a * d).toFixed(2), end: +(b * d).toFixed(2) };
  $('#edTrimSel').style.cssText = `left:${a * 100}%;width:${(b - a) * 100}%`;
  $('#edTrimInfo').textContent = `De ${fmtDur(ED.trim.start)} até ${fmtDur(ED.trim.end)} · fica com ${(ED.trim.end - ED.trim.start).toFixed(1)}s (original ${d.toFixed(1)}s)`;
}
$('#edStart').oninput = () => {
  if (+$('#edStart').value > +$('#edEnd').value - 10) $('#edStart').value = +$('#edEnd').value - 10;
  updateTrim(); ED.el.currentTime = ED.trim.start;
};
$('#edEnd').oninput = () => {
  if (+$('#edEnd').value < +$('#edStart').value + 10) $('#edEnd').value = +$('#edStart').value + 10;
  updateTrim(); ED.el.currentTime = ED.trim.end;
};
$('#edPlay').onclick = () => {
  const v = ED.el;
  if (!v || !v.play) return;
  if (v.paused) { if (v.currentTime < ED.trim.start || v.currentTime >= ED.trim.end - 0.05) v.currentTime = ED.trim.start; v.play(); }
  else v.pause();
};
setInterval(() => {
  const v = ED.el;
  if (!ED.m || ED.m.type !== 'video' || !v) return;
  if (!v.paused && v.currentTime >= ED.trim.end) { v.pause(); v.currentTime = ED.trim.start; }
  $('#edPlay').textContent = v.paused ? '▶' : '❚❚';
  $('#edHead').style.left = (v.duration ? (v.currentTime / v.duration) * 100 : 0) + '%';
}, 100);

$('#edSave').onclick = async () => {
  const m = ED.m; if (!m) return;
  const spec = {};
  const c = ED.crop;
  if (!(c.w > 0.995 && c.h > 0.995)) spec.crop = c;
  if (m.type === 'video' && ED.el.duration) {
    const d = ED.el.duration;
    if (ED.trim.start > 0.05 || ED.trim.end < d - 0.05) spec.trim = { start: ED.trim.start, end: ED.trim.end };
  }
  if (ED.blur.all || ED.blur.areas.length) spec.blur = ED.blur;
  if (m.type === 'image' && $('#edToVideo').checked) spec.toVideo = { duration: Number($('#edDur').value) || 5 };
  if (!Object.keys(spec).length) return toast('Nenhuma edição feita ainda.');
  $('#edSave').disabled = true;
  try {
    await api(`/api/media/${m.id}/edit`, { method: 'POST', body: { spec } });
    closeEditor();
    toast('Edição na fila — a cópia aparece na pasta com a marca "editado".', 4500);
    loadFolder();
  } catch (e) { fail(e); } finally { $('#edSave').disabled = false; }
};

// ---------- Ao vivo ----------
const refreshHome = debounce(() => loadHome().catch(() => {}), 400);
const refreshFolder = debounce(() => loadFolder().catch(() => {}), 400);
function refresh() { if (S.view === 'folder') refreshFolder(); else refreshHome(); }

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'c') {
      if (S.view === 'folder' && S.cur && (msg.f.includes(S.cur.id) || msg.f.includes(0))) refreshFolder();
      if (S.view === 'home') refreshHome();
    } else if (msg.t === 'p') {
      S.progress.set(msg.id, { k: msg.k, pct: msg.p });
      if (S.view === 'folder' && mediaById(msg.id)) renderGrid();
    }
  };
}

// ---------- Rotas ----------
function route() {
  const m = location.hash.match(/^#f\/(\d+)/);
  if (m) openFolder(Number(m[1])).catch(fail);
  else { S.view = 'home'; S.cur = null; showScreen('home'); loadHome().catch(fail); }
}
window.addEventListener('hashchange', () => { closeViewer(); if (ED.m) closeEditor(); route(); });

async function start() {
  const { authed } = await api('/api/me');
  if (!authed) return showScreen('login');
  const shared = new URLSearchParams(location.search).get('add');
  if (shared) { history.replaceState(null, '', '/' + location.hash); $('#urls').value = shared; }
  route();
  connectEvents();
  if (shared) toast('Link recebido — escolha a pasta e toque em Baixar.', 5000);
}
start().catch(fail);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
