'use strict';

/**
 * server.js — Express + Socket.IO.
 *
 * Serve il frontend statico (public/) e gestisce il realtime del gioco.
 * La logica autoritativa vive nell'engine: qui si instradano gli eventi,
 * si validano i permessi e si garantisce che i dadi privati vadano SOLO
 * al legittimo proprietario.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager, MAX_PLAYERS, MIN_PLAYERS } = require('./game/rooms');
const bots = require('./game/bots');

const PORT = process.env.PORT || 3000;
const REVEAL_MS = 20000; // durata max della rivelazione prima del round successivo
const MAX_CHAT_LEN = 300; // lunghezza massima di un messaggio in chat
const CHAT_HISTORY = 100; // messaggi conservati per il reconnect

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const manager = new RoomManager();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Pulizia periodica delle stanze vuote scadute.
setInterval(() => manager.cleanup(), 5 * 60 * 1000).unref();

/** Costruisce lo stato PUBBLICO della stanza (nessun dado coperto). */
function roomStatePayload(room) {
  const gameState = room.game ? room.game.publicState() : null;
  // Uniamo info di lobby (isHost/connected) con i conteggi dadi dal game.
  const players = room.players.map((p) => {
    const g = gameState && gameState.players.find((gp) => gp.id === p.id);
    return {
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      connected: p.connected,
      diceCount: g ? g.diceCount : room.dicePerPlayer,
      alive: g ? g.alive : true,
      dice: g ? g.dice : null, // valorizzato solo in reveal/gameOver
      isBot: !!p.isBot,
    };
  });
  const absent = absentPlayers(room);
  return {
    code: room.code,
    status: room.status,
    dicePerPlayer: room.dicePerPlayer,
    mode: room.mode || 'standard',
    calzaRule: room.calzaRule || 'official',
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    hostId: room.hostId,
    paused: room.status === 'playing' && absent.length > 0,
    waitingFor: absent.map((p) => p.name),
    leftPlayers: absent.filter((p) => p.left).map((p) => p.name),
    disconnectedPlayers: absent.filter((p) => !p.left).map((p) => p.name),
    players,
    game: gameState
      ? {
          phase: gameState.phase,
          roundNumber: gameState.roundNumber,
          currentBid: gameState.currentBid,
          turnPlayerId: gameState.turnPlayerId,
          starterPlayerId: gameState.starterPlayerId,
          winnerId: gameState.winnerId,
          mode: gameState.mode,
          calzaRule: gameState.calzaRule,
          wild: gameState.wild,
          palifico: gameState.palifico,
          palificoPlayerId: gameState.palificoPlayerId,
          palificoPending: gameState.palificoPending,
          palificoPendingId: gameState.palificoPendingId,
          lockedFace: gameState.lockedFace,
          nextPlayerId: gameState.nextPlayerId,
          lastResult: room.game.lastResult || null,
          ready: readyInfo(room, gameState),
          rolling: rollingInfo(room, gameState),
          bidLog: room.bidLog || [],
        }
      : null,
  };
}

/** Giocatori ATTIVI = ancora in gioco (vivi) e connessi. Gli eliminati e i
 *  disconnessi non contano per avanzamento round e conteggio "pronti". */
function activePlayerIds(room) {
  if (!room.game) return room.players.filter((p) => p.connected).map((p) => p.id);
  const gs = room.game.publicState();
  const aliveIds = new Set(gs.players.filter((p) => p.alive).map((p) => p.id));
  return room.players.filter((p) => p.connected && aliveIds.has(p.id)).map((p) => p.id);
}

/** Info sui giocatori "pronti" a proseguire (solo durante la rivelazione). */
function readyInfo(room, gameState) {
  if (!gameState || gameState.phase !== 'reveal') return null;
  const active = activePlayerIds(room);
  const readyIds = [...(room.readyNext || [])].filter((id) => active.includes(id));
  return { readyIds, total: active.length };
}

/** Elenco dei giocatori che devono lanciare: vivi e connessi. */
function mustRollIds(room, gameState) {
  const aliveIds = new Set(
    gameState.players.filter((p) => p.alive).map((p) => p.id)
  );
  return room.players
    .filter((p) => p.connected && aliveIds.has(p.id))
    .map((p) => p.id);
}
/** Info sui lanci del round corrente (solo durante il bidding). */
function rollingInfo(room, gameState) {
  if (!gameState || gameState.phase !== 'bidding') return null;
  const need = mustRollIds(room, gameState);
  const rolled = room.rolled || new Set();
  const rolledIds = [...rolled].filter((id) => need.includes(id));
  return {
    rolledIds,
    need,
    allRolled: need.length > 0 && need.every((id) => rolled.has(id)),
  };
}
/** True se tutti i giocatori vivi e connessi hanno lanciato. */
function allRolled(room) {
  if (!room.game) return false;
  const gameState = room.game.publicState();
  const need = mustRollIds(room, gameState);
  const rolled = room.rolled || new Set();
  return need.length > 0 && need.every((id) => rolled.has(id));
}

/** Giocatori ancora VIVI ma assenti (disconnessi/abbandonati): mettono in pausa. */
function absentPlayers(room) {
  if (!room.game || room.status !== 'playing') return [];
  const gs = room.game.publicState();
  const aliveIds = new Set(gs.players.filter((p) => p.alive).map((p) => p.id));
  return room.players.filter((p) => aliveIds.has(p.id) && !p.connected);
}
/** La partita è in pausa se manca all'appello un giocatore vivo. */
function isPaused(room) {
  return room.status === 'playing' && absentPlayers(room).length > 0;
}
/** Se il round precedente era in rivelazione e la pausa l'ha congelato, riprende. */
function maybeResume(room) {
  if (
    room.game &&
    !isPaused(room) &&
    room._revealPending &&
    room.game.phase === 'reveal'
  ) {
    room._revealPending = false;
    scheduleNextRound(room);
  }
}

/** Invia a tutti lo stato pubblico e a ciascuno i propri dadi privati.
 *  Gli eliminati ricevono anche i dadi di tutti i vivi (modalità spettatore). */
function broadcastRoom(room) {
  const payload = roomStatePayload(room);
  io.to(room.code).emit('state', payload);

  if (room.game && (room.game.phase === 'bidding')) {
    const allDice = room.game.players
      .filter((gp) => gp.alive)
      .map((gp) => ({ id: gp.id, dice: gp.dice }));
    for (const p of room.players) {
      if (p.connected && p.socketId) {
        io.to(p.socketId).emit('yourDice', { dice: room.game.diceFor(p.id) });
        const gp = room.game.players.find((x) => x.id === p.id);
        if (gp && !gp.alive) {
          io.to(p.socketId).emit('spectatorDice', {
            round: room.game.roundNumber,
            players: allDice,
          });
        }
      }
    }
  }
  pumpBots(room);
}

// ==================== BOT: guida del tavolo ====================
// Dopo OGNI broadcast, pumpBots pianifica AL PIÙ un'azione bot (con ritardo
// "umano"). L'azione, una volta eseguita, ri-broadcasta → la pompa riparte.
// Al momento dell'esecuzione lo stato viene sempre ri-validato: se nel
// frattempo un umano ha mosso, l'azione decade senza effetti.

function isBotId(room, id) {
  const p = room.players.find((x) => x.id === id);
  return !!(p && p.isBot);
}

/** La "vista" del bot: SOLO i suoi dadi + informazioni pubbliche del tavolo. */
function botView(room, botId) {
  const g = room.game;
  const gp = g.players.find((p) => p.id === botId);
  return {
    myDice: gp ? gp.dice : [],
    totalDice: g.players.reduce((s, p) => s + p.diceCount, 0),
    currentBid: g.currentBid
      ? { quantity: g.currentBid.quantity, face: g.currentBid.face }
      : null,
    wild: g.wildActive(),
    palifico: g.palifico,
    lockedFace: g.lockedFace,
    canChangeFace: !!(gp && gp.diceCount === 1),
  };
}

/** Post-passi di una mossa che può chiudere il round (dubito/calza). */
function afterBotMove(room) {
  if (room.game.phase === 'gameOver') {
    room.status = 'finished';
  } else if (room.game.phase === 'reveal') {
    room.readyNext = new Set();
  }
  broadcastRoom(room);
  if (room.game && room.game.phase === 'reveal') {
    scheduleNextRound(room);
  }
}

/** Decide la prossima azione bot da pianificare (o null). */
function planNextBotAction(room) {
  const g = room.game;
  const brains = room.botBrains || {};

  if (g.phase === 'reveal') {
    // I bot si dichiarano "pronti" con calma: il ritmo lo detta l'umano.
    const active = activePlayerIds(room);
    const waiting = active.filter(
      (id) => isBotId(room, id) && !(room.readyNext && room.readyNext.has(id))
    );
    if (!waiting.length) return null;
    const id = waiting[0];
    return {
      delay: bots.thinkDelay(brains[id], 'ready'),
      run: () => {
        if (!room.game || room.game.phase !== 'reveal') return pumpBots(room);
        if (!room.readyNext) room.readyNext = new Set();
        room.readyNext.add(id);
        const act = activePlayerIds(room);
        const allReady = act.length > 0 && act.every((x) => room.readyNext.has(x));
        if (allReady) {
          if (room._revealTimer) {
            clearTimeout(room._revealTimer);
            room._revealTimer = null;
          }
          room.game.startNextRound();
          room.readyNext = new Set();
          room.rolled = new Set();
          room.bidLog = [];
        }
        broadcastRoom(room);
      },
    };
  }

  if (g.phase !== 'bidding') return null;
  const gs = g.publicState();

  // 1) Lanci: un bot alla volta "scuote il bicchiere".
  const toRoll = mustRollIds(room, gs).filter(
    (id) => isBotId(room, id) && !(room.rolled && room.rolled.has(id))
  );
  if (toRoll.length) {
    const id = toRoll[0];
    return {
      delay: bots.thinkDelay(brains[id], 'roll'),
      run: () => {
        if (!room.game || room.game.phase !== 'bidding') return pumpBots(room);
        if (!room.rolled) room.rolled = new Set();
        room.rolled.add(id);
        broadcastRoom(room);
      },
    };
  }

  // 2) Scelta Palifico in sospeso di un bot.
  if (g.palificoPending && isBotId(room, g.palificoPendingId)) {
    const id = g.palificoPendingId;
    const pers = brains[id];
    return {
      delay: bots.thinkDelay(pers, 'palifico'),
      run: () => {
        if (!room.game || !room.game.palificoPending || room.game.palificoPendingId !== id) {
          return pumpBots(room);
        }
        room.game.choosePalifico(id, bots.choosePalificoBot(pers));
        broadcastRoom(room);
      },
    };
  }

  if (!allRolled(room) || g.palificoPending) return null;

  // 3) Calza fuori turno (modalità calza): ogni dichiarazione viene valutata
  //    UNA volta; il primo bot convinto ci prova (anti-stale già nell'engine).
  if (room.mode === 'calza' && g.currentBid && !g.palifico) {
    const bidKey =
      g.roundNumber + ':' + g.currentBid.quantity + 'x' + g.currentBid.face + ':' + g.currentBid.playerId;
    if (room._calzaEval !== bidKey) {
      room._calzaEval = bidKey;
      const turnP = g.currentPlayer();
      const cands = room.players.filter((p) => p.isBot).sort(() => Math.random() - 0.5);
      for (const p of cands) {
        const gp = g.players.find((x) => x.id === p.id);
        if (!gp || !gp.alive || gp.diceCount >= g.dicePerPlayer) continue;
        if (p.id === g.currentBid.playerId) continue;
        if (g.calzaRule === 'official' && turnP && p.id === turnP.id) continue;
        if (!bots.considerCalza(botView(room, p.id), brains[p.id])) continue;
        const expected = { quantity: g.currentBid.quantity, face: g.currentBid.face };
        return {
          delay: bots.thinkDelay(brains[p.id], 'calza'),
          run: () => {
            if (!room.game) return;
            const res = room.game.calza(p.id, expected);
            if (res.ok) afterBotMove(room);
            else pumpBots(room);
          },
        };
      }
    }
  }

  // 4) Turno di un bot: dubita o rilancia.
  const turn = g.currentPlayer();
  if (turn && turn.alive && isBotId(room, turn.id)) {
    const pers = brains[turn.id];
    const bidBefore = g.currentBid
      ? g.currentBid.quantity + 'x' + g.currentBid.face
      : 'open';
    return {
      delay: bots.thinkDelay(pers, 'turn'),
      run: () => {
        const g2 = room.game;
        if (!g2 || g2.phase !== 'bidding' || g2.palificoPending) return pumpBots(room);
        const t2 = g2.currentPlayer();
        const bidNow = g2.currentBid ? g2.currentBid.quantity + 'x' + g2.currentBid.face : 'open';
        if (!t2 || t2.id !== turn.id || bidNow !== bidBefore) return pumpBots(room);

        const view = botView(room, turn.id);
        let action = bots.chooseTurnAction(view, pers);
        if (action.type === 'doubt' && !g2.currentBid) action = bots.fallbackAction(view);

        let res;
        if (action.type === 'doubt') {
          res = g2.challenge(turn.id);
        } else {
          res = g2.placeBid(turn.id, action.quantity, action.face);
          if (!res.ok) {
            const fb = bots.fallbackAction(view);
            action = fb;
            res = g2.placeBid(turn.id, fb.quantity, fb.face);
          }
          if (!res.ok && g2.currentBid) {
            action = { type: 'doubt' };
            res = g2.challenge(turn.id);
          }
          if (res.ok && action.type === 'bid') {
            if (!room.bidLog) room.bidLog = [];
            room.bidLog.push({ name: turn.name, quantity: action.quantity, face: action.face });
          }
        }
        if (!res || !res.ok) return pumpBots(room);
        afterBotMove(room);
      },
    };
  }

  return null;
}

/** Pianifica (o ri-pianifica) la prossima azione bot della stanza. */
function pumpBots(room) {
  if (!room || !room.players.some((p) => p.isBot)) return;
  if (room._botTimer) {
    clearTimeout(room._botTimer);
    room._botTimer = null;
  }
  if (room.status !== 'playing' || !room.game || isPaused(room)) return;
  const plan = planNextBotAction(room);
  if (!plan) return;
  room._botTimer = setTimeout(() => {
    room._botTimer = null;
    if (manager.getRoom(room.code) !== room) return; // stanza chiusa nel frattempo
    if (room.status !== 'playing' || !room.game || isPaused(room)) return;
    plan.run();
  }, plan.delay);
  room._botTimer.unref && room._botTimer.unref();
}

/** Pianifica il passaggio al round successivo dopo la rivelazione. */
function scheduleNextRound(room) {
  if (room._revealTimer) return;
  room._revealTimer = setTimeout(() => {
    room._revealTimer = null;
    if (!room.game || room.game.phase !== 'reveal') return;
    // Se qualcuno è assente, congela: riprenderà al rientro (maybeResume).
    if (isPaused(room)) {
      room._revealPending = true;
      return;
    }
    room.game.startNextRound();
    room.readyNext = new Set();
    room.rolled = new Set();
    room.bidLog = [];
    broadcastRoom(room);
  }, REVEAL_MS);
  room._revealTimer.unref && room._revealTimer.unref();
}

function ack(cb, data) {
  if (typeof cb === 'function') cb(data);
}

io.on('connection', (socket) => {
  // --- Creazione tavolo (host) ---
  socket.on('createRoom', ({ hostName, dicePerPlayer, mode, calzaRule, bots } = {}, cb) => {
    const res = manager.createRoom(hostName, dicePerPlayer, mode, calzaRule, bots);
    if (res.error) return ack(cb, { ok: false, error: res.error });
    const { room, player } = res;
    player.socketId = socket.id;
    socket.data = { code: room.code, playerId: player.id };
    socket.join(room.code);
    ack(cb, { ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastRoom(room);
  });

  // --- Ingresso a un tavolo ---
  socket.on('joinRoom', ({ roomCode, name } = {}, cb) => {
    const res = manager.joinRoom(roomCode, name);
    if (res.error) return ack(cb, { ok: false, error: res.error });
    const { room, player } = res;
    player.socketId = socket.id;
    socket.data = { code: room.code, playerId: player.id };
    socket.join(room.code);
    ack(cb, {
      ok: true,
      code: room.code,
      playerId: player.id,
      token: player.token,
      isHost: player.isHost,
    });
    socket.emit('chatHistory', room.chat || []);
    // Se subentra a un posto vacante, la partita può riprendere.
    if (res.reclaimed) maybeResume(room);
    broadcastRoom(room);
    // Ai rientri in partita reinvio i dadi privati durante il bidding.
    if (res.reclaimed && room.game && room.game.phase === 'bidding') {
      socket.emit('yourDice', { dice: room.game.diceFor(player.id) });
    }
  });

  // --- Reconnect (dopo refresh/disconnessione) ---
  socket.on('reconnectPlayer', ({ roomCode, token } = {}, cb) => {
    const res = manager.reconnect(roomCode, token);
    if (res.error) return ack(cb, { ok: false, error: res.error });
    const { room, player } = res;
    player.socketId = socket.id;
    socket.data = { code: room.code, playerId: player.id };
    socket.join(room.code);
    ack(cb, { ok: true, code: room.code, playerId: player.id, isHost: player.isHost });
    // Reinvio subito lo stato + i dadi privati + lo storico chat a chi rientra.
    socket.emit('chatHistory', room.chat || []);
    maybeResume(room);
    broadcastRoom(room);
    socket.emit('state', roomStatePayload(room));
    if (room.game && room.game.phase === 'bidding') {
      socket.emit('yourDice', { dice: room.game.diceFor(player.id) });
    }
  });

  // --- Avvio partita (host) ---
  socket.on('startGame', (_data, cb) => {
    const ctx = socket.data || {};
    const res = manager.startGame(ctx.code, ctx.playerId);
    if (res.error) return ack(cb, { ok: false, error: res.error });
    ack(cb, { ok: true });
    broadcastRoom(res.room);
  });

  // --- Dichiarazione (rilancio) ---
  socket.on('placeBid', ({ quantity, face } = {}, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room || !room.game) return ack(cb, { ok: false, error: 'Partita non attiva.' });
    if (isPaused(room)) {
      return ack(cb, { ok: false, error: 'Partita in pausa: si attende il rientro di un giocatore.' });
    }
    if (!allRolled(room)) {
      return ack(cb, { ok: false, error: 'Aspetta che tutti lancino i dadi.' });
    }
    const res = room.game.placeBid(ctx.playerId, quantity, face);
    if (!res.ok) return ack(cb, { ok: false, error: res.reason });
    // Registra la dichiarazione nello storico del round.
    if (!room.bidLog) room.bidLog = [];
    const p = room.players.find((pl) => pl.id === ctx.playerId);
    room.bidLog.push({ name: p ? p.name : '?', quantity: quantity | 0, face: face | 0 });
    ack(cb, { ok: true });
    broadcastRoom(room);
  });

  // --- "Dubito" ---
  socket.on('challenge', (_data, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room || !room.game) return ack(cb, { ok: false, error: 'Partita non attiva.' });
    if (isPaused(room)) {
      return ack(cb, { ok: false, error: 'Partita in pausa: si attende il rientro di un giocatore.' });
    }
    if (!allRolled(room)) {
      return ack(cb, { ok: false, error: 'Aspetta che tutti lancino i dadi.' });
    }
    const res = room.game.challenge(ctx.playerId);
    if (!res.ok) return ack(cb, { ok: false, error: res.reason });
    ack(cb, { ok: true });

    if (room.game.phase === 'gameOver') {
      room.status = 'finished';
    } else if (room.game.phase === 'reveal') {
      room.readyNext = new Set();
    }
    broadcastRoom(room);
    if (room.game.phase === 'reveal') {
      scheduleNextRound(room);
    }
  });

  // --- "Calza" (modalità calza): azione FUORI turno, senza controllo di turno ---
  socket.on('calza', ({ expectedBid } = {}, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room || !room.game) return ack(cb, { ok: false, error: 'Partita non attiva.' });
    if (isPaused(room)) {
      return ack(cb, { ok: false, error: 'Partita in pausa: si attende il rientro di un giocatore.' });
    }
    if (!allRolled(room)) {
      return ack(cb, { ok: false, error: 'Aspetta che tutti lancino i dadi.' });
    }
    const res = room.game.calza(ctx.playerId, expectedBid);
    if (!res.ok) return ack(cb, { ok: false, error: res.reason });
    ack(cb, { ok: true });

    if (room.game.phase === 'gameOver') {
      room.status = 'finished';
    } else if (room.game.phase === 'reveal') {
      room.readyNext = new Set();
    }
    broadcastRoom(room);
    if (room.game.phase === 'reveal') {
      scheduleNextRound(room);
    }
  });

  // --- Scelta Palifico (l'apertura con 1 dado decide se attivarlo) ---
  socket.on('choosePalifico', ({ activate } = {}, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room || !room.game) return ack(cb, { ok: false, error: 'Partita non attiva.' });
    const res = room.game.choosePalifico(ctx.playerId, !!activate);
    if (!res.ok) return ack(cb, { ok: false, error: res.reason });
    ack(cb, { ok: true });
    broadcastRoom(room);
  });

  // --- "Procedi": il giocatore è pronto al round successivo ---
  socket.on('readyNext', (_data, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room || !room.game || room.game.phase !== 'reveal') {
      return ack(cb, { ok: false });
    }
    if (isPaused(room)) return ack(cb, { ok: false });
    if (!room.readyNext) room.readyNext = new Set();
    room.readyNext.add(ctx.playerId);
    ack(cb, { ok: true });

    // Contano solo i giocatori attivi (vivi e connessi): gli eliminati no.
    const active = activePlayerIds(room);
    const allReady = active.length > 0 && active.every((id) => room.readyNext.has(id));
    if (allReady) {
      if (room._revealTimer) {
        clearTimeout(room._revealTimer);
        room._revealTimer = null;
      }
      room.game.startNextRound();
      room.readyNext = new Set();
      room.rolled = new Set();
      room.bidLog = [];
    }
    broadcastRoom(room);
  });

  // --- Lancio dei dadi: il giocatore "scuote il bicchiere" ---
  socket.on('rollDice', (_data, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room || !room.game || room.game.phase !== 'bidding') {
      return ack(cb, { ok: false });
    }
    if (isPaused(room)) return ack(cb, { ok: false });
    if (!room.rolled) room.rolled = new Set();
    room.rolled.add(ctx.playerId);
    ack(cb, { ok: true });
    broadcastRoom(room);
  });

  // --- Chat del tavolo ---
  socket.on('chat', ({ text } = {}, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room) return ack(cb, { ok: false });
    const player = room.players.find((p) => p.id === ctx.playerId);
    if (!player) return ack(cb, { ok: false });
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_LEN);
    if (!clean) return ack(cb, { ok: false });
    const msg = { playerId: player.id, name: player.name, text: clean, ts: Date.now() };
    if (!room.chat) room.chat = [];
    room.chat.push(msg);
    if (room.chat.length > CHAT_HISTORY) room.chat = room.chat.slice(-CHAT_HISTORY);
    ack(cb, { ok: true });
    io.to(room.code).emit('chatMessage', msg);
  });

  // --- Termina (host): chiude ed elimina completamente il tavolo ---
  socket.on('endGame', (_data, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room) return ack(cb, { ok: false, error: 'Tavolo non trovato.' });
    if (ctx.playerId !== room.hostId) {
      return ack(cb, { ok: false, error: 'Solo l\'host può chiudere il tavolo.' });
    }
    if (room._revealTimer) {
      clearTimeout(room._revealTimer);
      room._revealTimer = null;
    }
    ack(cb, { ok: true });
    // Avvisa tutti (guest compresi) che il tavolo è chiuso, poi lo elimina.
    io.to(room.code).emit('tableClosed');
    manager.deleteRoom(room.code);
  });

  // --- Rivincita (host): nuova partita con chi è al tavolo ---
  socket.on('rematch', (_data, cb) => {
    const ctx = socket.data || {};
    const res = manager.rematch(ctx.code, ctx.playerId);
    if (res.error) return ack(cb, { ok: false, error: res.error });
    ack(cb, { ok: true });
    broadcastRoom(res.room);
  });

  // --- Abbandona (guest): lascia il tavolo; in partita mette in pausa ---
  socket.on('leaveTable', (_data, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room) return ack(cb, { ok: true });
    if (ctx.playerId === room.hostId) {
      return ack(cb, { ok: false, error: 'L\'host usa "Termina" per chiudere il tavolo.' });
    }
    const res = manager.leaveTable(ctx.code, ctx.playerId);
    socket.leave(room.code);
    socket.data = {};
    ack(cb, { ok: true });
    if (!res.error) broadcastRoom(room);
  });

  // --- Aggiunta bot (host, solo in lobby) ---
  socket.on('addBot', (_data, cb) => {
    const ctx = socket.data || {};
    const res = manager.addBot(ctx.code, ctx.playerId);
    if (res.error) return ack(cb, { ok: false, error: res.error });
    ack(cb, { ok: true });
    broadcastRoom(res.room);
  });

  // --- Espulsione giocatore (host, solo in lobby) ---
  socket.on('kickPlayer', ({ playerId } = {}, cb) => {
    const ctx = socket.data || {};
    const room = manager.getRoom(ctx.code);
    if (!room) return ack(cb, { ok: false, error: 'Tavolo non trovato.' });
    if (ctx.playerId !== room.hostId) {
      return ack(cb, { ok: false, error: 'Solo l\'host può espellere.' });
    }
    if (room.status !== 'lobby') {
      return ack(cb, { ok: false, error: 'Puoi espellere solo prima dell\'avvio.' });
    }
    const target = room.players.find((p) => p.id === playerId);
    room.players = room.players.filter((p) => p.id !== playerId);
    ack(cb, { ok: true });
    if (target && target.socketId) {
      io.to(target.socketId).emit('kicked');
    }
    broadcastRoom(room);
  });

  // --- Disconnessione ---
  socket.on('disconnect', () => {
    const ctx = socket.data || {};
    if (!ctx.code) return;
    const room = manager.getRoom(ctx.code);
    if (!room) return;
    // Passa il socket.id: se il giocatore ha già una connessione più recente,
    // questo disconnect "vecchio" viene ignorato e la partita non si ri-blocca.
    const changed = manager.markDisconnected(ctx.code, ctx.playerId, socket.id);
    if (changed) broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Perudo online in ascolto sulla porta ${PORT}`);
});

module.exports = { app, server };
