/* global io */
'use strict';

// ---------- util ----------
const $ = (sel) => document.querySelector(sel);
const SESSION_KEY = 'perudo.session';
const REVEAL_SECONDS = 20;

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
/** HTML di un dado realistico. size: die-lg | die-md | die-sm | die-xs */
function dieEl(v, size, extra) {
  return `<span class="die ${size || 'die-md'}${extra ? ' ' + extra : ''}" data-val="${v}">${pipsHtml(v)}</span>`;
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
  lastRoundSeen: null, // per azzerare il selettore a nuovo round
  chatOpen: false,
  unread: 0,
};

// ---------- schermate ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
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

// ---------- HOME ----------
$('#btn-create').addEventListener('click', () => {
  const hostName = $('#host-name').value;
  const dicePerPlayer = $('#dice-count').value;
  if (!hostName.trim()) return toast('Inserisci il tuo nome.');
  socket.emit('createRoom', { hostName, dicePerPlayer }, (res) => {
    if (!res.ok) return toast(res.error);
    state.me = { code: res.code, playerId: res.playerId, isHost: true, token: res.token };
    saveSession();
    showScreen('screen-lobby');
  });
});

$('#btn-join').addEventListener('click', () => {
  const roomCode = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value;
  if (!roomCode) return toast('Inserisci il codice del tavolo.');
  if (!name.trim()) return toast('Inserisci il tuo nome.');
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
      await navigator.share({ title: 'Perudo', text: 'Unisciti al mio tavolo!', url: link });
    } else {
      await navigator.clipboard.writeText(link);
      toast('Link copiato!');
    }
  } catch (e) {
    prompt('Copia il link e invialo agli amici:', link);
  }
});

$('#btn-start').addEventListener('click', () => {
  socket.emit('startGame', {}, (res) => {
    if (!res.ok) toast(res.error);
  });
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
      btn.textContent = 'Espelli';
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
  if (state.me.isHost) {
    hostCtrl.classList.remove('hidden');
    guestNote.classList.add('hidden');
    $('#lobby-dice-info').textContent = `${room.dicePerPlayer} dadi a testa`;
    const enough = room.players.length >= room.minPlayers;
    $('#btn-start').disabled = !enough;
    $('#start-hint').textContent = enough
      ? ''
      : `Servono almeno ${room.minPlayers} giocatori per iniziare.`;
  } else {
    hostCtrl.classList.add('hidden');
    guestNote.classList.remove('hidden');
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

  // Nuovo round: azzera il selettore alla "puntata consigliata" 1 × valore 1.
  if (state.lastRoundSeen !== g.roundNumber) {
    state.lastRoundSeen = g.roundNumber;
    state.qty = 1;
    state.face = 1;
  }

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
    $('#rolls-text').textContent = `Lanci ${rolling.rolledIds.length}/${rolling.need.length} — in attesa che tutti lancino i dadi`;
  } else {
    banner.classList.add('hidden');
  }

  // Dichiarazione corrente
  const bidEl = $('#bid-display');
  if (g.currentBid) {
    bidEl.innerHTML = `<span class="bid-x">${g.currentBid.quantity} ×</span> ${dieEl(g.currentBid.face, 'die-sm')}`;
  } else {
    const starter = (room.players.find((p) => p.id === g.starterPlayerId) || {}).name;
    bidEl.innerHTML = starter
      ? `nessuna, apre <strong>${escapeHtml(starter)}</strong> il round`
      : 'nessuna';
  }

  renderMyDice(room);

  // Controlli turno
  const iRolled = state.rolledRound === g.roundNumber;
  const myTurn = g.phase === 'bidding' && g.turnPlayerId === state.me.playerId;
  const controls = $('#controls');
  const waiting = $('#waiting-turn');

  if (room.paused) {
    // In pausa (abbandono o disconnessione): nessuna mossa, ci pensa l'overlay.
    controls.classList.add('hidden');
    waiting.classList.add('hidden');
  } else if (myTurn && iRolled && rolling.allRolled) {
    controls.classList.remove('hidden');
    waiting.classList.add('hidden');
    const minQty = g.currentBid ? g.currentBid.quantity : 1;
    if (state.qty < minQty) state.qty = minQty;
    $('#btn-doubt').disabled = !g.currentBid;
    renderBidBuilder();
  } else {
    controls.classList.add('hidden');
    if (g.phase === 'bidding') {
      waiting.classList.remove('hidden');
      if (myTurn && !iRolled) {
        $('#waiting-text').textContent = 'Lancia i tuoi dadi per giocare 👆';
      } else if (!rolling.allRolled) {
        $('#waiting-text').textContent = 'In attesa che tutti lancino i dadi…';
      } else {
        const turnName = (room.players.find((p) => p.id === g.turnPlayerId) || {}).name || '';
        $('#waiting-text').textContent = `Tocca a ${turnName}…`;
      }
    } else {
      waiting.classList.add('hidden');
    }
  }
}

function renderMyDice(room) {
  const g = room.game;
  const me = room.players.find((p) => p.id === state.me.playerId);
  const wrap = $('#my-dice');
  const label = $('#my-dice-label');

  if (me && !me.alive) {
    label.textContent = '';
    wrap.classList.remove('tap');
    wrap.innerHTML = '<span class="muted">Sei stato eliminato 😵</span>';
    return;
  }

  if (g.phase !== 'bidding') {
    label.textContent = 'I tuoi dadi';
    wrap.classList.remove('tap');
    wrap.innerHTML = state.myDice.map((v) => dieEl(v, 'die-lg')).join('');
    return;
  }

  if (state.animating) return;

  if (state.rolledRound === g.roundNumber) {
    label.textContent = 'I tuoi dadi';
    wrap.classList.remove('tap');
    wrap.innerHTML = state.myDice.map((v) => dieEl(v, 'die-lg')).join('');
  } else {
    label.textContent = '';
    wrap.classList.add('tap');
    wrap.innerHTML =
      '<div class="tap-roll"><div class="cup">🎲</div><span>Tocca per lanciare i dadi</span></div>';
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
      $('#my-dice-label').textContent = 'I tuoi dadi';
      if (state.room) renderGame(state.room);
    }
  }, 70);
}

function renderBidBuilder() {
  $('#qty-val').textContent = state.qty;
  const picker = $('#face-picker');
  picker.innerHTML = '';
  for (let f = 1; f <= 6; f += 1) {
    const b = document.createElement('button');
    b.className = 'face-opt' + (f === state.face ? ' selected' : '');
    b.innerHTML = dieEl(f, 'die-sm');
    b.onclick = () => {
      state.face = f;
      renderBidBuilder();
    };
    picker.appendChild(b);
  }
}

$('#qty-minus').addEventListener('click', () => {
  state.qty = Math.max(1, state.qty - 1);
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

function doEndGame() {
  if (!window.confirm('Chiudere il tavolo per tutti? La partita finisce e tutti tornano alla schermata iniziale.')) return;
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
$('#btn-leave').addEventListener('click', () =>
  doLeaveTable('Vuoi abbandonare il tavolo? La partita andrà in pausa finché non rientri (con lo stesso nome).')
);
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

  $('#overlay-title').textContent = gameOver
    ? '🏆 Partita finita!'
    : r.bidWasTrue
    ? 'Dichiarazione VERA'
    : 'Dichiarazione FALSA';

  const bidStr = `${r.bid.quantity} × ${faceName(r.bid.face)}`;
  const sub =
    `${escapeHtml(r.bidderName)} aveva dichiarato ${bidStr}. In tavola: ` +
    `${r.actualCount} dadi da ${faceName(r.bid.face)}. ` +
    `${escapeHtml(r.loserName)} perde un dado${r.loserEliminated ? ' ed è eliminato/a' : ''}.`;
  $('#overlay-sub').innerHTML = gameOver
    ? `Vince <strong>${escapeHtml(r.winnerName)}</strong>! 🎉`
    : sub;

  const rev = $('#overlay-reveal');
  rev.innerHTML = '';
  r.reveal.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'reveal-row' + (p.id === r.loserId ? ' loser' : '');
    const dice = p.dice.length
      ? p.dice.map((d) => dieEl(d, 'die-xs', d === r.bid.face ? 'match' : '')).join('')
      : '<span class="muted">—</span>';
    row.innerHTML = `<span class="r-name">${escapeHtml(p.name)}</span><span class="reveal-dice">${dice}</span>`;
    rev.appendChild(row);
  });

  const btn = $('#overlay-btn');
  const cd = $('#overlay-countdown');

  if (gameOver) {
    clearInterval(countdownTimer);
    cd.textContent = '';
    btn.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Torna alla home';
    btn.onclick = () => {
      clearSession();
      location.href = location.pathname;
    };
  } else {
    const ready = g.ready || { readyIds: [], total: 0 };
    const iAmReady = ready.readyIds.includes(state.me.playerId);
    btn.classList.remove('hidden');
    btn.textContent = iAmReady ? '✓ Pronto' : 'Procedi ▶';
    btn.disabled = iAmReady;
    btn.onclick = () => {
      socket.emit('readyNext', {}, () => {});
      btn.disabled = true;
      btn.textContent = '✓ Pronto';
    };

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
  const readyStr = ready ? `${ready.readyIds.length}/${ready.total} pronti · ` : '';
  cd.textContent = left > 0 ? `${readyStr}nuovo round tra ${left}s…` : `${readyStr}si riparte!`;
  cd.dataset.left = left;
}
function refreshCountdownReady(ready) {
  const cd = $('#overlay-countdown');
  const left = parseInt(cd.dataset.left || '0', 10);
  updateCountdownText(left, ready);
}

function faceName(v) {
  return `<span class="die die-xs inline" data-val="${v}">${pipsHtml(v)}</span>`;
}

function hideOverlay() {
  $('#overlay').classList.add('hidden');
  clearInterval(countdownTimer);
  state.revealKey = null;
}

// Pulsante d'azione condiviso dagli overlay: host = chiudi tavolo, guest = abbandona.
function configureAbandonBtn(btn) {
  const isHost = !!(state.me && state.me.isHost);
  btn.textContent = isHost ? '⏹ Termina e chiudi il tavolo' : '🚪 Abbandona il tavolo';
  btn.onclick = isHost
    ? doEndGame
    : () =>
        doLeaveTable(
          'Vuoi abbandonare il tavolo? La partita resterà in pausa finché non rientri (con lo stesso nome).'
        );
}

// Overlay PESANTE: qualcuno ha lasciato il tavolo col pulsante (serve il codice).
function showPause(room) {
  const names = (room.leftPlayers || []).map(escapeHtml).join(', ');
  $('#pause-sub').innerHTML = names
    ? `<strong>${names}</strong> ha lasciato il tavolo.`
    : 'Un giocatore ha lasciato il tavolo.';
  $('#pause-code').textContent = room.code;
  $('#pause-hint').innerHTML = names
    ? `Comunica questo codice a <strong>${names}</strong>: per rientrare basta riaprire il gioco ed entrare con lo stesso nome.`
    : 'Comunica questo codice a chi è uscito: per rientrare basta riaprire il gioco ed entrare con lo stesso nome.';
  configureAbandonBtn($('#pause-action'));
  $('#pause-overlay').classList.remove('hidden');
}
function hidePause() {
  $('#pause-overlay').classList.add('hidden');
}

// Overlay LEGGERO: disconnessione temporanea (rientro automatico atteso).
function showDisconnect(room) {
  const names = (room.disconnectedPlayers || []).map(escapeHtml).join(', ');
  $('#disconnect-sub').innerHTML = names
    ? `In attesa che <strong>${names}</strong> si riconnetta… riprende da solo appena torna.`
    : 'In attesa di riconnessione…';
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

  // Mostra il pulsante chat solo dentro la partita.
  $('#chat-toggle').classList.toggle('hidden', !inGame);
  if (!inGame) closeChat();

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
  toast('Sei stato rimosso dal tavolo.');
  setTimeout(() => (location.href = location.pathname), 1200);
});

socket.on('tableClosed', () => {
  clearSession();
  toast("L'host ha chiuso il tavolo.");
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
