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
  stage: '', tagFilter: [], dest: 'cofre', activeIds: new Set(), clipA: 0, clipB: null,
};
const STAGES = [['', 'Tudo'], ['bruto', 'Bruto'], ['selecionado', 'Separado'], ['bunny', 'No Bunny'], ['usado', 'Usado']];
const fmtSpeed = (b) => (b ? fmtBytes(b) + '/s' : '');
const fmtEta = (s) => (s == null ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s}s`);
const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60e3); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} d`; };
const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
// Avisa quando um arquivo cai numa persona que já tem (ou já usou) ele em OUTRA persona
function warnConflicts(r) {
  if (!r?.conflicts?.length) return;
  const names = [...new Set(r.conflicts.flatMap((c) => c.personas))];
  toast(`⚠ ${r.conflicts.length} arquivo(s) já são de outra persona: ${names.join(', ')}`, true);
}

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
  } catch (err) {
    $('#loginErr').textContent = err.message;
    $('#pin').value = '';
    const box = $('.login-box');
    box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
    $('#pin').classList.add('bad');
    $('#pin').focus();
  }
};
$('#pin').oninput = () => $('#pin').classList.remove('bad');

// ---------- Painel (disco + atividade) ----------
async function loadStats() {
  const s = S.stats = await api('/api/stats');
  renderHealth(s);
  const busy = s.busy;
  $('#busyBadge').classList.toggle('hidden', !busy);
  $('#busyBadge').textContent = 'ao vivo';
  renderStages();
  return s;
}

// ---------- Saúde da VPS (o Cofre divide a máquina com os apps de venda) ----------
function renderHealth(s) {
  const h = s.health;
  const chip = $('#disk');
  if (!h) { chip.textContent = s.disk ? `${fmtBytes(s.disk.free)} livres` : ''; return; }
  const b = h.brake;
  const app = h.apps?.[0];
  chip.className = 'chip health h-' + b.level;
  chip.innerHTML = `${b.level === 'ok' ? 'VPS ok' : b.level === 'warn' ? 'VPS apertada' : 'Cofre pausado'}`
    + (h.disk ? ` · ${fmtBytes(h.disk.free)} livres` : '')
    + (app?.ms != null ? ` · app ${app.ms} ms` : app && app.ok === false ? ' · app sem resposta' : '');
  chip.title = b.reasons.join('\n') || 'Toque para ver a saúde da VPS';
  if (b.level !== 'ok' && S.lastBrake !== b.reasons.join()) toast('⏸ ' + b.reasons[0], true);
  S.lastBrake = b.reasons.join();
  // "Guardar no Cofre" fica bloqueado quando o disco da VPS aperta
  const local = $('#destSeg [data-dest="cofre"]');
  local.disabled = !b.storeLocal;
  if (!b.storeLocal && S.dest === 'cofre' && s.bunny) $('#destSeg [data-dest="bunny"]').click();
  if (S.tab === 'dl') renderVps(h, s);
}
$('#disk').onclick = () => { if (S.currentId) history.back(); setTab('dl'); };

function renderVps(h, s) {
  const bar = (pct, warnAt, stopAt) => `<div class="bar vbar-h ${pct >= stopAt ? 'b-stop' : pct >= warnAt ? 'b-warn' : 'b-ok'}"><i style="width:${Math.min(100, pct)}%"></i></div>`;
  const rows = [];
  if (h.disk) {
    const used = Math.round((1 - h.disk.free / h.disk.total) * 100);
    const freeGB = h.disk.free / 1024 ** 3;
    rows.push(`<div class="vrow"><span>Disco</span><b>${fmtBytes(h.disk.free)} livres de ${fmtBytes(h.disk.total)}</b>${bar(used, 100 - 100 * h.limits.diskLocalGB * 1024 ** 3 / h.disk.total, 100 - 100 * h.limits.diskStopGB * 1024 ** 3 / h.disk.total)}<small>${freeGB < h.limits.diskLocalGB ? 'só "Direto pro Bunny"' : `freia abaixo de ${h.limits.diskLocalGB} GB`} · Cofre guarda ${fmtBytes(s.bytes)}</small></div>`);
  }
  if (h.mem) rows.push(`<div class="vrow"><span>Memória</span><b>${h.mem.pct}% em uso · ${fmtBytes(h.mem.total)}</b>${bar(h.mem.pct, h.limits.memPct - 10, h.limits.memPct)}<small>o Cofre usa ${fmtBytes(h.mem.cofre)} · freia em ${h.limits.memPct}%</small></div>`);
  if (h.cpu) rows.push(`<div class="vrow"><span>Processador</span><b>${h.cpu.pct ?? '—'}% · ${h.cpu.cores} núcleos</b>${bar(h.cpu.pct || 0, h.limits.cpuPct - 20, h.limits.cpuPct)}<small>carga ${h.cpu.load} · freia em ${h.limits.cpuPct}% por ${h.limits.cpuMin} min</small></div>`);
  const apps = (h.apps || []).map((a) => `<div class="app ${a.ok === false ? 'down' : a.ok ? 'up' : ''}"><b class="hdot"></b> ${esc(a.name)} <small>${a.ok == null ? 'checando…' : a.ok ? `${a.ms} ms` : esc(a.ms ? `lento: ${(a.ms / 1000).toFixed(1)} s` : a.status)}</small></div>`).join('');
  $('#vpsCard').className = 'panel vps h-' + h.brake.level;
  $('#vpsCard').innerHTML = `<div class="vps-head"><h3>Saúde da VPS</h3><span class="small muted">atualiza sozinho · ${h.at ? hhmm(h.at) : ''}</span></div>
    ${h.brake.reasons.length ? `<div class="brake">⏸ ${h.brake.reasons.map(esc).join('<br>⏸ ')}<br><small>Retoma sozinho quando normalizar.</small></div>` : '<div class="brake ok">✔ Tudo normal — o Cofre trabalha sem atrapalhar os apps.</div>'}
    <div class="vrows">${rows.join('')}</div>
    ${apps ? `<div class="apps"><span class="small muted">Apps de venda (checados a cada minuto):</span>${apps}</div>` : ''}`;
}

// Etapas do arsenal: bruto → separado → no Bunny → usado
function renderStages() {
  // contadores seguem a pasta/legenda/filtros abertos (vêm da própria lista); antes de carregar, o total geral
  const st = S.stageCounts || S.stats.stages || {};
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  $('#stages').innerHTML = STAGES.map(([k, label]) =>
    `<button class="stage ${S.stage === k ? 'on' : ''}" data-stage="${k}"><b>${k ? st[k] || 0 : total}</b><span>${label}</span></button>`).join('');
}
$('#stages').onclick = (e) => {
  const b = e.target.closest('[data-stage]');
  if (!b) return;
  S.stage = b.dataset.stage;
  renderStages();
  refreshLib(true).catch(fail);
};

// Legendas (automáticas + as suas) para filtrar
async function loadTags() {
  const tags = await api('/api/tags');
  const st = S.stats.tags;
  const status = st && st.status !== 'desligado' && (st.queue || st.status === 'carregando modelo')
    ? `<span class="chip">🏷 legendando… ${st.queue ? st.queue + ' na fila' : ''}</span>` : '';
  $('#tagChips').innerHTML = tags.length || status
    ? status + tags.slice(0, 40).map((t) => `<button class="chip-btn tag-${esc(t.group)} ${S.tagFilter.includes(t.tag) ? 'on' : ''}" data-tag="${esc(t.tag)}">${esc(t.tag)} <small>${t.n}</small></button>`).join('')
      + (S.tagFilter.length ? '<button class="chip-btn add" data-tag="__clear">limpar legendas ✕</button>' : '')
    : '';
}
$('#tagChips').onclick = (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  const t = b.dataset.tag;
  S.tagFilter = t === '__clear' ? [] : S.tagFilter.includes(t) ? S.tagFilter.filter((x) => x !== t) : [...S.tagFilter, t];
  refreshLib(true).catch(fail);
};

// ---------- Pastas ----------
async function loadFolders() {
  const { folders, none } = await api('/api/folders');
  S.folders = folders; S.none = none;
  const chips = [
    `<button class="chip-btn ${S.folder === '' ? 'on' : ''}" data-f="">Tudo</button>`,
    `<button class="chip-btn ${S.folder === 'none' ? 'on' : ''}" data-f="none">Sem pasta <small>${none}</small></button>`,
    ...folders.map((f) => `<button class="chip-btn ${f.persona ? 'persona' : ''} ${S.folder === f.id ? 'on' : ''}" data-f="${f.id}">${f.persona ? '👤' : '📁'} ${esc(f.name)} <small>${f.count}</small></button>`),
    `<button class="chip-btn add" data-f="__new">+ Nova pasta</button>`,
  ];
  $('#folders').innerHTML = chips.join('');
  const keep = $('#addFolder').value;
  $('#addFolder').innerHTML = `<option value="">Salvar em: sem pasta</option>`
    + folders.map((f) => `<option value="${f.id}">${f.persona ? '👤' : '📁'} ${esc(f.name)}</option>`).join('')
    + `<option value="__new">+ Nova pasta…</option>`;
  if (folders.some((f) => f.id === keep)) $('#addFolder').value = keep;
  const cur = folders.find((f) => f.id === S.folder);
  $('#folderHead').classList.toggle('hidden', !cur);
  $('#selRemoveFolder').classList.toggle('hidden', !cur);
  if (cur) {
    $('#fName').textContent = (cur.persona ? '👤 ' : '') + cur.name;
    $('#fZip').href = `/api/folders/${cur.id}/zip`;
    $('#fPersona').textContent = cur.persona ? `Persona${cur.appName ? ` · no app: ${cur.appName}` : ''}` : '';
    $('#fPersona').title = cur.persona ? 'O Cofre avisa se um arquivo daqui já for de outra persona.' : '';
    $('#fPersonaBtn').textContent = cur.persona ? '👤 Editar persona' : '👤 Marcar como persona';
  }
  // o chip aberto fica sempre à vista na linha que rola
  if (S.folder !== S.folderShown) {
    S.folderShown = S.folder;
    $('#folders .chip-btn.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    $('#fMore').classList.add('hidden');
  }
}
$('#fMoreBtn').onclick = () => $('#fMore').classList.toggle('hidden');

$('#fPersonaBtn').onclick = async () => {
  const cur = S.folders.find((f) => f.id === S.folder);
  if (!cur) return;
  if (cur.persona && !confirm('Essa pasta é uma persona. OK = editar o nome no app · Cancelar = deixar de ser persona')) {
    await api('/api/folders/' + cur.id, { method: 'PATCH', body: JSON.stringify({ persona: false }) }).catch(fail);
    return loadFolders();
  }
  const appName = prompt('Nome dela no app (opcional — ex.: o nome do chat):', cur.appName || '');
  if (appName === null) return;
  await api('/api/folders/' + cur.id, { method: 'PATCH', body: JSON.stringify({ persona: true, appName }) }).catch(fail);
  toast('Pasta marcada como persona 👤');
  loadFolders();
};

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
const FILTERS = { q: '#q', type: '#fType', orient: '#fOrient', dur: '#fDur', hd: '#fHd', site: '#fSite', used: '#fUsed', bunny: '#fBunnyF', fav: '#fFav', similar: '#fSimilar' };
function libQuery() {
  const p = new URLSearchParams();
  if (S.folder) p.set('folder', S.folder);
  if (S.tagFilter.length) p.set('tag', S.tagFilter.join(','));
  for (const [k, sel] of Object.entries(FILTERS)) { const v = $(sel).value.trim(); if (v) p.set(k, v); }
  return p.toString();
}

async function refreshLib(resetLimit) {
  if (resetLimit) { S.libLimit = 120; S.libSig = ''; }
  await Promise.all([loadFolders(), loadTags().catch(() => {})]);
  const { items: all, sites } = await api('/api/items?' + libQuery());
  const siteSel = $('#fSite');
  const curSite = siteSel.value;
  siteSel.innerHTML = '<option value="">Todos os sites</option>' + sites.map((s) => `<option>${esc(s)}</option>`).join('');
  siteSel.value = sites.includes(curSite) ? curSite : '';
  S.stageCounts = { bruto: 0, selecionado: 0, bunny: 0, usado: 0 };
  for (const i of all) S.stageCounts[i.stage] = (S.stageCounts[i.stage] || 0) + 1;
  renderStages();
  const items = S.stage ? all.filter((i) => i.stage === S.stage) : all;
  S.lib = items;
  const bytes = items.reduce((s, i) => s + (i.local ? i.size : 0), 0);
  const v = items.filter((i) => i.type === 'video').length;
  const plural = (n, a, b) => (n ? `${n} ${n === 1 ? a : b}` : '');
  $('#libCount').textContent = [`${items.length} arquivo${items.length === 1 ? '' : 's'}`, plural(v, 'vídeo', 'vídeos'), plural(items.length - v, 'foto', 'fotos'), bytes && fmtBytes(bytes)].filter(Boolean).join(' · ');
  const shown = items.slice(0, S.libLimit);
  const sig = JSON.stringify(shown.map((i) => [i.id, i.used, i.bunny?.status, i.local, i.folders.length, i.fav, i.stage, i.tags.join(), i.similarTo])) + S.selecting;
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
    ? `<img loading="lazy" src="${esc(img)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'${it.local ? '⚠ sem prévia' : '☁ no Bunny'}'}))">`
    : `<video muted preload="metadata" src="${esc(it.src)}#t=1"></video>`;
  const b = it.bunny?.status;
  const cloud = b === 'done' ? '<i title="no Bunny">☁</i>' : b === 'queued' || b === 'uploading' ? '<i class="up" title="enviando">⏫</i>' : b === 'error' ? '<i class="bad" title="erro no envio">⚠</i>' : '';
  const marks = [
    it.fav && '<i class="fav" title="favorito">★</i>',
    it.approved && !it.used && '<i class="ok" title="separado">✔</i>',
    it.used && `<i class="ok" title="já usei${it.usedIn?.length ? ' em ' + it.usedIn.map((u) => folderName(u.persona)).join(', ') : ''}">✓</i>`,
    it.similarTo && '<i class="bad" title="parecido com outro arquivo">≈</i>',
    it.clipOf && '<i title="corte">✂</i>',
  ].filter(Boolean).join('');
  const tags = it.tags?.length ? `<span class="ttags">${it.tags.slice(0, 3).map((t) => `<em>${esc(t)}</em>`).join('')}</span>` : '';
  return `<div class="tile" data-id="${esc(it.id)}">${inner}
    ${it.sprite ? `<span class="scrub" data-sprite="${esc(it.sprite)}"></span>` : ''}
    ${it.type === 'video' ? `<span class="play">▶</span>${it.duration ? `<span class="tag tl">${fmtDur(it.duration)}</span>` : ''}` : ''}
    <span class="tags tr">${marks}${cloud}</span>
    ${tags}
    <span class="check"></span>
    ${it.local ? `<a class="dl" href="${esc(it.src)}?dl=1" download title="Baixar">↓</a>` : ''}
  </div>`;
}
const folderName = (id) => S.folders.find((f) => f.id === id)?.name || '?';

// Prévia do vídeo longo: passar o mouse/dedo pela miniatura mostra 24 cenas do vídeo inteiro
const SPRITE = { cols: 6, rows: 4 };
function scrubAt(tile, clientX) {
  const s = tile.querySelector('.scrub');
  if (!s) return;
  const r = tile.getBoundingClientRect();
  const n = SPRITE.cols * SPRITE.rows;
  const i = Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
  if (!s.style.backgroundImage) s.style.backgroundImage = `url('${s.dataset.sprite}')`;
  s.style.backgroundPosition = `${((i % SPRITE.cols) / (SPRITE.cols - 1)) * 100}% ${(Math.floor(i / SPRITE.cols) / (SPRITE.rows - 1)) * 100}%`;
  s.style.setProperty('--p', `${((i + 1) / n) * 100}%`);
  tile.classList.add('scrubbing');
}
for (const grid of ['#libGrid', '#media']) {
  $(grid).addEventListener('pointermove', (e) => {
    const t = e.target.closest('.tile[data-id]');
    if (t && e.pointerType === 'mouse') scrubAt(t, e.clientX);
  });
  $(grid).addEventListener('pointerout', (e) => {
    const t = e.target.closest('.tile[data-id]');
    if (t && !t.contains(e.relatedTarget)) t.classList.remove('scrubbing');
  });
  // no celular: arrastar o dedo na HORIZONTAL sobre a miniatura (rolar a tela na vertical não dispara)
  let t0 = null;
  $(grid).addEventListener('touchstart', (e) => { t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, h: false }; }, { passive: true });
  $(grid).addEventListener('touchmove', (e) => {
    const t = e.target.closest('.tile[data-id]');
    if (!t0 || !t?.querySelector('.scrub')) return;
    const dx = Math.abs(e.touches[0].clientX - t0.x), dy = Math.abs(e.touches[0].clientY - t0.y);
    if (!t0.h && dx > 12 && dx > dy * 1.5) t0.h = true;
    if (t0.h) scrubAt(t, e.touches[0].clientX);
  }, { passive: true });
  $(grid).addEventListener('touchend', () => $$('.tile.scrubbing').forEach((t) => t.classList.remove('scrubbing')));
}

// ---------- Downloads ----------
async function loadSources() {
  const list = await api('/api/sources');
  const sig = JSON.stringify(list.map((a) => [a.id, a.status, a.done, a.total, a.progress, a.note, a.thumb]));
  $('#empty').classList.toggle('hidden', list.length > 0);
  if (sig === S.listSig) return;
  S.listSig = sig;
  $('#list').innerHTML = list.map(cardHtml).join('');
}
function cardHtml(a) {
  {
    const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
    // sem miniatura: ícone desenhado conforme o caso (erro / repetido / perfil / vazio)
    const icon = a.status === 'error' ? '⚠' : a.kind === 'erome-profile' ? '👤' : a.duplicates && !a.done ? '↺' : a.status === 'done' ? '☁' : '…';
    const thumb = a.thumb ? `style="background-image:url('${a.thumb}')"` : `data-icon="${icon}"`;
    const parts = [a.videos && `${a.videos} vídeo${a.videos > 1 ? 's' : ''}`, a.images && `${a.images} foto${a.images > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
    const badge = (STATUS[a.status] || a.status) + (a.status === 'downloading' && a.progress ? ` ${a.progress}` : '');
    const sub = a.status === 'error' ? `<div class="small err-msg">${esc(a.error || 'Falhou')}</div>`
      : `<div class="muted small">${esc(a.note || parts || (a.duplicates ? 'já estava na biblioteca' : '…'))}</div>`;
    const running = ['queued', 'downloading'].includes(a.status);
    return `<div class="card st-${a.status}" data-id="${a.id}">
      <div class="thumb ${a.thumb ? '' : 'nothumb'}" ${thumb}><span class="badge">${esc(badge)}</span><span class="site">${esc(a.site)}</span></div>
      <div class="info"><div class="t">${esc(a.title || prettyUrl(a.url))}</div>${sub}
        ${running ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div></div>`;
  }
}
// "https://site.com/user/videos/123?x=1" → "site.com › user/videos/123"
const prettyUrl = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? ' › ' + decodeURIComponent(x.pathname.slice(1)).replace(/\/$/, '') : ''); } catch { return u; } };
$('#list').onclick = (e) => { const c = e.target.closest('.card'); if (c) openAlbum(c.dataset.id); };

// ---------- Atividade ao vivo ----------
function liveLine(l) {
  if (!l) return 'preparando…';
  const bits = [l.file, l.bytes && (l.total ? `${fmtBytes(l.bytes)} de ${fmtBytes(l.total)}` : fmtBytes(l.bytes)),
    l.seconds && `${fmtDur(l.seconds)} de vídeo`, fmtSpeed(l.speed), l.eta != null && `falta ${fmtEta(l.eta)}`];
  return bits.filter(Boolean).map(esc).join(' · ');
}
async function loadActivity() {
  const a = await api('/api/activity');
  // aviso no navegador quando um download termina
  const nowActive = new Set(a.active.map((x) => x.id));
  for (const id of S.activeIds) {
    if (nowActive.has(id)) continue;
    const r = a.recent.find((x) => x.id === id);
    if (r) notify(r);
  }
  S.activeIds = nowActive;
  const t = a.tags || {};
  $('#actSum').innerHTML = [
    a.active.length ? `<b class="live-dot"></b> ${a.active.length} baixando` : '<span class="idle">Nada baixando agora — cole um link acima</span>',
    a.queued.length && `${a.queued.length} na fila`,
    (a.uploads.length || a.uploadQueue) && `☁ ${a.uploads.length + a.uploadQueue} indo pro Bunny`,
    t.queue && `🏷 ${t.queue} legendando`,
  ].filter(Boolean).join(' · ');
  $('#actLive').innerHTML = a.active.map((x) => {
    const l = x.live || {};
    const pct = l.pct ?? (x.total ? Math.round((x.done / x.total) * 100) : null);
    return `<div class="live card-live" data-id="${x.id}">
      <div class="live-top"><b>${esc(x.title || x.url)}</b><span class="muted small">${esc(x.site)}${l.startedAt ? ' · começou ' + hhmm(l.startedAt) : ''}</span></div>
      <div class="live-stage">${esc(l.stage || 'Começando')}${pct != null ? ` <b>${pct}%</b>` : ''}</div>
      <div class="bar ${pct == null ? 'indet' : ''}"><i style="width:${pct ?? 30}%"></i></div>
      <div class="small muted">${liveLine(l)}</div>
      ${x.log?.length ? `<div class="log small">${x.log.slice(-4).map((g) => `<div><span>${hhmm(g.t)}</span> ${esc(g.msg)}</div>`).join('')}</div>` : ''}
    </div>`;
  }).join('') + a.queued.map((x) => `<div class="live queued" data-id="${x.id}"><b>${esc(x.title || x.url)}</b> <span class="muted small">· na fila</span></div>`).join('');
  $('#actUploads').innerHTML = a.uploads.map((u) => `<div class="live up">
      <div class="live-top"><b>☁ ${esc(u.file)}</b><span class="muted small">→ ${esc(u.dir || '')}</span></div>
      <div class="bar"><i style="width:${u.pct || 0}%"></i></div>
      <div class="small muted">${[u.pct != null && u.pct + '%', u.total && `${fmtBytes(u.bytes)} de ${fmtBytes(u.total)}`, fmtSpeed(u.speed), u.eta != null && `falta ${fmtEta(u.eta)}`].filter(Boolean).join(' · ')}</div>
    </div>`).join('') + (a.uploadQueue ? `<div class="live queued">☁ ${a.uploadQueue} arquivo(s) esperando para subir</div>` : '');
  S.recent = Object.fromEntries(a.recent.map((r) => [r.id, r]));
  S.anyRunning = !!(a.active.length || a.queued.length || a.uploads.length || a.uploadQueue);
  syncNotifyBtn();
}
$('#actLive').onclick = (e) => { const c = e.target.closest('[data-id]'); if (c) openAlbum(c.dataset.id); };

function notify(r) {
  const ok = r.status !== 'error';
  const body = ok ? `${r.done} arquivo(s) prontos` : r.error || 'Falhou';
  toast(`${ok ? '✔' : '✖'} ${r.title || r.site}: ${body}`, !ok);
  if (window.Notification?.permission === 'granted') {
    try { new Notification(ok ? 'Download pronto' : 'Download falhou', { body: `${r.title || r.site} — ${body}`, icon: '/icons/icon-192.png', tag: r.id }); } catch { /* celular sem suporte */ }
  }
}
$('#notifyBtn').onclick = async () => {
  if (!window.Notification) return toast('Esse navegador não tem aviso. O aviso aparece aqui dentro do Cofre.', true);
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Pronto: aviso quando cada download terminar 🔔' : 'Aviso bloqueado no navegador.', p !== 'granted');
  syncNotifyBtn();
};
// o sino só aparece quando tem algo rodando (e o aviso ainda não foi liberado)
const syncNotifyBtn = () => $('#notifyBtn').classList.toggle('hidden', !S.anyRunning || !window.Notification || Notification.permission === 'granted');

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
    const body = { urls: text, folderId };
    if (S.dest === 'bunny') {
      if (!S.stats.bunny) throw new Error('Bunny não configurado no servidor (BUNNY_STORAGE_ZONE / KEY / CDN_URL).');
      body.bunnyFolder = $('#bunnyDir').value.trim() || 'geral';
      localStorage.setItem('cofre.bunnyDir', body.bunnyFolder); // lembra a última pasta
      body.keepLocal = $('#keepLocal').checked;
    }
    const r = await post('/api/sources', body);
    const bits = [r.added && `${r.added} na fila${body.bunnyFolder ? ` → ☁ ${body.bunnyFolder}` : ''}`, r.existed && `${r.existed} já salvo${r.existed > 1 ? 's' : ''}`, r.invalid && `${r.invalid} link${r.invalid > 1 ? 's' : ''} inválido${r.invalid > 1 ? 's' : ''}`].filter(Boolean);
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

// Destino: guardar no Cofre ou mandar direto pro Bunny (com pasta escolhida/criada aqui)
$('#destSeg').onclick = (e) => {
  const b = e.target.closest('[data-dest]');
  if (!b) return;
  if (b.dataset.dest === 'bunny' && !S.stats.bunny) return toast('Bunny não configurado no servidor (BUNNY_STORAGE_ZONE / KEY / CDN_URL).', true);
  S.dest = b.dataset.dest;
  $$('#destSeg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#bunnyDest').classList.toggle('hidden', S.dest !== 'bunny');
  $('#addFolder').classList.toggle('hidden', S.dest === 'bunny'); // um conceito de pasta por vez
  $('#addBtn').textContent = S.dest === 'bunny' ? '☁ Baixar e enviar' : 'Salvar';
  if (S.dest === 'bunny') loadBunnyFolders();
};
// Bunny sem configuração: o botão aparece desligado, explicando, em vez de deixar clicar e dar erro
function syncDest() {
  const b = $('#destSeg [data-dest="bunny"]');
  b.disabled = !S.stats.bunny;
  b.innerHTML = S.stats.bunny ? '☁ Direto pro Bunny' : '☁ Bunny <small>não configurado</small>';
}
// Celular: o campo de colar fica numa linha só; abre as opções ao tocar ou quando tem link
const syncAddOpen = () => $('#addForm').classList.toggle('open', document.activeElement?.closest?.('#addForm') != null || !!urlBox.value.trim());
$('#addForm').addEventListener('focusin', syncAddOpen);
$('#addForm').addEventListener('focusout', () => setTimeout(syncAddOpen, 150));
urlBox.addEventListener('input', syncAddOpen);
async function loadBunnyFolders() {
  try {
    const list = await api('/api/bunny/folders');
    $('#bunnyDirs').innerHTML = list.map((f) => `<option value="${esc(f.name)}">`).join('');
    if (!$('#bunnyDir').value) $('#bunnyDir').placeholder = list.length ? `Pasta no Bunny — ex.: ${list[0].name} (ou digite uma nova)` : 'Nome da pasta nova no Bunny';
  } catch (e) { $('#bunnyDir').placeholder = 'Pasta no Bunny (não consegui listar: ' + e.message + ')'; }
}
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
  }).join('') : '<div class="panel empty-state small muted">🔑 Nenhuma conta ainda. Só precisa para sites que pedem login.</div>';
  const s = S.stats;
  // essencial faltando = vermelho; opcional desligado = cinza
  const yes = (v, t, critical) => `<span class="${v ? 'ok' : critical ? 'err' : 'muted'}">${v ? '●' : '○'}</span> <span class="${!v && critical ? 'err' : ''}">${t}</span>`;
  $('#sysInfo').innerHTML = [
    yes(s.engines?.['yt-dlp'], `yt-dlp ${esc(s.engines?.['yt-dlp'] || 'não instalado — sem ele quase nenhum site baixa')}`, true),
    yes(s.engines?.['gallery-dl'], `gallery-dl ${esc(s.engines?.['gallery-dl'] || 'não instalado — fotos de Instagram/Reddit/X não baixam')}`, true),
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
  $('#aTitle').textContent = a.title || prettyUrl(a.url);
  const isProfile = a.kind === 'erome-profile';
  $('#aMeta').textContent = [a.site, a.author && '@' + a.author, a.total && `${a.done}/${a.total} arquivos`, a.bytes && fmtBytes(a.bytes), STATUS[a.status], a.status === 'downloading' && a.progress].filter(Boolean).join(' · ');
  $('#aOpen2').href = a.url;
  // sem arquivo nenhum: nada de "pôr numa pasta"/"selecionar"
  $('#aFolderBtn').classList.toggle('hidden', !a.done && !isProfile);
  $('#aSelBtn').classList.toggle('hidden', !a.done);
  if (isProfile) {
    // perfil: mostra os álbuns dele, clicáveis
    const kids = (await api('/api/sources')).filter((x) => x.parent === id);
    if (S.currentId !== id) return;
    const sig = 'p' + JSON.stringify(kids.map((k) => [k.id, k.status, k.done, k.thumb]));
    if (sig !== S.albumSig) {
      S.albumSig = sig;
      $('#media').innerHTML = kids.length ? `<div class="grid kids">${kids.map(cardHtml).join('')}</div>` : '';
    }
  }
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
  if (isProfile) return;
  const sig = JSON.stringify(a.items.map((i) => [i.id, i.status, i.used, i.bunny?.status, i.local])) + S.selecting;
  if (sig !== S.albumSig) {
    S.albumSig = sig;
    $('#media').innerHTML = a.items.map(tileHtml).join('');
  }
  syncSelectionMarks();
}

$('#media').addEventListener('click', (e) => { const c = e.target.closest('.card[data-id]'); if (c) openAlbum(c.dataset.id); });
$('#backBtn').onclick =() => (history.length > 1 ? history.back() : (showScreen('main'), refreshView()));
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
  $('#selMore').classList.add('hidden');
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

$('#selMoreBtn').onclick = () => $('#selMore').classList.toggle('hidden');
$('#selBar').onclick = async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const ids = [...S.selected];
  if (!ids.length) return toast('Selecione pelo menos um arquivo.', true);
  let act = b.dataset.act;
  $('#selMore').classList.add('hidden');
  // Usado / não usado num botão só: se todos já estão usados, desmarca
  if (act === 'usedToggle') act = ids.map(byId).every((i) => i?.used) ? 'unused' : 'used';
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
      const r = await pickFolder(`Mover ${ids.length} arquivo${ids.length === 1 ? '' : 's'} para…`, true);
      if (!r) return;
      const res = await runAction(r.mode, ids, { folderId: r.folderId });
      toast('Feito ✓');
      return warnConflicts(res);
    }
    if (act === 'approve' || act === 'fav') {
      const all = ids.map(byId).every((i) => (act === 'fav' ? i?.fav : i?.approved));
      const r = await runAction(all ? (act === 'fav' ? 'unfav' : 'unapprove') : act, ids);
      return toast(`${r.count} ${all ? 'desmarcado(s)' : act === 'fav' ? 'favoritado(s) ⭐' : 'separado(s) ✔'}`);
    }
    if (act === 'addTags') {
      const t = prompt(`Legenda para ${ids.length} arquivo(s) — separe por vírgula (ex.: loira, praia):`);
      if (!t?.trim()) return;
      const r = await runAction('addTags', ids, { tags: t.split(',') });
      return toast(`🏷 ${r.count} arquivo(s) legendados`);
    }
    if (act === 'removeFolder') { await runAction('removeFolder', ids, { folderId: S.folder }); return toast('Tirados da pasta'); }
    if (act === 'freeLocal') {
      const n = ids.map(byId).filter((i) => i?.bunny?.status === 'done' && i.local).length;
      if (!n) return toast('Só dá para liberar o que já está no Bunny.', true);
      if (!confirm(`Apagar do servidor ${n} arquivo(s) que já estão no Bunny? Eles continuam visíveis aqui, vindo do Bunny.`)) return;
    }
    if (act === 'delete' && !confirm(`Apagar ${ids.length} arquivo(s) do servidor? (o que estiver no Bunny continua lá)`)) return;
    const r = await runAction(act, ids, act === 'used' && S.folder ? { folderId: S.folder } : {});
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
        ? S.folders.map((f) => `<button class="btn ghost wide left" data-id="${f.id}">${f.persona ? '👤' : '📁'} ${esc(f.name)} <small class="muted">${f.count}</small></button>`).join('')
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
  document.body.classList.add('viewing'); // trava a rolagem da página por trás
}
function renderViewer() {
  const it = S.viewList[S.viewIdx];
  if (!it) return closeViewer();
  $('#vBody').innerHTML = it.type === 'image'
    ? `<img src="${esc(it.src)}" alt="">`
    : `<video src="${esc(it.src)}" controls autoplay playsinline></video>`;
  $('#vDl').href = it.local ? it.src + '?dl=1' : it.src;
  $('#vDl').toggleAttribute('download', it.local);
  setAct('#vUsed', it.used ? '↺' : '✓', it.used ? 'Usado' : 'Usado?', it.used);
  setAct('#vFav', it.fav ? '★' : '☆', 'Favorito', it.fav);
  $('#vFav').title = it.fav ? 'Tirar dos favoritos' : 'Favoritar';
  setAct('#vApprove', '✔', it.approved ? 'Separado' : 'Separar', it.approved);
  // legendas: clique no ✕ remove, "+" adiciona
  $('#vTags').innerHTML = (it.tags || []).map((t) => `<span class="vtag">${esc(t)}<button data-rm="${esc(t)}" title="tirar">✕</button></span>`).join('')
    + `<button id="vTagAdd" class="vtag add">+ legenda</button>`
    + (it.tagsEdited && it.autoTags?.length ? `<button id="vTagReset" class="vtag add" title="voltar para as automáticas">↺ automáticas</button>` : '')
    + (!it.tags?.length && !it.autoTags && it.type ? '<span class="small muted">legendas automáticas ainda não chegaram</span>' : '');
  // corte (só vídeo que está no servidor)
  const canClip = it.type === 'video' && it.local && it.duration > 2;
  $('#vClip').classList.toggle('hidden', !canClip);
  if (S.clipFor !== it.id) {
    S.clipFor = it.id; S.clipA = 0; S.clipB = null;
    $('#vClipAT').textContent = '0:00';
    $('#vClipBT').textContent = '—';
  }
  syncClipBtn();
  // parecido com outro arquivo
  $('#vSimilar').classList.toggle('hidden', !it.similarTo);
  const b = it.bunny?.status;
  setAct('#vBunny', b === 'queued' || b === 'uploading' ? '⏫' : '☁', b === 'done' ? 'No Bunny' : b === 'queued' || b === 'uploading' ? 'Enviando' : 'Bunny', b === 'done');
  $('#vBunny').disabled = b === 'queued' || b === 'uploading' || !it.local;
  $('#vLink').classList.toggle('hidden', !it.bunny?.url);
  const dims = it.width ? `${it.width}×${it.height}` : '';
  const usedIn = it.usedIn?.length ? 'usado em ' + it.usedIn.map((u) => folderName(u.persona)).join(', ') : '';
  $('#vInfo').textContent = [`${S.viewIdx + 1}/${S.viewList.length}`, it.albumTitle, dims, it.duration && fmtDur(it.duration), fmtBytes(it.size), usedIn, it.bunny?.error && '⚠ ' + it.bunny.error].filter(Boolean).join(' · ');
  $('#vPrev').classList.toggle('hidden', S.viewIdx === 0);
  $('#vNext').classList.toggle('hidden', S.viewIdx >= S.viewList.length - 1);
}
// botão de ícone + rótulo pequeno embaixo (cabe no celular sem cortar)
function setAct(sel, icon, label, on) {
  const b = $(sel);
  b.querySelector('i').textContent = icon;
  b.querySelector('span').textContent = label;
  b.classList.toggle('on', !!on);
}
function closeViewer() { $('#vBody').innerHTML = ''; $('#viewer').classList.add('hidden'); document.body.classList.remove('viewing'); }
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

const curIt = () => S.viewList[S.viewIdx];
async function viewAction(action, extra = {}) {
  const it = curIt();
  const r = await post('/api/items/action', { ids: [it.id], action, ...extra });
  // atualiza o item na tela sem perder a posição do visualizador
  const fresh = (await api('/api/items?source=' + encodeURIComponent(it.album))).items.find((i) => i.id === it.id);
  if (fresh) Object.assign(it, fresh);
  renderViewerKeepMedia();
  refreshView().catch(() => {});
  return r;
}
// re-renderiza só os botões/legendas — o vídeo continua tocando de onde estava
function renderViewerKeepMedia() {
  const body = $('#vBody').firstElementChild;
  const t = body?.currentTime;
  const keep = body && body.getAttribute('src') === curIt()?.src ? body : null;
  renderViewer();
  if (keep) { $('#vBody').replaceChildren(keep); if (t != null) keep.currentTime = t; }
}
$('#vFav').onclick = () => viewAction(curIt().fav ? 'unfav' : 'fav').catch(fail);
$('#vApprove').onclick = () => viewAction(curIt().approved ? 'unapprove' : 'approve').catch(fail);
$('#vTags').onclick = async (e) => {
  const it = curIt();
  const rm = e.target.closest('[data-rm]');
  try {
    if (rm) return await viewAction('setTags', { tags: it.tags.filter((t) => t !== rm.dataset.rm) });
    if (e.target.id === 'vTagReset') return await viewAction('resetTags');
    if (e.target.id === 'vTagAdd') {
      const t = prompt('Nova legenda (separe por vírgula):');
      if (t?.trim()) await viewAction('addTags', { tags: t.split(',') });
    }
  } catch (err) { fail(err); }
};
// Corte: marca início/fim no ponto em que o vídeo está
const vid = () => $('#vBody video');
// "Cortar trecho" só acende (vermelho) quando início e fim estão marcados — um único botão primário por vez
function syncClipBtn() {
  const ready = S.clipB != null && S.clipB > S.clipA + 0.5;
  $('#vClipGo').classList.toggle('primary', ready);
  $('#vClipGo').classList.toggle('ghost', !ready);
}
$('#vClipA').onclick = () => { const v = vid(); if (!v) return; S.clipA = v.currentTime; $('#vClipAT').textContent = fmtDur(S.clipA); syncClipBtn(); };
$('#vClipB').onclick = () => { const v = vid(); if (!v) return; S.clipB = v.currentTime; $('#vClipBT').textContent = fmtDur(S.clipB); syncClipBtn(); };
$('#vClipGo').onclick = async () => {
  const it = curIt();
  const end = S.clipB ?? vid()?.currentTime;
  if (!(end > S.clipA + 0.5)) return toast('Dê play, toque em "Início" no começo do trecho e em "Fim" no final.', true);
  try {
    await post('/api/items/clip', { id: it.id, start: S.clipA, end });
    toast(`✂ Cortando ${fmtDur(S.clipA)}–${fmtDur(end)}… o trecho aparece na biblioteca em instantes`);
    S.clipA = 0; S.clipB = null; $('#vClipAT').textContent = '0:00'; $('#vClipBT').textContent = '—'; syncClipBtn();
  } catch (e) { fail(e); }
};
// Parecidos
$('#vSimSee').onclick = async () => {
  const it = curIt();
  const [album] = it.similarTo.split('/');
  const other = (await api('/api/items?source=' + encodeURIComponent(album)).catch(() => ({ items: [] }))).items.find((i) => i.id === it.similarTo);
  if (!other) return toast('O outro arquivo não está mais na biblioteca.', true);
  openViewer([it, other], 1);
};
$('#vSimKeep').onclick = () => viewAction('ignoreSimilar').then(() => toast('Ok, os dois ficam')).catch(fail);
$('#vSimDel').onclick = async () => {
  if (!confirm('Apagar este arquivo (o outro parecido fica)?')) return;
  const it = curIt();
  try {
    await post('/api/items/action', { ids: [it.id], action: 'delete' });
    S.viewList.splice(S.viewIdx, 1);
    if (S.viewIdx >= S.viewList.length) S.viewIdx = S.viewList.length - 1;
    renderViewer();
    refreshView().catch(() => {});
    toast('Apagado');
  } catch (e) { fail(e); }
};

// ---------- Atualização automática enquanto algo baixa/envia ----------
async function refreshView() {
  if (S.currentId) return loadAlbum(S.currentId);
  if (S.tab === 'dl') { if (S.stats.health) renderVps(S.stats.health, S.stats); return Promise.all([loadActivity(), loadSources()]); }
  if (S.tab === 'acc') return loadAccounts();
  return refreshLib();
}
let wasBusy = false;
async function tick() {
  try {
    if (!$('#login').classList.contains('hidden')) return;
    const s = await loadStats();
    const watching = S.tab === 'dl' && !S.currentId;
    // fora da aba Atividade também acompanha, para avisar quando terminar
    if (!watching && (s.busy || S.activeIds.size)) await loadActivity().catch(() => {});
    if (s.busy || wasBusy || watching) await refreshView();
    wasBusy = s.busy;
  } catch { /* sem rede: tenta de novo */ }
  finally { setTimeout(tick, document.hidden ? 15000 : S.tab === 'dl' ? 1500 : 3000); }
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
  syncNotifyBtn();
  syncDest();
  // padrão = Direto pro Bunny: o arsenal cresce no Bunny, não no disco que os apps de venda usam
  $('#bunnyDir').value = localStorage.getItem('cofre.bunnyDir') || '';
  if (S.stats.bunny && S.dest !== 'bunny') $('#destSeg [data-dest="bunny"]').click();
  syncAddOpen();
  const shared = new URLSearchParams(location.search).get('add');
  if (location.hash.startsWith('#a/')) return openAlbum(location.hash.slice(3));
  showScreen('main');
  await refreshLib(true).catch(fail);
  if (shared) { history.replaceState(null, '', '/'); addUrls(shared); }
}
start().finally(() => setTimeout(tick, 3000));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
