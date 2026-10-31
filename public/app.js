const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (b) => !b ? '0 MB' : b > 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtDur = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
const STATUS = { queued: 'Na fila', downloading: 'Baixando', done: 'Pronto', partial: 'Incompleto', error: 'Erro' };

const S = {
  tab: 'lib', folder: '', folders: [], none: 0, stats: {},
  lib: [], libLimit: 120, libSig: '',
  currentId: null, albumItems: [], albumSig: '', listSig: '',
  selecting: false, selected: new Set(), viewList: [], viewIdx: 0,
};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  if (res.status === 401 && path !== '/api/login') { showScreen('login'); throw new Error('login'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro ' + res.status);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' bad' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), 3200);
}
const fail = (e) => { if (e.message !== 'login') toast(e.message, true); };

function showScreen(id) {
  ['login', 'main', 'album'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
  if (id !== 'album') S.currentId = null;
}

// ---------- Login ----------
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await post('/api/login', { pin: $('#pin').value });
    $('#pin').value = '';
    start();
  } catch (err) { $('#loginErr').textContent = err.message; }
};

// ---------- Painel (disco + atividade) ----------
async function loadStats() {
  const s = S.stats = await api('/api/stats');
  const chip = $('#disk');
  if (s.disk) {
    const low = s.disk.free < 5e9 || s.disk.free / s.disk.total < 0.1;
    chip.textContent = `${fmtBytes(s.disk.free)} livres · ${s.files} arquivos`;
    chip.title = `Biblioteca: ${fmtBytes(s.bytes)} no servidor · ${s.bunnyFiles} no Bunny\nyt-dlp ${s.engines['yt-dlp'] || '—'} · gallery-dl ${s.engines['gallery-dl'] || '—'}`;
    chip.classList.toggle('warn', low);
    if (low && !S.warned) { S.warned = true; toast('Disco quase cheio — use "Liberar espaço" no que já está no Bunny.', true); }
  }
  const busy = s.busy;
  $('#busyBadge').classList.toggle('hidden', !busy);
  $('#busyBadge').textContent = 'baixando';
  return s;
}

// ---------- Pastas ----------
async function loadFolders() {
  const { folders, none } = await api('/api/folders');
  S.folders = folders; S.none = none;
  const chips = [
    `<button class="chip-btn ${S.folder === '' ? 'on' : ''}" data-f="">Tudo</button>`,
    `<button class="chip-btn ${S.folder === 'none' ? 'on' : ''}" data-f="none">Sem pasta <small>${none}</small></button>`,
    ...folders.map((f) => `<button class="chip-btn ${S.folder === f.id ? 'on' : ''}" data-f="${f.id}">📁 ${esc(f.name)} <small>${f.count}</small></button>`),
    `<button class="chip-btn add" data-f="__new">+ Nova pasta</button>`,
  ];
  $('#folders').innerHTML = chips.join('');
  const keep = $('#addFolder').value;
  $('#addFolder').innerHTML = `<option value="">Salvar em: sem pasta</option>`
    + folders.map((f) => `<option value="${f.id}">📁 ${esc(f.name)}</option>`).join('')
    + `<option value="__new">+ Nova pasta…</option>`;
  if (folders.some((f) => f.id === keep)) $('#addFolder').value = keep;
  const cur = folders.find((f) => f.id === S.folder);
  $('#folderHead').classList.toggle('hidden', !cur);
  $('#selRemoveFolder').classList.toggle('hidden', !cur);
  if (cur) {
    $('#fName').textContent = cur.name;
    $('#fZip').href = `/api/folders/${cur.id}/zip`;
  }
}

async function newFolder() {
  const name = prompt('Nome da nova pasta:');
  if (!name?.trim()) return null;
  const f = await post('/api/folders', { name });
  await loadFolders();
  return f;
}

$('#folders').onclick = async (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  if (b.dataset.f === '__new') {
    try { const f = await newFolder(); if (f) { S.folder = f.id; await refreshLib(true); } } catch (err) { fail(err); }
    return;
  }
  S.folder = b.dataset.f;
  clearSelection();
  await refreshLib(true);
};

$('#addFolder').onchange = async () => {
  if ($('#addFolder').value !== '__new') return;
  try { const f = await newFolder(); $('#addFolder').value = f ? f.id : ''; } catch (err) { fail(err); $('#addFolder').value = ''; }
};

$('#fRename').onclick = async () => {
  const cur = S.folders.find((f) => f.id === S.folder);
  const name = prompt('Novo nome da pasta:', cur?.name || '');
  if (!name?.trim()) return;
  await api('/api/folders/' + S.folder, { method: 'PATCH', body: JSON.stringify({ name }) }).catch(fail);
  loadFolders();
};
$('#fDelete').onclick = async () => {
  if (!confirm('Apagar a pasta? Os arquivos continuam na biblioteca, só saem da pasta.')) return;
  await api('/api/folders/' + S.folder, { method: 'DELETE' }).catch(fail);
  S.folder = '';
  refreshLib(true);
};
$('#fBunny').onclick = async () => {
  const cur = S.folders.find((f) => f.id === S.folder);
  const { items } = await api('/api/items?folder=' + S.folder);
  sendToBunny(items.filter((i) => i.local).map((i) => i.id), cur?.name);
};

// ---------- Biblioteca ----------
const FILTERS = { q: '#q', type: '#fType', orient: '#fOrient', dur: '#fDur', hd: '#fHd', site: '#fSite', used: '#fUsed', bunny: '#fBunnyF' };
function libQuery() {
  const p = new URLSearchParams();
  if (S.folder) p.set('folder', S.folder);
  for (const [k, sel] of Object.entries(FILTERS)) { const v = $(sel).value.trim(); if (v) p.set(k, v); }
  return p.toString();
}

async function refreshLib(resetLimit) {
  if (resetLimit) { S.libLimit = 120; S.libSig = ''; }
  await loadFolders();
  const { items, sites } = await api('/api/items?' + libQuery());
  const siteSel = $('#fSite');
  const curSite = siteSel.value;
  siteSel.innerHTML = '<option value="">Todos os sites</option>' + sites.map((s) => `<option>${esc(s)}</option>`).join('');
  siteSel.value = sites.includes(curSite) ? curSite : '';
  S.lib = items;
  const bytes = items.reduce((s, i) => s + (i.local ? i.size : 0), 0);
  const v = items.filter((i) => i.type === 'video').length;
  $('#libCount').textContent = `${items.length} arquivo${items.length === 1 ? '' : 's'} · ${v} vídeo${v === 1 ? '' : 's'} · ${items.length - v} foto${items.length - v === 1 ? '' : 's'} · ${fmtBytes(bytes)}`;
  const shown = items.slice(0, S.libLimit);
  const sig = JSON.stringify(shown.map((i) => [i.id, i.used, i.bunny?.status, i.local, i.folders.length])) + S.selecting;
  if (sig !== S.libSig) {
    S.libSig = sig;
    $('#libGrid').innerHTML = shown.map(tileHtml).join('');
  }
  $('#moreBtn2').classList.toggle('hidden', items.length <= S.libLimit);
  $('#libEmpty').classList.toggle('hidden', items.length > 0);
  syncSelectionMarks();
}
$('#moreBtn2').onclick = () => { S.libLimit += 240; refreshLib(); };

let qTimer;
$('#q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(() => refreshLib(true).catch(fail), 250); };
for (const sel of Object.values(FILTERS).slice(1)) $(sel).onchange = () => refreshLib(true).catch(fail);

function tileHtml(it) {
  if (it.status !== 'done') {
    const label = it.status === 'error' ? '⚠ falhou' : it.status === 'downloading' ? 'baixando…' : it.status === 'processing' ? 'preparando…' : 'na fila';
    return `<div class="tile"><div class="state">${it.type === 'image' ? 'foto' : 'vídeo'}<br>${label}</div></div>`;
  }
  const img = it.type === 'image' ? it.src : it.thumb;
  const inner = img
    ? `<img loading="lazy" src="${esc(img)}" alt="">`
    : `<video muted preload="metadata" src="${esc(it.src)}#t=1"></video>`;
  const b = it.bunny?.status;
  const cloud = b === 'done' ? '<i title="no Bunny">☁</i>' : b === 'queued' || b === 'uploading' ? '<i class="up" title="enviando">⏫</i>' : b === 'error' ? '<i class="bad" title="erro no envio">⚠</i>' : '';
  return `<div class="tile" data-id="${esc(it.id)}">${inner}
    ${it.type === 'video' ? `<span class="play">▶</span>${it.duration ? `<span class="tag tl">${fmtDur(it.duration)}</span>` : ''}` : ''}
    <span class="tags tr">${it.used ? '<i class="ok" title="já usei">✓</i>' : ''}${cloud}</span>
    <span class="check"></span>
    ${it.local ? `<a class="dl" href="${esc(it.src)}?dl=1" download title="Baixar">↓</a>` : ''}
  </div>`;
}

// ---------- Downloads ----------
async function loadSources() {
  const list = await api('/api/sources');
  const sig = JSON.stringify(list.map((a) => [a.id, a.status, a.done, a.total, a.progress, a.note, a.thumb]));
  $('#empty').classList.toggle('hidden', list.length > 0);
  if (sig === S.listSig) return;
  S.listSig = sig;
  $('#list').innerHTML = list.map((a) => {
    const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
    const thumb = a.thumb ? `style="background-image:url('${a.thumb}')"` : '';
    const parts = [a.videos && `${a.videos} vídeo${a.videos > 1 ? 's' : ''}`, a.images && `${a.images} foto${a.images > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
    const badge = (STATUS[a.status] || a.status) + (a.status === 'downloading' && a.progress ? ` ${a.progress}` : '');
    return `<div class="card st-${a.status}" data-id="${a.id}">
      <div class="thumb" ${thumb}><span class="badge">${esc(badge)}</span><span class="site">${esc(a.site)}</span></div>
      <div class="info"><div class="t">${esc(a.title || a.url)}</div>
        <div class="muted small">${esc(a.note || parts || (a.status === 'error' ? a.error : '…'))}</div>
        <div class="bar"><i style="width:${a.status === 'done' ? 100 : pct}%"></i></div></div></div>`;
  }).join('');
}
$('#list').onclick = (e) => { const c = e.target.closest('.card'); if (c) openAlbum(c.dataset.id); };

// ---------- Adicionar ----------
const urlBox = $('#url');
const grow = () => { urlBox.style.height = 'auto'; urlBox.style.height = Math.min(urlBox.scrollHeight, 180) + 'px'; };
urlBox.oninput = grow;
urlBox.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addUrls(urlBox.value); } };

async function addUrls(text) {
  text = (text || '').trim();
  if (!text) return;
  $('#addBtn').disabled = true;
  const msg = $('#addMsg');
  msg.className = 'small muted';
  msg.textContent = 'Enviando…';
  try {
    const folderId = $('#addFolder').value && $('#addFolder').value !== '__new' ? $('#addFolder').value : undefined;
    const r = await post('/api/sources', { urls: text, folderId });
    const bits = [r.added && `${r.added} na fila`, r.existed && `${r.existed} já salvo${r.existed > 1 ? 's' : ''}`, r.invalid && `${r.invalid} link${r.invalid > 1 ? 's' : ''} inválido${r.invalid > 1 ? 's' : ''}`].filter(Boolean);
    msg.className = 'small ok';
    msg.textContent = (bits.join(' · ') || 'Pronto') + '. Pode colar o próximo.';
    urlBox.value = ''; grow();
    setTab('dl');
    loadStats().catch(() => {});
  } catch (err) {
    if (err.message === 'login') return;
    msg.className = 'small err';
    msg.textContent = err.message;
  } finally { $('#addBtn').disabled = false; }
}
$('#addForm').onsubmit = (e) => { e.preventDefault(); addUrls(urlBox.value); };
$('#pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    urlBox.value = (urlBox.value.trim() ? urlBox.value.trim() + '\n' : '') + t.trim();
    grow();
    if (/https?:\/\//i.test(t)) addUrls(urlBox.value);
  } catch { urlBox.focus(); $('#addMsg').textContent = 'Toque e segure no campo para colar.'; }
};

// ---------- Abas ----------
function setTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#lib').classList.toggle('hidden', tab !== 'lib');
  $('#dl').classList.toggle('hidden', tab !== 'dl');
  $('#acc').classList.toggle('hidden', tab !== 'acc');
  clearSelection();
  refreshView().catch(fail);
}
$$('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

// ---------- Contas ----------
const fmtDate = (d) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
async function loadAccounts() {
  const list = await api('/api/accounts');
  const now = Date.now();
  $('#accList').innerHTML = list.length ? list.map((a) => {
    const exp = a.expiresAt ? new Date(a.expiresAt).getTime() : null;
    const status = !a.valid ? '<span class="err">vencida — exporte de novo</span>'
      : exp && exp - now < 3 * 864e5 ? `<span class="warn">vence ${fmtDate(a.expiresAt)}</span>`
      : exp ? `<span class="ok">ok até ${fmtDate(a.expiresAt)}</span>` : '<span class="ok">ok</span>';
    return `<div class="acc"><div><b>🔑 ${esc(a.domain)}</b><div class="muted small">${a.valid} cookies · atualizada ${fmtDate(a.updatedAt)} · ${status}</div></div>
      <button class="btn danger small-btn" data-del="${esc(a.domain)}">Remover</button></div>`;
  }).join('') : '<p class="muted small center">Nenhuma conta ainda. Só precisa para sites que pedem login.</p>';
  const s = S.stats;
  const yes = (v, t) => `<span class="${v ? 'ok' : 'muted'}">${v ? '●' : '○'}</span> ${t}`;
  $('#sysInfo').innerHTML = [
    yes(s.engines?.['yt-dlp'], `yt-dlp ${esc(s.engines?.['yt-dlp'] || 'não instalado')}`),
    yes(s.engines?.['gallery-dl'], `gallery-dl ${esc(s.engines?.['gallery-dl'] || 'não instalado')}`),
    yes(s.browser, s.browser ? 'Navegador invisível ligado (último recurso)' : 'Navegador invisível desligado'),
    yes(s.proxy !== 'off', s.proxy === 'off' ? 'Proxy: não configurado (PROXY_URL)' : s.proxy === 'always' ? 'Proxy: sempre' : 'Proxy: só quando o site bloquear'),
    yes(s.bunny, s.bunny ? 'Bunny configurado' : 'Bunny não configurado'),
  ].map((l) => `<div>${l}</div>`).join('');
}
$('#accList').onclick = async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm(`Remover a conta de ${b.dataset.del}?`)) return;
  await api('/api/accounts/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }).catch(fail);
  loadAccounts();
};
$('#ckFile').onchange = async () => {
  const f = $('#ckFile').files[0];
  if (f) $('#ckText').value = await f.text();
  $('#ckFile').value = '';
};
$('#ckSave').onclick = async () => {
  const msg = $('#ckMsg');
  try {
    const r = await post('/api/accounts', { text: $('#ckText').value });
    $('#ckText').value = '';
    msg.className = 'small ok';
    msg.textContent = `Conta salva: ${r.sites.join(', ')}` + (r.retried ? ` · ${r.retried} download(s) que tinham falhado voltaram para a fila` : '');
    loadAccounts();
  } catch (err) { msg.className = 'small err'; msg.textContent = err.message; }
};

// ---------- Fonte aberta ----------
async function openAlbum(id) {
  S.currentId = id;
  S.albumSig = '';
  clearSelection();
  $('#aMenu').classList.add('hidden');
  $('#media').innerHTML = '';
  showScreen('album');
  S.currentId = id;
  if (location.hash !== '#a/' + id) history.pushState({ id }, '', '#a/' + id);
  await loadAlbum(id).catch(fail);
}

async function loadAlbum(id) {
  const a = await api('/api/sources/' + id);
  if (S.currentId !== id) return;
  $('#aTitle').textContent = a.title || a.url;
  $('#aMeta').textContent = [a.site, a.author && '@' + a.author, `${a.done}/${a.total} arquivos`, fmtBytes(a.bytes), STATUS[a.status], a.status === 'downloading' && a.progress].filter(Boolean).join(' · ');
  $('#aNote').textContent = a.note || '';
  $('#aDiag').classList.toggle('hidden', !a.error);
  $('#aErr').textContent = a.error || '';
  $('#aHint').textContent = a.hint || '';
  $('#aDetail').textContent = a.errorDetail || '';
  $('#aDetail').closest('details').classList.toggle('hidden', !a.errorDetail);
  $('#aGoAcc').classList.toggle('hidden', !['login', 'blocked'].includes(a.errorCode));
  $('#aRetry2').classList.toggle('hidden', !['error', 'partial'].includes(a.status) || a.errorCode === 'drm');
  $('#zipBtn').href = `/api/sources/${id}/zip`;
  $('#zipBtn').classList.toggle('hidden', !a.done);
  $('#openOrig').href = a.url;
  $('#retryBtn').classList.toggle('hidden', !['error', 'partial'].includes(a.status));
  S.albumItems = a.items;
  const sig = JSON.stringify(a.items.map((i) => [i.id, i.status, i.used, i.bunny?.status, i.local])) + S.selecting;
  if (sig !== S.albumSig) {
    S.albumSig = sig;
    $('#media').innerHTML = a.items.map(tileHtml).join('');
  }
  syncSelectionMarks();
}

$('#backBtn').onclick = () => (history.length > 1 ? history.back() : (showScreen('main'), refreshView()));
window.onpopstate = () => {
  closeViewer();
  if (location.hash.startsWith('#a/')) openAlbum(location.hash.slice(3));
  else { showScreen('main'); clearSelection(); refreshView().catch(fail); }
};
$('#moreBtn').onclick = () => $('#aMenu').classList.toggle('hidden');
$('#aGoAcc').onclick = () => { history.back(); setTimeout(() => setTab('acc'), 50); };
$('#aRetry2').onclick = () => $('#retryBtn').click();
$('#retryBtn').onclick = async () => { await post(`/api/sources/${S.currentId}/retry`).catch(fail); loadAlbum(S.currentId); };
$('#delBtn').onclick = async () => {
  if (!confirm('Apagar esse download e todos os arquivos dele do servidor? (o que já está no Bunny continua lá)')) return;
  try { await api('/api/sources/' + S.currentId, { method: 'DELETE' }); history.back(); } catch (e) { fail(e); }
};
$('#aFolderBtn').onclick = async () => {
  const r = await pickFolder('Pôr tudo numa pasta', false);
  if (!r) return;
  await post(`/api/sources/${S.currentId}/folders`, { folderId: r.folderId }).catch(fail);
  toast('Tudo desse download foi para a pasta (e o que ainda chegar também).');
  S.albumSig = '';
  loadAlbum(S.currentId);
};
$('#aSelBtn').onclick = () => { $('#aMenu').classList.add('hidden'); startSelecting(); };

// ---------- Cliques nos arquivos (abrir / selecionar / segurar para selecionar) ----------
const currentList = () => (S.currentId ? S.albumItems.filter((i) => i.status === 'done') : S.lib.slice(0, S.libLimit));
let pressT, pressed = false;
for (const grid of ['#libGrid', '#media']) {
  const g = $(grid);
  g.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.tile[data-id]');
    if (!t || e.target.closest('.dl')) return;
    pressed = false;
    pressT = setTimeout(() => { pressed = true; if (!S.selecting) startSelecting(); toggleSel(t.dataset.id); }, 480);
  });
  ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach((ev) => g.addEventListener(ev, (e) => {
    if (ev === 'pointermove' && Math.abs(e.movementX) + Math.abs(e.movementY) < 4) return;
    clearTimeout(pressT);
  }));
  g.addEventListener('contextmenu', (e) => { if (e.target.closest('.tile[data-id]')) e.preventDefault(); });
  g.onclick = (e) => {
    if (e.target.closest('.dl')) return;
    const t = e.target.closest('.tile[data-id]');
    if (!t) return;
    if (pressed) { pressed = false; return; }
    if (S.selecting) return toggleSel(t.dataset.id);
    const list = currentList();
    openViewer(list, list.findIndex((i) => i.id === t.dataset.id));
  };
}

// ---------- Seleção ----------
$('#selBtn').onclick = () => (S.selecting ? clearSelection() : startSelecting());
function startSelecting() {
  S.selecting = true;
  document.body.classList.add('selecting');
  $('#selBar').classList.remove('hidden');
  updateSelBar();
}
function clearSelection() {
  S.selecting = false;
  S.selected.clear();
  document.body.classList.remove('selecting');
  $('#selBar').classList.add('hidden');
  syncSelectionMarks();
}
function toggleSel(id) {
  S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
  syncSelectionMarks();
  updateSelBar();
}
function syncSelectionMarks() {
  $$('.tile[data-id]').forEach((t) => t.classList.toggle('sel', S.selected.has(t.dataset.id)));
  $('#selBtn').textContent = S.selecting ? 'Cancelar' : 'Selecionar';
}
function updateSelBar() {
  $('#selCount').textContent = `${S.selected.size} selecionado${S.selected.size === 1 ? '' : 's'}`;
}
$('#selClose').onclick = clearSelection;
$('#selAll').onclick = () => {
  const list = S.currentId ? S.albumItems.filter((i) => i.status === 'done') : S.lib;
  const all = list.every((i) => S.selected.has(i.id));
  list.forEach((i) => (all ? S.selected.delete(i.id) : S.selected.add(i.id)));
  syncSelectionMarks(); updateSelBar();
};

const byId = (id) => S.lib.find((i) => i.id === id) || S.albumItems.find((i) => i.id === id);

async function runAction(action, ids, extra = {}) {
  const r = await post('/api/items/action', { ids, action, ...extra });
  await refreshView();
  return r;
}

function downloadZip(ids, name) {
  const f = $('#zipForm');
  f.elements.namedItem('ids').value = JSON.stringify(ids);
  f.elements.namedItem('name').value = name || '';
  f.submit();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

async function sendToBunny(ids, suggested) {
  if (!S.stats.bunny) return toast('Bunny não configurado no servidor (falta BUNNY_STORAGE_ZONE / KEY / CDN_URL).', true);
  if (!ids.length) return toast('Nada para enviar (só arquivos que estão no servidor).', true);
  const folder = prompt(`Enviar ${ids.length} arquivo(s) para qual pasta do Bunny?`, suggested || S.folders.find((f) => f.id === S.folder)?.name || 'geral');
  if (folder === null) return;
  try {
    const r = await runAction('bunny', ids, { bunnyFolder: folder || 'geral' });
    toast(r.count ? `${r.count} na fila de envio pro Bunny ☁` : 'Esses já estavam no Bunny nessa pasta.');
  } catch (e) { fail(e); }
}

$('#selBar').onclick = async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const ids = [...S.selected];
  if (!ids.length) return toast('Selecione pelo menos um arquivo.', true);
  const act = b.dataset.act;
  try {
    if (act === 'zip') return downloadZip(ids, S.folders.find((f) => f.id === S.folder)?.name);
    if (act === 'bunny') return sendToBunny(ids);
    if (act === 'links') {
      const urls = ids.map(byId).map((i) => i?.bunny?.url).filter(Boolean);
      if (!urls.length) return toast('Nenhum dos selecionados está no Bunny ainda.', true);
      await copyText(urls.join('\n'));
      return toast(`${urls.length} link(s) copiado(s)`);
    }
    if (act === 'folder') {
      const r = await pickFolder(`${ids.length} arquivo(s) → pasta`, true);
      if (!r) return;
      await runAction(r.mode, ids, { folderId: r.folderId });
      return toast('Feito ✓');
    }
    if (act === 'removeFolder') { await runAction('removeFolder', ids, { folderId: S.folder }); return toast('Tirados da pasta'); }
    if (act === 'freeLocal') {
      const n = ids.map(byId).filter((i) => i?.bunny?.status === 'done' && i.local).length;
      if (!n) return toast('Só dá para liberar o que já está no Bunny.', true);
      if (!confirm(`Apagar do servidor ${n} arquivo(s) que já estão no Bunny? Eles continuam visíveis aqui, vindo do Bunny.`)) return;
    }
    if (act === 'delete' && !confirm(`Apagar ${ids.length} arquivo(s) do servidor? (o que estiver no Bunny continua lá)`)) return;
    const r = await runAction(act, ids);
    toast(`${r.count} arquivo(s) atualizados`);
    if (act === 'delete') { S.selected.clear(); updateSelBar(); }
  } catch (err) { fail(err); }
};

// ---------- Escolher pasta (folha) ----------
function pickFolder(title, withMode) {
  return new Promise((resolve) => {
    let mode = 'addFolder';
    const sheet = $('#sheet');
    $('#sheetTitle').textContent = title;
    $('#sheetMode').classList.toggle('hidden', !withMode);
    $$('#sheetMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    const render = () => {
      $('#sheetList').innerHTML = S.folders.length
        ? S.folders.map((f) => `<button class="btn ghost wide left" data-id="${f.id}">📁 ${esc(f.name)} <small class="muted">${f.count}</small></button>`).join('')
        : '<p class="muted small">Nenhuma pasta ainda — crie a primeira.</p>';
    };
    render();
    sheet.classList.remove('hidden');
    const done = (v) => { sheet.classList.add('hidden'); resolve(v); };
    $('#sheetMode').onclick = (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      mode = b.dataset.mode;
      $$('#sheetMode button').forEach((x) => x.classList.toggle('on', x === b));
    };
    $('#sheetList').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) done({ folderId: b.dataset.id, mode }); };
    $('#sheetNew').onclick = async () => { try { const f = await newFolder(); if (f) done({ folderId: f.id, mode }); } catch (err) { fail(err); } };
    $('#sheetCancel').onclick = () => done(null);
    sheet.onclick = (e) => { if (e.target === sheet) done(null); };
  });
}

// ---------- Visualizador ----------
function openViewer(list, idx) {
  if (idx < 0) return;
  S.viewList = list; S.viewIdx = idx;
  renderViewer();
  $('#viewer').classList.remove('hidden');
}
function renderViewer() {
  const it = S.viewList[S.viewIdx];
  if (!it) return closeViewer();
  $('#vBody').innerHTML = it.type === 'image'
    ? `<img src="${esc(it.src)}" alt="">`
    : `<video src="${esc(it.src)}" controls autoplay playsinline></video>`;
  $('#vDl').href = it.local ? it.src + '?dl=1' : it.src;
  $('#vDl').toggleAttribute('download', it.local);
  $('#vUsed').textContent = it.used ? '↺ Desmarcar usado' : '✓ Marcar usado';
  $('#vUsed').classList.toggle('on', it.used);
  const b = it.bunny?.status;
  $('#vBunny').textContent = b === 'done' ? '☁ No Bunny' : b === 'queued' || b === 'uploading' ? '⏫ Enviando…' : '☁ Enviar pro Bunny';
  $('#vBunny').disabled = b === 'queued' || b === 'uploading' || !it.local;
  $('#vLink').classList.toggle('hidden', !it.bunny?.url);
  const dims = it.width ? `${it.width}×${it.height}` : '';
  $('#vInfo').textContent = [`${S.viewIdx + 1}/${S.viewList.length}`, it.albumTitle, dims, it.duration && fmtDur(it.duration), fmtBytes(it.size), it.bunny?.error && '⚠ ' + it.bunny.error].filter(Boolean).join(' · ');
  $('#vPrev').classList.toggle('hidden', S.viewIdx === 0);
  $('#vNext').classList.toggle('hidden', S.viewIdx >= S.viewList.length - 1);
}
function closeViewer() { $('#vBody').innerHTML = ''; $('#viewer').classList.add('hidden'); }
const step = (d) => { const n = S.viewIdx + d; if (n >= 0 && n < S.viewList.length) { S.viewIdx = n; renderViewer(); } };
$('#vClose').onclick = closeViewer;
$('#vPrev').onclick = () => step(-1);
$('#vNext').onclick = () => step(1);
document.addEventListener('keydown', (e) => {
  if ($('#viewer').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'Escape') closeViewer();
});
let tx = null;
$('#vBody').addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
$('#vBody').addEventListener('touchend', (e) => {
  if (tx === null) return;
  const dx = e.changedTouches[0].clientX - tx;
  tx = null;
  if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
});
$('#vUsed').onclick = async () => {
  const it = S.viewList[S.viewIdx];
  try { await runAction(it.used ? 'unused' : 'used', [it.id]); it.used = !it.used; renderViewer(); } catch (e) { fail(e); }
};
$('#vBunny').onclick = async () => {
  const it = S.viewList[S.viewIdx];
  await sendToBunny([it.id]);
  it.bunny = { status: 'queued' };
  renderViewer();
};
$('#vLink').onclick = async () => { await copyText(S.viewList[S.viewIdx].bunny.url); toast('Link copiado'); };

// ---------- Atualização automática enquanto algo baixa/envia ----------
async function refreshView() {
  if (S.currentId) return loadAlbum(S.currentId);
  if (S.tab === 'dl') return loadSources();
  if (S.tab === 'acc') return loadAccounts();
  return refreshLib();
}
let wasBusy = false;
async function tick() {
  try {
    if (!$('#login').classList.contains('hidden')) return;
    const s = await loadStats();
    if (s.busy || wasBusy) await refreshView();
    wasBusy = s.busy;
  } catch { /* sem rede: tenta de novo */ }
  finally { setTimeout(tick, document.hidden ? 15000 : 3000); }
}

// ---------- Início ----------
async function start() {
  const { authed, configured } = await api('/api/me');
  if (!authed) {
    showScreen('login');
    if (!configured) $('#loginErr').textContent = 'Servidor sem PIN configurado (APP_PIN). O Cofre fica bloqueado até definir.';
    return;
  }
  await loadStats().catch(() => {});
  const shared = new URLSearchParams(location.search).get('add');
  if (location.hash.startsWith('#a/')) return openAlbum(location.hash.slice(3));
  showScreen('main');
  await refreshLib(true).catch(fail);
  if (shared) { history.replaceState(null, '', '/'); addUrls(shared); }
}
start().finally(() => setTimeout(tick, 3000));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
