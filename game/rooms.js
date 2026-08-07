'use strict';

/**
 * rooms.js — RoomManager: gestisce i tavoli (stanze) in memoria.
 *
 * Ogni stanza ha un codice breve condivisibile. I giocatori ricevono un `token`
 * segreto (salvato lato client in localStorage) che permette il RECONNECT dopo
 * un refresh o una disconnessione temporanea del telefono.
 *
 * Nessun database: se il server riavvia, le partite in corso si perdono
 * (accettabile per partite occasionali).
 */

const crypto = require('crypto');
const { Game } = require('./engine');

// Alfabeto senza caratteri ambigui (niente 0/O/1/I) per i codici stanza.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;

// Le stanze vuote da piu' di questo tempo vengono rimosse.
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000; // 30 minuti

function randomCode() {
  let out = '';
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

class RoomManager {
  constructor() {
    /** @type {Map<string, object>} code -> room */
    this.rooms = new Map();
  }

  _freshCode() {
    let code;
    let tries = 0;
    do {
      code = randomCode();
      tries += 1;
    } while (this.rooms.has(code) && tries < 50);
    return code;
  }

  createRoom(hostName, dicePerPlayer) {
    const name = sanitizeName(hostName);
    if (!name) return { error: 'Inserisci un nome.' };
    const dice = Math.max(1, Math.min(5, parseInt(dicePerPlayer, 10) || 5));
    const code = this._freshCode();
    const host = {
      id: newId(),
      token: newToken(),
      name,
      isHost: true,
      connected: true,
    };
    const room = {
      code,
      dicePerPlayer: dice,
      status: 'lobby', // 'lobby' | 'playing' | 'finished'
      players: [host],
      game: null,
      hostId: host.id,
      emptySince: null,
      rolled: new Set(), // chi ha "lanciato" i dadi nel round corrente
      chat: [], // storico messaggi
    };
    this.rooms.set(code, room);
    return { room, player: host };
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').toUpperCase()) || null;
  }

  joinRoom(code, name) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Tavolo non trovato. Controlla il codice.' };
    if (room.status !== 'lobby') {
      return { error: 'La partita è già iniziata.' };
    }
    if (room.players.length >= MAX_PLAYERS) {
      return { error: `Tavolo pieno (max ${MAX_PLAYERS} giocatori).` };
    }
    const cleanName = sanitizeName(name);
    if (!cleanName) return { error: 'Inserisci un nome.' };
    if (room.players.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return { error: 'Nome già in uso a questo tavolo.' };
    }
    const player = {
      id: newId(),
      token: newToken(),
      name: cleanName,
      isHost: false,
      connected: true,
    };
    room.players.push(player);
    room.emptySince = null;
    return { room, player };
  }

  /** Reconnect tramite token segreto (dopo refresh/disconnessione). */
  reconnect(code, token) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Tavolo non più disponibile.' };
    const player = room.players.find((p) => p.token === token);
    if (!player) return { error: 'Sessione non valida per questo tavolo.' };
    player.connected = true;
    room.emptySince = null;
    return { room, player };
  }

  startGame(code, requesterId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Tavolo non trovato.' };
    if (requesterId !== room.hostId) {
      return { error: 'Solo l\'host può avviare la partita.' };
    }
    if (room.status !== 'lobby') {
      return { error: 'La partita è già iniziata.' };
    }
    if (room.players.length < MIN_PLAYERS) {
      return { error: `Servono almeno ${MIN_PLAYERS} giocatori.` };
    }
    const seats = room.players.map((p) => ({ id: p.id, name: p.name }));
    room.game = new Game(seats, room.dicePerPlayer);
    room.rolled = new Set(); // nuovo round: nessuno ha ancora lanciato
    room.status = 'playing';
    return { room };
  }

  /** Marca un giocatore come disconnesso (senza rimuoverlo: puo' rientrare). */
  markDisconnected(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    if (player) player.connected = false;

    // In lobby, un giocatore non-host disconnesso viene rimosso dalla lista.
    if (room.status === 'lobby' && player && !player.isHost) {
      room.players = room.players.filter((p) => p.id !== playerId);
    }

    if (room.players.every((p) => !p.connected)) {
      room.emptySince = Date.now();
    }
  }

  /** Rimuove le stanze vuote scadute (chiamata periodica). */
  cleanup(now) {
    const cutoff = (now || Date.now()) - EMPTY_ROOM_TTL_MS;
    for (const [code, room] of this.rooms) {
      if (room.emptySince && room.emptySince < cutoff) {
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { RoomManager, MAX_PLAYERS, MIN_PLAYERS };
