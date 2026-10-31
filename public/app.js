const $ = (s) => document.querySelector(s);
const show = (id) => ['login', 'main', 'album'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (b) => !b ? '0 MB' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const STATUS = { queued: 'Na fila', downloading: 'Baixando', done: 'Pronto', partial: 'Incompleto', error: 'Erro' };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  if (res.status === 401 && path !== '/api/login') { show('login'); throw new Error('login'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro ' + res.status);
  return data;
}

// ---------- Login ----------
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ pin: $('#pin').value }) });
    $('#pin').value = '';
    start();
  } catch (err) { $('#loginErr').textContent = err.message; }
};

// ---------- Lista ----------
let albums = [];
let pollTimer = null;
let currentId = null;

async function loadList() {
  albums = await api('/api/albums');
  const busy = albums.some((a) => ['queued', 'downloading'].includes(a.status));
  const total = albums.reduce((s, a) => s + a.bytes, 0);
  $('#stats').textContent = albums.length ? `${albums.length} álbu${albums.length > 1 ? 'ns' : 'm'} · ${fmtBytes(total)}` : '';
  $('#empty').classList.toggle('hidden', albums.length > 0);
  $('#list').innerHTML = albums.map((a) => {
    const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
    const thumb = a.thumb ? `style="background-image:url('/files/${a.id}/${encodeURIComponent(a.thumb)}')"` : '';
    const parts = [a.videos && `${a.videos} vídeo${a.videos > 1 ? 's' : ''}`, a.images && `${a.images} foto${a.images > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
    return `<div class="card st-${a.status}" data-id="${a.id}">
      <div class="thumb" ${thumb}><span class="badge">${STATUS[a.status] || a.status}${a.status === 'downloading' ? ` ${a.done}/${a.total}` : ''}</span></div>
      <div class="info"><div class="t">${esc(a.title || a.id)}</div>
        <div class="muted small">${esc(parts || '…')}</div>
        <div class="bar"><i style="width:${a.status === 'done' ? 100 : pct}%"></i></div></div></div>`;
  }).join('');
  schedulePoll(busy);
}

$('#list').onclick = (e) => {
  const card = e.target.closest('.card');
  if (card) openAlbum(card.dataset.id);
};

function schedulePoll(busy) {
  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(() => (currentId ? loadAlbum(currentId) : loadList()).catch(() => {}), 2000);
}

// ---------- Adicionar ----------
async function addUrl(url) {
  url = (url || '').trim();
  if (!url) return;
  $('#addBtn').disabled = true;
  $('#addMsg').className = 'small muted';
  $('#addMsg').textContent = 'Enviando…';
  try {
    const a = await api('/api/albums', { method: 'POST', body: JSON.stringify({ url }) });
    $('#addMsg').className = 'small';
    $('#addMsg').style.color = 'var(--ok)';
    $('#addMsg').textContent = a.existed ? 'Esse álbum já está salvo.' : 'Na fila! Pode colar o próximo.';
    $('#url').value = '';
    await loadList();
  } catch (err) {
    if (err.message === 'login') return;
    $('#addMsg').className = 'small err';
    $('#addMsg').style.color = '';
    $('#addMsg').textContent = err.message;
  } finally { $('#addBtn').disabled = false; }
}
$('#addForm').onsubmit = (e) => { e.preventDefault(); addUrl($('#url').value); };
$('#pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    $('#url').value = t;
    if (/erome\.com\/a\//i.test(t)) addUrl(t);
  } catch { $('#url').focus(); $('#addMsg').textContent = 'Toque e segure no campo para colar.'; }
};

// ---------- Álbum ----------
async function openAlbum(id) {
  currentId = id;
  $('#aMenu').classList.add('hidden');
  $('#media').innerHTML = '';
  show('album');
  history.pushState({ id }, '', '#a/' + id);
  await loadAlbum(id);
}

async function loadAlbum(id) {
  const a = await api('/api/albums/' + id);
  if (currentId !== id) return;
  $('#aTitle').textContent = a.title || a.id;
  $('#aMeta').textContent = [a.author && '@' + a.author, `${a.done}/${a.total} arquivos`, fmtBytes(a.bytes), STATUS[a.status]].filter(Boolean).join(' · ');
  $('#aErr').textContent = a.error || '';
  $('#zipBtn').href = `/api/albums/${id}/zip`;
  $('#openOrig').href = a.url;
  $('#retryBtn').classList.toggle('hidden', !['error', 'partial'].includes(a.status));

  $('#media').innerHTML = a.items.map((it, i) => {
    const src = `/files/${id}/${encodeURIComponent(it.file)}`;
    if (it.status !== 'done') {
      const label = it.status === 'error' ? '⚠ falhou' : it.status === 'downloading' ? 'baixando…' : 'na fila';
      return `<div class="tile"><div class="state">${it.type === 'image' ? 'foto' : 'vídeo'}<br>${label}</div></div>`;
    }
    const inner = it.type === 'image'
      ? `<img loading="lazy" src="${src}" alt="">`
      : it.thumb ? `<img loading="lazy" src="/files/${id}/${encodeURIComponent(it.thumb)}" alt=""><span class="play">▶</span>`
                 : `<video muted preload="metadata" src="${src}#t=1"></video><span class="play">▶</span>`;
    return `<div class="tile" data-i="${i}">${inner}<a class="dl" href="${src}?dl=1" download>↓</a></div>`;
  }).join('');
  $('#media').onclick = (e) => {
    if (e.target.closest('.dl')) return;
    const t = e.target.closest('.tile[data-i]');
    if (t) openViewer(id, a.items[+t.dataset.i]);
  };
  schedulePoll(['queued', 'downloading'].includes(a.status));
}

function openViewer(id, it) {
  const src = `/files/${id}/${encodeURIComponent(it.file)}`;
  $('#vBody').innerHTML = it.type === 'image' ? `<img src="${src}" alt="">` : `<video src="${src}" controls autoplay playsinline></video>`;
  $('#vDl').href = src + '?dl=1';
  $('#viewer').classList.remove('hidden');
}
$('#vClose').onclick = () => { $('#vBody').innerHTML = ''; $('#viewer').classList.add('hidden'); };

$('#backBtn').onclick = () => history.back();
window.onpopstate = () => {
  if (location.hash.startsWith('#a/')) openAlbum(location.hash.slice(3));
  else { currentId = null; show('main'); loadList().catch(() => {}); }
};
$('#moreBtn').onclick = () => $('#aMenu').classList.toggle('hidden');
$('#retryBtn').onclick = async () => { await api(`/api/albums/${currentId}/retry`, { method: 'POST' }); loadAlbum(currentId); };
$('#delBtn').onclick = async () => {
  if (!confirm('Apagar esse álbum e todos os arquivos do servidor?')) return;
  await api('/api/albums/' + currentId, { method: 'DELETE' });
  history.back();
};

// ---------- Início ----------
async function start() {
  const { authed } = await api('/api/me');
  if (!authed) return show('login');
  const params = new URLSearchParams(location.search);
  const shared = params.get('add');
  if (location.hash.startsWith('#a/')) return openAlbum(location.hash.slice(3));
  show('main');
  await loadList();
  if (shared) { history.replaceState(null, '', '/'); addUrl(shared); }
}
start();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
