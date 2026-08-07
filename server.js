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
    };
  });
  const absent = absentPlayers(room);
  return {
    code: room.code,
    status: room.status,
    dicePerPlayer: room.dicePerPlayer,
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
          lastResult: room.game.lastResult || null,
          ready: readyInfo(room, gameState),
          rolling: rollingInfo(room, gameState),
        }
      : null,
  };
}

/** Info sui giocatori "pronti" a proseguire (solo durante la rivelazione). */
function readyInfo(room, gameState) {
  if (!gameState || gameState.phase !== 'reveal') return null;
  const connectedIds = room.players.filter((p) => p.connected).map((p) => p.id);
  const readyIds = [...(room.readyNext || [])].filter((id) => connectedIds.includes(id));
  return { readyIds, total: connectedIds.length };
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

/** Invia a tutti lo stato pubblico e a ciascuno i propri dadi privati. */
function broadcastRoom(room) {
  const payload = roomStatePayload(room);
  io.to(room.code).emit('state', payload);

  if (room.game && (room.game.phase === 'bidding')) {
    for (const p of room.players) {
      if (p.connected && p.socketId) {
        io.to(p.socketId).emit('yourDice', { dice: room.game.diceFor(p.id) });
      }
    }
  }
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
    broadcastRoom(room);
  }, REVEAL_MS);
  room._revealTimer.unref && room._revealTimer.unref();
}

function ack(cb, data) {
  if (typeof cb === 'function') cb(data);
}

io.on('connection', (socket) => {
  // --- Creazione tavolo (host) ---
  socket.on('createRoom', ({ hostName, dicePerPlayer } = {}, cb) => {
    const res = manager.createRoom(hostName, dicePerPlayer);
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

    const connectedIds = room.players.filter((p) => p.connected).map((p) => p.id);
    const allReady = connectedIds.length > 0 && connectedIds.every((id) => room.readyNext.has(id));
    if (allReady) {
      if (room._revealTimer) {
        clearTimeout(room._revealTimer);
        room._revealTimer = null;
      }
      room.game.startNextRound();
      room.readyNext = new Set();
      room.rolled = new Set();
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
    manager.markDisconnected(ctx.code, ctx.playerId);
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Perudo online in ascolto sulla porta ${PORT}`);
});

module.exports = { app, server };
