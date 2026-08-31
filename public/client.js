/* global io, I18N, SERVER_MSG_EN, SERVER_MSG_EN_RX */
'use strict';

// ---------- util ----------
const $ = (sel) => document.querySelector(sel);
const SESSION_KEY = 'perudo.session';
const LANG_KEY = 'perudo.lang';
const REVEAL_SECONDS = 20;

// ---------- lingua (per-dispositivo) ----------
let LANG = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'it';
/** Traduzione con placeholder {k}. Fallback: italiano, poi la chiave stessa. */
function t(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) != null ? I18N[LANG][key] : I18N.it[key];
  if (s == null) s = key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
  }
  return s;
}
/** Messaggi del server (italiani) → lingua corrente; fallback: originale. */
function tServer(msg) {
  if (LANG === 'it' || !msg) return msg;
  if (SERVER_MSG_EN.has(msg)) return SERVER_MSG_EN.get(msg);
  for (const [rx, tpl] of SERVER_MSG_EN_RX) {
    const m = msg.match(rx);
    if (m) return tpl.split('{n}').join(m[1]);
  }
  return msg;
}
/** Applica le traduzioni ai testi statici marcati con data-i18n / data-i18n-html / data-i18n-ph. */
function applyI18nStatic() {
  document.documentElement.lang = LANG;
  document.title = t('docTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

// Posizioni dei pallini su una griglia 3x3 (indici 0..8, riga per riga).
const PIPS = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function pipsHtml(v) {
  const set = new Set(PIPS[v] || []);
  let s = '';
  for (let i = 0; i < 9; i += 1) {
    s += `<span class="pip${set.has(i) ? ' on' : ''}"></span>`;
  }
  return s;
}
/** HTML di un dado realistico. size: die-lg | die-md | die-sm | die-xs.
 *  Se `wild` è true e il valore è 1, l'1 è reso come jolly (pallino rosso grande). */
function dieEl(v, size, extra, wild) {
  const cls = [size || 'die-md', extra, wild && v === 1 ? 'wild' : '']
    .filter(Boolean)
    .join(' ');
  return `<span class="die ${cls}" data-val="${v}">${pipsHtml(v)}</span>`;
}
function setDieFace(el, v) {
  el.dataset.val = v;
  el.innerHTML = pipsHtml(v);
}

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  timeout: 20000,
});

const state = {
  me: null, // { code, playerId, isHost, token }
  room: null,
  myDice: [],
  qty: 1,
  face: 1,
  rolledRound: null, // roundNumber per cui ho gia' "lanciato" localmente
  animating: false,
  revealKey: null,
  autoKey: null, // (round|dichiarazione) per cui ho già preselezionato il rilancio
  chatOpen: false,
  unread: 0,
  mode: 'standard', // modalità scelta in creazione: standard | jolly | calza
  calzaRule: 'official', // versione della Calza scelta in creazione: official | house
};

// ---------- schermate ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = tServer(msg); // i messaggi del server arrivano in italiano
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}
/** Colore stabile derivato dall'id del giocatore (per la chat). */
function hue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function saveSession() {
  if (state.me) {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ code: state.me.code, token: state.me.token })
    );
  }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function shareLink(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

// ---------- REGOLE (viewer stile "storie") ----------
const MODE_NAMES = { standard: 'Standard', jolly: 'Jolly', calza: 'Calza' };

/** Dado inclinato con ingresso animato a cascata (i = indice per il ritardo). */
function rsTilt(v, deg, i, size, extra, wild) {
  return `<span class="rs-tilt" style="--r:${deg}deg;--i:${i}">${dieEl(v, size || 'die-md', extra, wild)}</span>`;
}
/** Chip-dichiarazione: quantità × dado, con nota opzionale. */
function rsChip(qty, face, cls, note, i, wild) {
  return `<span class="rs-chip ${cls || ''}" style="--i:${i || 0}">${qty} × ${dieEl(face, 'die-sm', '', wild)}${
    note ? `<span class="rs-note">${note}</span>` : ''
  }</span>`;
}
/** Giocatore al tavolo: nome intero + dadi nascosti (punti interrogativi). */
function rsSeat(name, n) {
  const dice = Array.from({ length: n }, () => '<span class="rs-mystery">?</span>').join('');
  return `<div class="rs-seat"><span class="rs-name">${name}</span><span class="hidden-dice">${dice}</span></div>`;
}
/** Riga di rivelazione: nome intero + i suoi dadi, con i dadi che contano in oro
 *  (il valore dichiarato e, nei round jolly, anche gli 1). */
function rsRRow(name, dice, face, i, wild) {
  return `<div class="rs-rrow" style="--i:${i}"><span class="rs-rname">${name}</span><span class="rs-rdice">${dice
    .map((v) => dieEl(v, 'die-sm', v === face || (wild && v === 1) ? 'match' : '', wild))
    .join('')}</span></div>`;
}

/** Slide per modalità, costruite nella lingua corrente:
 *  { step, t (titolo), d (testo), fig() (HTML figura), foot()?, cta? }. */
function getRules() {
  const goldBtn =
    'background:linear-gradient(90deg,var(--gold),#ffb703);color:#3a2b00;box-shadow:0 0 26px rgba(255,183,3,.4)';
  return {
    standard: [
      {
        step: t('rs1s'),
        t: t('rs1t'),
        d: t('rs1d'),
        fig: () => `
        <div class="rs-fan">${[3, 6, 2, 5, 4]
          .map((v, i) => rsTilt(v, [-16, -8, 0, 8, 16][i], i))
          .join('')}</div>
        <span class="rs-pill">${t('rs1pill')}</span>`,
      },
      {
        step: t('rs2s'),
        t: t('rs2t'),
        d: t('rs2d'),
        fig: () => `
        <div class="rs-table">${rsSeat('Luca', 3)}${rsSeat('Anna', 3)}</div>
        <div class="rs-call">
          <span class="rs-minelabel">${t('r_call')}</span>
          <span class="rs-bubble"><span class="rs-bsay">${t('r_say')}</span> 3 × ${dieEl(3, 'die-md')}<span class="rs-bsay">${t('r_sayEnd')}</span></span>
        </div>
        <div class="rs-mine">
          <div class="rs-fan">${[3, 5, 3].map((v, i) => rsTilt(v, 0, i, 'die-sm')).join('')}</div>
          <span class="rs-minelabel">${t('r_mine')}</span>
        </div>`,
      },
      {
        step: t('rs3s'),
        t: t('rs3t'),
        d: t('rs3d'),
        fig: () => `
        <div class="rs-ladder">
          ${rsChip(4, 3, 'base', '', 0)}
          ${rsChip(5, 2, 'ok', t('rs3n1'), 1)}
          <span class="rs-or">${t('rs3or')}</span>
          ${rsChip(4, 5, 'ok', t('rs3n2'), 2)}
        </div>`,
      },
      {
        step: t('rs4s'),
        t: t('rs4t'),
        d: t('rs4d'),
        fig: () => `
        <span class="rs-doubt">${t('rs4btn')}</span>
        <div class="rs-rrows">
          ${rsRRow(t('r_you'), [3, 5, 3], 3, 0)}
          ${rsRRow('Luca', [2, 3, 6], 3, 1)}
          ${rsRRow('Anna', [4, 1, 3], 3, 2)}
        </div>
        <span class="rs-pill">${t('rs4found', { d: dieEl(3, 'die-xs', 'inline') })}</span>`,
      },
      {
        step: t('rs5s'),
        t: t('rs5t'),
        d: '',
        fig: () => `
        <div class="rs-verdicts">
          <div class="rs-verdict good" style="--i:0"><span class="rs-ico">✅</span><span>${t('rs5v1')}</span></div>
          <div class="rs-verdict bad" style="--i:1"><span class="rs-ico">🔥</span><span>${t('rs5v2')}</span></div>
        </div>
        <div class="rs-minis">
          <span class="rs-pill">${t('rs5p1')}</span>
          <span class="rs-pill">${t('rs5p2')}</span>
        </div>`,
        cta: t('ctaPlay'),
      },
    ],
    jolly: [
      {
        step: t('rj1s'),
        t: t('rj1t'),
        d: t('rj1d'),
        fig: () => `
        <div class="rs-fan">${rsTilt(1, -10, 0, 'die-lg', '', true)}${rsTilt(3, 10, 1, 'die-lg')}</div>
        <div class="rs-minis">
          <span class="rs-pill">${t('rj1p1', { d: dieEl(1, 'die-xs', 'inline', true) })}</span>
          <span class="rs-pill">${t('rj1p2')}</span>
        </div>`,
      },
      {
        step: t('rj2s'),
        t: t('rj2t'),
        d: t('rj2d'),
        fig: () => `
        <span class="rs-pill">${t('rj2bid', { d: dieEl(3, 'die-xs', 'inline') })}</span>
        <div class="rs-rrows">
          ${rsRRow(t('r_you'), [3, 5, 1], 3, 0, true)}
          ${rsRRow('Luca', [2, 3, 6], 3, 1, true)}
          ${rsRRow('Anna', [4, 1, 3], 3, 2, true)}
        </div>
        <span class="rs-pill">${t('rj2found', {
          d1: dieEl(1, 'die-xs', 'inline', true),
          d3: dieEl(3, 'die-xs', 'inline'),
        })}</span>`,
      },
      {
        step: t('rj3s'),
        t: t('rj3t'),
        d: t('rj3d'),
        fig: () => `
        <div class="rs-ladder">
          ${rsChip(4, 3, 'base', '', 0)}
          ${rsChip(2, 1, 'ok', t('rj3n1'), 1, true)}
          ${rsChip(5, 3, 'ok', t('rj3n2'), 2)}
        </div>`,
      },
      {
        step: t('rj4s'),
        t: t('rj4t'),
        d: t('rj4d'),
        fig: () => `
        <span class="rs-doubt" style="${goldBtn}">🎲 Palifico!</span>`,
        foot: () => `<span class="rs-pill">${t('rj4foot')}</span>`,
      },
      {
        step: t('rj5s'),
        t: t('rj5t'),
        d: '',
        fig: () => `
        <div class="rs-verdicts">
          <div class="rs-verdict bad" style="--i:0"><span class="rs-ico">${dieEl(1, 'die-xs')}</span><span>${t('rj5v1')}</span></div>
          <div class="rs-verdict good" style="--i:1"><span class="rs-ico">🔁</span><span>${t('rj5v2')}</span></div>
        </div>`,
        cta: t('ctaPlay'),
      },
    ],
    calza: [
      {
        step: t('rc1s'),
        t: t('rc1t'),
        d: t('rc1d'),
        fig: () => `
        <span class="rs-doubt" style="${goldBtn}">✋ Calza!</span>`,
      },
      {
        step: t('rc2s'),
        t: t('rc2t'),
        d: t('rc2d'),
        fig: () => `
        <div class="rs-call">
          <span class="rs-minelabel">${t('rc2lbl1')}</span>
          <span class="rs-bubble">3 × ${dieEl(5, 'die-md')}</span>
        </div>
        <div class="rs-call">
          <span class="rs-minelabel">${t('rc2lbl2')}</span>
          <span class="rs-doubt" style="${goldBtn};animation:none">✋ Calza!</span>
        </div>`,
      },
      {
        step: t('rc3s'),
        t: t('rc3t'),
        d: '',
        fig: () => `
        <div class="rs-verdicts">
          <div class="rs-verdict good" style="--i:0"><span class="rs-ico">🎁</span><span>${t('rc3v1')}</span></div>
          <div class="rs-verdict bad" style="--i:1"><span class="rs-ico">🔥</span><span>${t('rc3v2')}</span></div>
        </div>`,
        foot: () => `<span class="rs-pill">${t('rc3foot')}</span>`,
      },
      {
        step: t('rc4s'),
        t: t('rc4t'),
        d: '',
        fig: () => `
        <div class="rs-verdicts">
          <div class="rs-verdict good" style="--i:0"><span class="rs-ico">${dieEl(1, 'die-xs', '', true)}</span><span>${t('rc4v1')}</span></div>
          <div class="rs-verdict bad" style="--i:1"><span class="rs-ico">🚫</span><span>${t('rc4v2')}</span></div>
        </div>`,
      },
      {
        step: t('rc5s'),
        t: t('rc5t'),
        d: '',
        fig: () => `
        <div class="rs-verdicts">
          <div class="rs-verdict" style="--i:0"><span class="rs-ico">🏛️</span><span>${t('rc5v1')}</span></div>
          <div class="rs-verdict good" style="--i:1"><span class="rs-ico">🍻</span><span>${t('rc5v2')}</span></div>
        </div>`,
        foot: () => `<span class="rs-pill">${t('rc5foot')}</span>`,
        cta: t('ctaPlay'),
      },
    ],
  };
}

const rstory = {
  el: $('#rules-story'),
  frame: $('#rstory-frame'),
  stage: $('#rstory-stage'),
  dots: $('#rstory-dots'),
  modeEl: $('#rstory-mode'),
  hint: $('#rstory-hint'),
  slides: [],
  i: 0,
  open: false,
  hinted: false, // il suggerimento "tocca per continuare" sparisce al primo tap
};

function rulesShow(i, dir) {
  const s = rstory.slides[i];
  rstory.i = i;
  rstory.stage.innerHTML = `
    <div class="rslide ${dir === 'back' ? 'back' : ''}">
      <p class="rs-step">${s.step}</p>
      <h3 class="rs-title">${s.t}</h3>
      <div class="rs-fig">${s.fig()}</div>
      ${s.d ? `<p class="rs-text">${s.d}</p>` : ''}
      ${s.foot ? `<div class="rs-minis">${s.foot()}</div>` : ''}
      ${s.cta ? `<button type="button" class="primary rs-cta" id="rstory-cta">${s.cta}</button>` : ''}
    </div>`;
  const cta = $('#rstory-cta');
  if (cta) cta.addEventListener('click', rulesClose);
  rstory.dots.querySelectorAll('i').forEach((dot, k) => {
    dot.classList.toggle('done', k < i);
    dot.classList.toggle('cur', k === i);
  });
  // freccette laterali: solo verso slide che esistono
  $('#rstory-arrow-left').classList.toggle('off', i === 0);
  $('#rstory-arrow-right').classList.toggle('off', i >= rstory.slides.length - 1);
}

function rulesOpen(mode) {
  const all = getRules();
  rstory.slides = all[mode] || all.standard;
  rstory.i = 0;
  rstory.open = true;
  rstory.hinted = false;
  rstory.modeEl.textContent = t('rulesChip', { m: MODE_NAMES[mode] || mode });
  rstory.dots.innerHTML = rstory.slides.map(() => '<i></i>').join('');
  document.querySelector('.rstory-deco-a').innerHTML = dieEl(5, 'die-lg');
  document.querySelector('.rstory-deco-b').innerHTML = dieEl(2, 'die-lg');
  rstory.hint.classList.toggle('gone', rstory.slides.length < 2);
  rulesShow(0, 'fwd');
  rstory.el.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function rulesClose() {
  rstory.open = false;
  rstory.el.classList.add('hidden');
  document.body.style.overflow = '';
}
function rulesHintOff() {
  if (!rstory.hinted) {
    rstory.hinted = true;
    rstory.hint.classList.add('gone');
  }
}
function rulesNext() {
  if (rstory.i >= rstory.slides.length - 1) return rulesClose();
  rulesHintOff();
  rulesShow(rstory.i + 1, 'fwd');
}
function rulesPrev() {
  if (rstory.i > 0) rulesShow(rstory.i - 1, 'back');
}

$('#rstory-next').addEventListener('click', rulesNext);
$('#rstory-prev').addEventListener('click', rulesPrev);
$('#rstory-close').addEventListener('click', rulesClose);
// tap sullo sfondo fuori dalla card = chiudi
rstory.el.addEventListener('click', (e) => {
  if (e.target === rstory.el) rulesClose();
});
document.addEventListener('keydown', (e) => {
  if (!rstory.open) return;
  if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault();
    rulesNext();
  } else if (e.key === 'ArrowLeft') {
    rulesPrev();
  } else if (e.key === 'Escape') {
    rulesClose();
  }
});
// swipe orizzontale = avanti/indietro, swipe verso il basso = chiudi
let rTouch = null;
rstory.frame.addEventListener(
  'touchstart',
  (e) => {
    rTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  },
  { passive: true }
);
rstory.frame.addEventListener('touchend', (e) => {
  if (!rTouch) return;
  const dx = e.changedTouches[0].clientX - rTouch.x;
  const dy = e.changedTouches[0].clientY - rTouch.y;
  rTouch = null;
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0) rulesNext();
    else rulesPrev();
  } else if (dy > 70 && Math.abs(dy) > Math.abs(dx)) {
    rulesClose();
  }
});

// ---------- selettore lingua (bandiere in alto) ----------
function setLang(lang) {
  LANG = lang === 'en' ? 'en' : 'it';
  localStorage.setItem(LANG_KEY, LANG);
  document.querySelectorAll('#lang-switch .lang-opt').forEach((b) =>
    b.classList.toggle('selected', b.dataset.lang === LANG)
  );
  applyI18nStatic();
  // Ri-renderizza le viste dinamiche già a schermo.
  if (state.room) {
    renderLobby(state.room);
    if (state.room.status !== 'lobby') renderGame(state.room);
  }
}
document.querySelectorAll('#lang-switch .lang-opt').forEach((btn) => {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
});
setLang(LANG); // applica la lingua salvata all'avvio

// ---------- HOME ----------
// Selettore modalità (segmented). Aggiorna state.mode e apre le regole della modalità.
document.querySelectorAll('#mode-picker .mode-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll('#mode-picker .mode-opt').forEach((b) =>
      b.classList.toggle('selected', b === btn)
    );
    $('#calza-rule').classList.toggle('hidden', state.mode !== 'calza');
    rulesOpen(state.mode);
  });
});

// Versione della Calza (Official / House), scelta dall'host.
document.querySelectorAll('#calza-rule .cr-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.calzaRule = btn.dataset.rule;
    document.querySelectorAll('#calza-rule .cr-opt').forEach((b) =>
      b.classList.toggle('selected', b === btn)
    );
  });
});

$('#btn-create').addEventListener('click', () => {
  const hostName = $('#host-name').value;
  const dicePerPlayer = $('#dice-count').value;
  if (!hostName.trim()) return toast(t('toastName'));
  socket.emit(
    'createRoom',
    { hostName, dicePerPlayer, mode: state.mode, calzaRule: state.calzaRule },
    (res) => {
    if (!res.ok) return toast(res.error);
    state.me = { code: res.code, playerId: res.playerId, isHost: true, token: res.token };
    saveSession();
    showScreen('screen-lobby');
  });
});

$('#btn-join').addEventListener('click', () => {
  const roomCode = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value;
  if (!roomCode) return toast(t('toastCode'));
  if (!name.trim()) return toast(t('toastName'));
  socket.emit('joinRoom', { roomCode, name }, (res) => {
    if (!res.ok) return toast(res.error);
    state.me = { code: res.code, playerId: res.playerId, isHost: false, token: res.token };
    saveSession();
    showScreen('screen-lobby');
  });
});

// ---------- LOBBY ----------
$('#btn-share').addEventListener('click', async () => {
  const link = shareLink(state.me.code);
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Perudo', text: t('shareText'), url: link });
    } else {
      await navigator.clipboard.writeText(link);
      toast(t('linkCopied'));
    }
  } catch (e) {
    prompt(t('copyPrompt'), link);
  }
});

function startGameNow() {
  socket.emit('startGame', {}, (res) => {
    if (!res.ok) toast(res.error);
  });
}
$('#btn-start').addEventListener('click', () => {
  const room = state.room;
  // In due con Calza Official la Calza non è mai chiamabile: avvisa l'host.
  if (room && room.mode === 'calza' && room.calzaRule === 'official' && room.players.length === 2) {
    $('#calza-warn').classList.remove('hidden');
    return;
  }
  startGameNow();
});
$('#calza-warn-start').addEventListener('click', () => {
  $('#calza-warn').classList.add('hidden');
  startGameNow();
});
$('#calza-warn-back').addEventListener('click', () => {
  $('#calza-warn').classList.add('hidden');
});

function renderLobby(room) {
  $('#lobby-code').textContent = room.code;
  $('#game-code').textContent = room.code;
  $('#lobby-count').textContent = `${room.players.length}/${room.maxPlayers}`;

  const ul = $('#lobby-players');
  ul.innerHTML = '';
  room.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="avatar">${initials(p.name)}</span>
      <span class="p-name">${escapeHtml(p.name)}</span>
      ${p.isHost ? '<span class="badge host">HOST</span>' : ''}
      ${!p.connected ? '<span class="badge off">offline</span>' : ''}
    `;
    if (state.me.isHost && !p.isHost) {
      const btn = document.createElement('button');
      btn.className = 'kick';
      btn.textContent = t('kick');
      btn.onclick = () =>
        socket.emit('kickPlayer', { playerId: p.id }, (r) => {
          if (!r.ok) toast(r.error);
        });
      li.appendChild(btn);
    }
    ul.appendChild(li);
  });

  const hostCtrl = $('#lobby-host-controls');
  const guestNote = $('#lobby-guest-note');
  const modeInfo =
    room.mode === 'calza'
      ? `Calza ${room.calzaRule === 'house' ? '🍻 House' : '🏛️ Official'}`
      : t('modePrefix', { m: MODE_NAMES[room.mode] || room.mode });
  const tableInfo = `${t('diceEach', { n: room.dicePerPlayer })} · ${modeInfo}`;
  if (state.me.isHost) {
    hostCtrl.classList.remove('hidden');
    guestNote.classList.add('hidden');
    $('#lobby-dice-info').textContent = tableInfo;
    const enough = room.players.length >= room.minPlayers;
    $('#btn-start').disabled = !enough;
    $('#start-hint').textContent = enough ? '' : t('needPlayers', { n: room.minPlayers });
  } else {
    hostCtrl.classList.add('hidden');
    guestNote.classList.remove('hidden');
    $('#lobby-guest-info').textContent = tableInfo;
  }
}

// ---------- GIOCO ----------
function renderGame(room) {
  const g = room.game;
  $('#game-round').textContent = g.roundNumber;

  // Header: l'host vede "Termina" (chiude il tavolo), il guest "Abbandona".
  const isHost = !!(state.me && state.me.isHost);
  $('#btn-end-game').classList.toggle('hidden', !isHost);
  $('#btn-leave').classList.toggle('hidden', isHost);

  const rolling = g.rolling || { rolledIds: [], need: [], allRolled: true };

  // Auto-riparazione: se ho lanciato localmente ma il server non risulta
  // saperlo (es. 'rollDice' perso per un blip di rete o un reconnect),
  // lo ri-notifico. La add lato server è idempotente, quindi è sicuro.
  const meP = room.players.find((p) => p.id === state.me.playerId);
  const meAlive = !meP || meP.alive;
  if (
    g.phase === 'bidding' &&
    meAlive &&
    state.rolledRound === g.roundNumber &&
    !rolling.rolledIds.includes(state.me.playerId)
  ) {
    socket.emit('rollDice', {}, () => {});
  }

  // Tavolo giocatori
  const wrap = $('#players-table');
  wrap.innerHTML = '';
  room.players.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'p-card';
    if (p.id === g.turnPlayerId && g.phase === 'bidding' && rolling.allRolled) {
      card.classList.add('turn');
    }
    if (p.id === state.me.playerId) card.classList.add('me');
    if (!p.alive) card.classList.add('out');

    const dots = Array.from({ length: room.dicePerPlayer }, (_, i) =>
      `<span class="dot ${i < p.diceCount ? '' : 'spent'}"></span>`
    ).join('');

    // Stato lancio (solo in bidding, finche' non hanno lanciato tutti)
    let flag = '';
    if (g.phase === 'bidding' && !rolling.allRolled && p.alive) {
      if (rolling.rolledIds.includes(p.id)) {
        card.classList.add('rolled-yes');
        flag = '<span class="roll-flag" title="Ha lanciato">✅</span>';
      } else if (rolling.need.includes(p.id)) {
        flag = '<span class="roll-flag waiting" title="Deve lanciare">🎲</span>';
      }
    }
    const starter =
      p.id === g.starterPlayerId && (g.phase !== 'bidding' || rolling.allRolled)
        ? '<span class="starter" title="Ha aperto il round">🎯</span>'
        : '';

    card.innerHTML = `
      <div class="p-top">
        <span class="avatar">${initials(p.name)}</span>
        <span class="name">${escapeHtml(p.name)}</span>
      </div>
      <div class="dice-count">${dots}</div>
      ${flag}${starter}
    `;
    wrap.appendChild(card);
  });

  // Banner lanci
  const banner = $('#rolls-banner');
  if (g.phase === 'bidding' && !rolling.allRolled && !room.paused) {
    banner.classList.remove('hidden');
    $('#rolls-text').textContent = t('rollsBanner', {
      a: rolling.rolledIds.length,
      b: rolling.need.length,
    });
  } else {
    banner.classList.add('hidden');
  }

  // Banner Palifico
  const palBanner = $('#palifico-banner');
  if (g.palifico && g.phase === 'bidding') {
    const palName = (room.players.find((p) => p.id === g.palificoPlayerId) || {}).name || '';
    palBanner.classList.remove('hidden');
    $('#palifico-text').innerHTML = t('palBanner', { name: escapeHtml(palName) });
  } else {
    palBanner.classList.add('hidden');
  }

  // Dichiarazione corrente
  const bidEl = $('#bid-display');
  if (g.currentBid) {
    bidEl.className = 'bid-display has-bid';
    bidEl.innerHTML = `<span class="bid-x">${g.currentBid.quantity} ×</span> ${dieEl(g.currentBid.face, 'die-sm', '', g.wild)}`;
  } else {
    const starter = (room.players.find((p) => p.id === g.starterPlayerId) || {}).name;
    bidEl.className = 'bid-display no-bid';
    bidEl.innerHTML = starter ? t('noBidOpens', { name: escapeHtml(starter) }) : t('noBid');
  }

  renderMyDice(room);
  if (!$('#log-panel').classList.contains('hidden')) renderLog(room);

  // Controlli turno
  const iRolled = state.rolledRound === g.roundNumber;
  const myTurn = g.phase === 'bidding' && g.turnPlayerId === state.me.playerId;
  const controls = $('#controls');
  const waiting = $('#waiting-turn');
  const palChoice = $('#palifico-choice');
  const palPendingMe = g.palificoPending && g.palificoPendingId === state.me.playerId;

  if (room.paused) {
    // In pausa (abbandono o disconnessione): nessuna mossa, ci pensa l'overlay.
    controls.classList.add('hidden');
    waiting.classList.add('hidden');
    palChoice.classList.add('hidden');
  } else if (palPendingMe && iRolled) {
    // Devo decidere se dichiarare Palifico prima di aprire il round.
    controls.classList.add('hidden');
    waiting.classList.add('hidden');
    palChoice.classList.remove('hidden');
  } else if (myTurn && iRolled && rolling.allRolled && !g.palificoPending) {
    palChoice.classList.add('hidden');
    controls.classList.remove('hidden');
    waiting.classList.add('hidden');
    $('#btn-doubt').disabled = !g.currentBid;
    const meC = room.players.find((p) => p.id === state.me.playerId);
    if (g.palifico) {
      $('#controls-title').textContent =
        meC && meC.diceCount === 1 ? t('ctrlPalChange') : t('ctrlPalLocked');
    } else {
      $('#controls-title').textContent = t('ctrlYourTurn');
    }
    // Preselezione automatica del prossimo rilancio possibile (una volta per
    // ogni nuova dichiarazione), lasciando poi libertà di modifica.
    const ctxKey = g.roundNumber + '|' + (g.currentBid ? g.currentBid.quantity + 'x' + g.currentBid.face : 'open');
    if (state.autoKey !== ctxKey) {
      const sel = nextRaiseDefault(room);
      state.face = sel.face;
      state.qty = sel.qty;
      state.autoKey = ctxKey;
    }
    renderBidBuilder(room);
  } else {
    palChoice.classList.add('hidden');
    controls.classList.add('hidden');
    if (g.phase === 'bidding') {
      waiting.classList.remove('hidden');
      if (myTurn && !iRolled) {
        $('#waiting-text').textContent = t('waitRollYours');
      } else if (!rolling.allRolled) {
        $('#waiting-text').textContent = t('waitAllRoll');
      } else if (g.palificoPending) {
        const pn = (room.players.find((p) => p.id === g.palificoPendingId) || {}).name || '';
        $('#waiting-text').textContent = t('waitPal', { name: pn });
      } else {
        const turnName = (room.players.find((p) => p.id === g.turnPlayerId) || {}).name || '';
        $('#waiting-text').textContent = t('waitTurn', { name: turnName });
      }
    } else {
      waiting.classList.add('hidden');
    }
  }

  // Pulsante Calza (fuori turno) per i giocatori eleggibili.
  $('#calza-wrap').classList.toggle('hidden', !calzaEligible(room));
}

/** Posso chiamare Calza adesso? (specchio della logica server)
 *  Chiunque tranne il dichiarante, anche di turno — ma serve aver perso un dado. */
function calzaEligible(room) {
  const g = room.game;
  if (!g || room.mode !== 'calza') return false;
  if (g.phase !== 'bidding' || !g.currentBid || g.palifico || room.paused) return false;
  if (g.rolling && !g.rolling.allRolled) return false;
  const me = room.players.find((p) => p.id === state.me.playerId);
  if (!me || !me.alive) return false;
  if (state.me.playerId === g.currentBid.playerId) return false; // non il dichiarante
  if (me.diceCount >= room.dicePerPlayer) return false; // devi aver perso un dado
  if (g.calzaRule === 'official' && state.me.playerId === g.turnPlayerId) return false; // Official: chi risponde no
  return true;
}

function renderMyDice(room) {
  const g = room.game;
  const me = room.players.find((p) => p.id === state.me.playerId);
  const wrap = $('#my-dice');
  const label = $('#my-dice-label');

  if (me && !me.alive) {
    label.textContent = '';
    wrap.classList.remove('tap');
    wrap.innerHTML = `<span class="muted">${t('eliminated')}</span>`;
    return;
  }

  if (g.phase !== 'bidding') {
    label.textContent = t('myDice');
    wrap.classList.remove('tap');
    wrap.innerHTML = state.myDice.map((v) => dieEl(v, 'die-lg', '', g.wild)).join('');
    return;
  }

  if (state.animating) return;

  if (state.rolledRound === g.roundNumber) {
    label.textContent = t('myDice');
    wrap.classList.remove('tap');
    wrap.innerHTML = state.myDice.map((v) => dieEl(v, 'die-lg', '', g.wild)).join('');
  } else {
    label.textContent = '';
    wrap.classList.add('tap');
    wrap.innerHTML = `<div class="tap-roll"><div class="cup">🎲</div><span>${t('tapRoll')}</span></div>`;
  }
}

// Click sull'area dadi = lancio (animazione + notifica al server).
$('#my-dice').addEventListener('click', () => {
  const room = state.room;
  if (!room || !room.game) return;
  const g = room.game;
  if (g.phase !== 'bidding') return;
  if (state.rolledRound === g.roundNumber) return;
  if (!state.myDice || !state.myDice.length) return;
  const me = room.players.find((p) => p.id === state.me.playerId);
  if (me && !me.alive) return;
  state.rolledRound = g.roundNumber;
  socket.emit('rollDice', {}, () => {});
  throwDice(state.myDice, $('#my-dice'));
});

function throwDice(values, wrap) {
  state.animating = true;
  $('#my-dice-label').textContent = '';
  wrap.classList.remove('tap');
  wrap.innerHTML = values.map(() => dieEl(1, 'die-lg', 'rolling')).join('');
  const dies = [...wrap.querySelectorAll('.die')];
  let ticks = 0;
  const iv = setInterval(() => {
    dies.forEach((d) => setDieFace(d, 1 + Math.floor(Math.random() * 6)));
    ticks += 1;
    if (ticks >= 13) {
      clearInterval(iv);
      dies.forEach((d, i) => {
        d.classList.remove('rolling');
        setDieFace(d, values[i]);
      });
      state.animating = false;
      $('#my-dice-label').textContent = t('myDice');
      if (state.room) renderGame(state.room);
    }
  }, 70);
}

/** Facce selezionabili in base a modalità/palifico. */
function allowedFaces(room) {
  const g = room.game;
  const opening = !g.currentBid;
  if (g.palifico) {
    const me = room.players.find((p) => p.id === state.me.playerId);
    const canChange = opening || (me && me.diceCount === 1);
    return canChange ? [1, 2, 3, 4, 5, 6] : [g.lockedFace];
  }
  if (g.wild) {
    return opening ? [2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6]; // niente apertura sugli 1
  }
  return [1, 2, 3, 4, 5, 6];
}

/** Quantità minima legale per un rilancio sulla faccia scelta (mirror server). */
function minQtyForFace(room, face) {
  const g = room.game;
  const cur = g.currentBid;
  if (!cur) return 1;
  if (g.palifico) {
    const me = room.players.find((p) => p.id === state.me.playerId);
    const canChange = me && me.diceCount === 1;
    if (canChange) return face > cur.face ? cur.quantity : cur.quantity + 1;
    return cur.quantity + 1;
  }
  if (g.wild) {
    const curAce = cur.face === 1;
    const nextAce = face === 1;
    if (!curAce && !nextAce) return face > cur.face ? cur.quantity : cur.quantity + 1;
    if (!curAce && nextAce) return Math.ceil(cur.quantity / 2);
    if (curAce && !nextAce) return cur.quantity * 2 + 1;
    return cur.quantity + 1;
  }
  return face > cur.face ? cur.quantity : cur.quantity + 1;
}

/** Prossimo rilancio "minimo" da preselezionare (valido, in tutte le modalità). */
function nextRaiseDefault(room) {
  const g = room.game;
  const cb = g.currentBid;
  if (!cb) {
    // apertura: in palifico l'1 è normale; in jolly non si apre sull'1
    if (g.palifico) return { qty: 1, face: 1 };
    return { qty: 1, face: g.wild ? 2 : 1 };
  }
  if (g.palifico) {
    const me = room.players.find((p) => p.id === state.me.playerId);
    const canChange = me && me.diceCount === 1;
    if (!canChange) return { qty: cb.quantity + 1, face: g.lockedFace };
    return cb.face < 6 ? { qty: cb.quantity, face: cb.face + 1 } : { qty: cb.quantity + 1, face: 1 };
  }
  if (g.wild && cb.face === 1) return { qty: cb.quantity + 1, face: 1 }; // più assi
  // standard e jolly: stessa quantità con valore più alto; se 6, +1 quantità e riparti da 1
  return cb.face < 6 ? { qty: cb.quantity, face: cb.face + 1 } : { qty: cb.quantity + 1, face: 1 };
}

function renderBidBuilder(room) {
  const g = room.game;
  const faces = allowedFaces(room);
  if (!faces.includes(state.face)) state.face = faces[0];
  const min = minQtyForFace(room, state.face);
  state.minQty = min;
  if (state.qty < min) state.qty = min;
  $('#qty-val').textContent = state.qty;

  const picker = $('#face-picker');
  picker.innerHTML = '';
  for (let f = 1; f <= 6; f += 1) {
    const b = document.createElement('button');
    const allowed = faces.includes(f);
    b.className =
      'face-opt' + (f === state.face ? ' selected' : '') + (allowed ? '' : ' disabled');
    b.innerHTML = dieEl(f, 'die-sm', '', g.wild);
    if (allowed) {
      b.onclick = () => {
        state.face = f;
        renderBidBuilder(room);
      };
    } else {
      b.disabled = true;
    }
    picker.appendChild(b);
  }
}

$('#qty-minus').addEventListener('click', () => {
  const min = state.minQty || 1;
  state.qty = Math.max(min, state.qty - 1);
  $('#qty-val').textContent = state.qty;
});
$('#qty-plus').addEventListener('click', () => {
  state.qty = Math.min(99, state.qty + 1);
  $('#qty-val').textContent = state.qty;
});

$('#btn-bid').addEventListener('click', () => {
  socket.emit('placeBid', { quantity: state.qty, face: state.face }, (res) => {
    if (!res.ok) toast(res.error);
  });
});

$('#btn-doubt').addEventListener('click', () => {
  socket.emit('challenge', {}, (res) => {
    if (!res.ok) toast(res.error);
  });
});

$('#btn-palifico-yes').addEventListener('click', () => {
  socket.emit('choosePalifico', { activate: true }, (res) => {
    if (!res.ok) toast(res.error);
  });
});
$('#btn-palifico-no').addEventListener('click', () => {
  socket.emit('choosePalifico', { activate: false }, (res) => {
    if (!res.ok) toast(res.error);
  });
});

$('#btn-calza').addEventListener('click', () => {
  const g = state.room && state.room.game;
  const expectedBid = g && g.currentBid
    ? { quantity: g.currentBid.quantity, face: g.currentBid.face }
    : null;
  socket.emit('calza', { expectedBid }, (res) => {
    if (!res.ok) toast(res.error);
  });
});

function doEndGame() {
  if (!window.confirm(t('confirmEnd'))) return;
  socket.emit('endGame', {}, (res) => {
    if (!res.ok) toast(res.error);
  });
}
function doLeaveTable(confirmMsg) {
  if (confirmMsg && !window.confirm(confirmMsg)) return;
  socket.emit('leaveTable', {}, () => {
    clearSession();
    location.href = location.pathname;
  });
}

$('#btn-end-game').addEventListener('click', doEndGame);
$('#btn-close-lobby').addEventListener('click', doEndGame);
$('#btn-leave').addEventListener('click', () => doLeaveTable(t('confirmLeave')));
$('#btn-leave-lobby').addEventListener('click', () => doLeaveTable(null));

// ---------- OVERLAY (rivelazione / fine) ----------
let countdownTimer = null;
function showReveal(room) {
  const g = room.game;
  const r = g.lastResult;
  if (!r) return;
  const overlay = $('#overlay');
  overlay.classList.remove('hidden');

  const gameOver = g.phase === 'gameOver';
  const key = g.roundNumber + ':' + (gameOver ? 'end' : 'rev');
  const isNew = state.revealKey !== key;

  const isCalza = r.type === 'calza';
  $('#overlay-title').textContent = gameOver
    ? t('ovWin')
    : isCalza
    ? r.exact
      ? t('ovCalzaExact')
      : t('ovCalzaWrong')
    : r.bidWasTrue
    ? t('ovTrue')
    : t('ovFalse');

  const bidStr = `${r.bid.quantity} × ${faceName(r.bid.face, r.wild)}`;
  const elim = r.loserEliminated ? t('ovElim') : '';
  let sub;
  if (isCalza) {
    sub =
      t('ovCalzaSub', { caller: escapeHtml(r.callerName), bid: bidStr, count: r.actualCount }) +
      (r.exact
        ? t('ovCalzaGain', { caller: escapeHtml(r.callerName) })
        : t('ovCalzaLose', { caller: escapeHtml(r.callerName), elim }));
  } else {
    sub = t('ovBidSub', {
      bidder: escapeHtml(r.bidderName),
      bid: bidStr,
      count: r.actualCount,
      face: faceName(r.bid.face, r.wild),
      loser: escapeHtml(r.loserName),
      elim,
    });
  }
  $('#overlay-sub').innerHTML = gameOver
    ? t('ovWinner', { name: escapeHtml(r.winnerName) })
    : sub;

  const rev = $('#overlay-reveal');
  rev.innerHTML = '';
  r.reveal.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'reveal-row' + (p.id === r.loserId ? ' loser' : '');
    const dice = p.dice.length
      ? p.dice
          .map((d) => {
            const match = d === r.bid.face || (r.wild && d === 1);
            return dieEl(d, 'die-xs', match ? 'match' : '', r.wild);
          })
          .join('')
      : '<span class="muted">—</span>';
    row.innerHTML = `<span class="r-name">${escapeHtml(p.name)}</span><span class="reveal-dice">${dice}</span>`;
    rev.appendChild(row);
  });

  const btn = $('#overlay-btn');
  const btn2 = $('#overlay-btn2');
  const cd = $('#overlay-countdown');

  if (gameOver) {
    clearInterval(countdownTimer);
    const isHost = !!(state.me && state.me.isHost);
    btn.classList.remove('hidden');
    btn.disabled = false;
    if (isHost) {
      // Host: sceglie tra rivincita e chiusura tavolo.
      btn.className = 'primary';
      btn.textContent = t('rematch');
      btn.onclick = () => socket.emit('rematch', {}, (res) => { if (!res.ok) toast(res.error); });
      btn2.classList.remove('hidden');
      btn2.className = 'danger-ghost';
      btn2.textContent = t('closeTableBtn');
      btn2.onclick = doEndGame;
      cd.textContent = '';
    } else {
      // Guest: può abbandonare, altrimenti aspetta la scelta dell'host.
      btn.className = 'danger-ghost';
      btn.textContent = t('abandonBtn');
      btn.onclick = () => doLeaveTable(null);
      btn2.classList.add('hidden');
      cd.textContent = t('waitHost');
    }
  } else {
    btn2.classList.add('hidden');
    const ready = g.ready || { readyIds: [], total: 0 };
    const meP = room.players.find((p) => p.id === state.me.playerId);
    const meEliminated = meP && !meP.alive;
    if (meEliminated) {
      // Spettatore: non deve premere nulla, aspetta i giocatori attivi.
      btn.classList.add('hidden');
    } else {
      const iAmReady = ready.readyIds.includes(state.me.playerId);
      btn.classList.remove('hidden');
      btn.className = 'primary';
      btn.textContent = iAmReady ? t('readyBtn') : t('proceedBtn');
      btn.disabled = iAmReady;
      btn.onclick = () => {
        socket.emit('readyNext', {}, () => {});
        btn.disabled = true;
        btn.textContent = t('readyBtn');
      };
    }

    if (isNew) {
      clearInterval(countdownTimer);
      let left = REVEAL_SECONDS;
      updateCountdownText(left, ready);
      countdownTimer = setInterval(() => {
        left -= 1;
        const rd = (state.room && state.room.game && state.room.game.ready) || ready;
        updateCountdownText(Math.max(0, left), rd);
        if (left <= 0) clearInterval(countdownTimer);
      }, 1000);
    } else {
      refreshCountdownReady(ready);
    }
  }
  state.revealKey = key;
}

function updateCountdownText(left, ready) {
  const cd = $('#overlay-countdown');
  const readyStr = ready ? t('readyCount', { a: ready.readyIds.length, b: ready.total }) : '';
  cd.textContent = left > 0 ? readyStr + t('newRoundIn', { s: left }) : readyStr + t('goAgain');
  cd.dataset.left = left;
}
function refreshCountdownReady(ready) {
  const cd = $('#overlay-countdown');
  const left = parseInt(cd.dataset.left || '0', 10);
  updateCountdownText(left, ready);
}

function faceName(v, wild) {
  const w = wild && v === 1 ? ' wild' : '';
  return `<span class="die die-xs inline${w}" data-val="${v}">${pipsHtml(v)}</span>`;
}

function hideOverlay() {
  $('#overlay').classList.add('hidden');
  $('#overlay-btn2').classList.add('hidden');
  clearInterval(countdownTimer);
  state.revealKey = null;
}

// Pulsante d'azione condiviso dagli overlay: host = chiudi tavolo, guest = abbandona.
function configureAbandonBtn(btn) {
  const isHost = !!(state.me && state.me.isHost);
  btn.textContent = isHost ? t('endCloseBtn') : t('leaveTableBtn');
  btn.onclick = isHost ? doEndGame : () => doLeaveTable(t('confirmLeave'));
}

// Overlay PESANTE: qualcuno ha lasciato il tavolo col pulsante (serve il codice).
function showPause(room) {
  const names = (room.leftPlayers || []).map(escapeHtml).join(', ');
  $('#pause-sub').innerHTML = names ? t('pauseLeftNames', { names }) : t('pauseLeftGeneric');
  $('#pause-code').textContent = room.code;
  $('#pause-hint').innerHTML = names ? t('pauseHintNames', { names }) : t('pauseHintGeneric');
  configureAbandonBtn($('#pause-action'));
  $('#pause-overlay').classList.remove('hidden');
}
function hidePause() {
  $('#pause-overlay').classList.add('hidden');
}

// Overlay LEGGERO: disconnessione temporanea (rientro automatico atteso).
function showDisconnect(room) {
  const names = (room.disconnectedPlayers || []).map(escapeHtml).join(', ');
  $('#disconnect-sub').innerHTML = names ? t('discNames', { names }) : t('discGeneric');
  configureAbandonBtn($('#disconnect-action'));
  $('#disconnect-overlay').classList.remove('hidden');
}
function hideDisconnect() {
  $('#disconnect-overlay').classList.add('hidden');
}

// ---------- CHAT ----------
function addChatMsg(m, opts) {
  const mine = m.playerId === state.me.playerId;
  const box = $('#chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-msg' + (mine ? ' mine' : '');
  el.style.setProperty('--h', hue(m.playerId));
  el.innerHTML = `
    <span class="chat-avatar">${initials(m.name)}</span>
    <div class="chat-bubble">
      ${mine ? '' : `<span class="chat-name">${escapeHtml(m.name)}</span>`}
      <span class="chat-text">${escapeHtml(m.text)}</span>
    </div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;

  if (!(opts && opts.history) && !mine) {
    if (state.chatOpen) {
      // gia' visibile: niente badge
    } else {
      state.unread += 1;
      updateChatBadge();
      showChatPop(m);
    }
  }
}

function updateChatBadge() {
  const badge = $('#chat-badge');
  if (state.unread > 0) {
    badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

let chatPopTimer = null;
function showChatPop(m) {
  const pop = $('#chat-pop');
  pop.innerHTML = `<span class="cp-name">${escapeHtml(m.name)}</span><span class="cp-text">${escapeHtml(m.text)}</span>`;
  pop.classList.remove('hidden');
  clearTimeout(chatPopTimer);
  chatPopTimer = setTimeout(() => pop.classList.add('hidden'), 4500);
}

function openChat() {
  closeLog();
  state.chatOpen = true;
  state.unread = 0;
  updateChatBadge();
  $('#chat-panel').classList.remove('hidden');
  $('#chat-pop').classList.add('hidden');
  const box = $('#chat-messages');
  box.scrollTop = box.scrollHeight;
  setTimeout(() => $('#chat-input').focus(), 100);
}
function closeChat() {
  state.chatOpen = false;
  $('#chat-panel').classList.add('hidden');
}

// ---------- STORICO DICHIARAZIONI ----------
function renderLog(room) {
  const g = room.game;
  const log = (g && g.bidLog) || [];
  const list = $('#log-list');
  if (!log.length) {
    list.innerHTML = `<p class="log-empty">${t('logEmpty')}</p>`;
    return;
  }
  list.innerHTML = log
    .map(
      (b, i) => `
      <div class="log-row">
        <span class="log-num">${i + 1}</span>
        <span class="log-name">${escapeHtml(b.name)}</span>
        <span class="log-bid">${b.quantity} × ${dieEl(b.face, 'die-xs', '', g.wild)}</span>
      </div>`
    )
    .join('');
  list.scrollTop = list.scrollHeight;
}
function openLog() {
  closeChat();
  $('#log-panel').classList.remove('hidden');
  if (state.room) renderLog(state.room);
}
function closeLog() {
  $('#log-panel').classList.add('hidden');
}
$('#log-toggle').addEventListener('click', () =>
  $('#log-panel').classList.contains('hidden') ? openLog() : closeLog()
);
$('#log-close').addEventListener('click', closeLog);

$('#chat-toggle').addEventListener('click', () => (state.chatOpen ? closeChat() : openChat()));
$('#chat-close').addEventListener('click', closeChat);
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value;
  if (!text.trim()) return;
  socket.emit('chat', { text }, () => {});
  input.value = '';
  input.focus();
});

// ---------- utilità ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------- socket handlers ----------
socket.on('state', (room) => {
  state.room = room;
  const inGame = room.status === 'playing' || room.status === 'finished';

  // Mostra i pulsanti chat e storico solo dentro la partita.
  $('#chat-toggle').classList.toggle('hidden', !inGame);
  $('#log-toggle').classList.toggle('hidden', !inGame);
  if (!inGame) {
    closeChat();
    closeLog();
  }

  if (room.status === 'lobby') {
    hideOverlay();
    hidePause();
    hideDisconnect();
    renderLobby(room);
    showScreen('screen-lobby');
  } else {
    renderLobby(room);
    showScreen('screen-game');
    renderGame(room);
    if (room.paused) {
      // La pausa ha la precedenza su qualsiasi altro overlay.
      hideOverlay();
      if ((room.leftPlayers || []).length > 0) {
        // Abbandono esplicito -> overlay pesante col codice.
        hideDisconnect();
        showPause(room);
      } else {
        // Solo disconnessione temporanea -> overlay leggero.
        hidePause();
        showDisconnect(room);
      }
    } else {
      hidePause();
      hideDisconnect();
      if (room.game && (room.game.phase === 'reveal' || room.game.phase === 'gameOver')) {
        showReveal(room);
      } else {
        hideOverlay();
      }
    }
  }
});

socket.on('yourDice', ({ dice }) => {
  state.myDice = dice || [];
  if (state.room && state.room.status === 'playing') renderGame(state.room);
});

socket.on('chatHistory', (msgs) => {
  $('#chat-messages').innerHTML = '';
  (msgs || []).forEach((m) => addChatMsg(m, { history: true }));
});
socket.on('chatMessage', (m) => addChatMsg(m));

socket.on('kicked', () => {
  clearSession();
  toast(t('kickedT'));
  setTimeout(() => (location.href = location.pathname), 1200);
});

socket.on('tableClosed', () => {
  clearSession();
  toast(t('closedT'));
  setTimeout(() => (location.href = location.pathname), 1200);
});

socket.on('connect', () => {
  // Ad OGNI (ri)connessione ci si ri-registra al tavolo, così dopo un blip
  // di rete o un reconnect automatico il socket torna a ricevere gli update
  // e a essere associato al proprio posto (fondamentale su mobile).
  const saved = safeParse(localStorage.getItem(SESSION_KEY));
  const code = (state.me && state.me.code) || (saved && saved.code);
  const token = (state.me && state.me.token) || (saved && saved.token);
  if (code && token) {
    socket.emit('reconnectPlayer', { roomCode: code, token }, (res) => {
      if (res && res.ok) {
        state.me = { code: res.code, playerId: res.playerId, isHost: res.isHost, token };
      } else if (!state.me) {
        clearSession();
      }
    });
  }
});

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// Riconnessione PROATTIVA: quando l'app torna in primo piano, riprende il focus
// o la rete torna disponibile, riapriamo subito il socket se è caduto — senza
// aspettare i timeout. Il gestore 'connect' poi ci ri-registra al tavolo.
function ensureConnected() {
  if (!socket.connected) socket.connect();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ensureConnected();
});
window.addEventListener('focus', ensureConnected);
window.addEventListener('online', ensureConnected);
window.addEventListener('pageshow', ensureConnected);

// ---------- avvio: prefill codice da ?room= ----------
(function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    $('#join-code').value = room.toUpperCase();
    setTimeout(() => $('#join-name').focus(), 200);
  }
})();
