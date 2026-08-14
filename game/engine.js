'use strict';

/**
 * engine.js — Logica PURA del Perudo.
 *
 * Nessuna dipendenza da socket/rete: qui vivono solo lo stato del gioco e le
 * regole. Questo rende la parte piu' delicata (validazione rilancio + conteggio
 * del "dubito") facilmente testabile.
 *
 * Regole (fedeli al testo di Jacopo, senza jolly):
 *  - Ogni giocatore parte con `dicePerPlayer` dadi (1..5), nascosti.
 *  - Una dichiarazione = { quantity, face }. Rilancio valido se:
 *        quantita' maggiore  (con qualsiasi valore 1..6)
 *        oppure stessa quantita' ma valore piu' alto.
 *  - "Dubito": si scoprono tutti i dadi e si contano quelli col valore
 *    dichiarato su TUTTO il tavolo.
 *        conteggio >= quantita'  -> dichiarazione vera  -> chi ha dubitato perde 1 dado
 *        altrimenti               -> dichiarazione falsa -> chi ha dichiarato perde 1 dado
 *  - A 0 dadi si e' eliminati. Vince l'ultimo rimasto.
 *  - Round 1: starter casuale. Round successivi: apre chi ha dubitato nel
 *    round appena concluso (se eliminato, il primo giocatore vivo dopo di lui).
 */

const MIN_FACE = 1;
const MAX_FACE = 6;

function defaultRng() {
  return Math.random();
}

/** Tira un dado 1..6 usando l'rng iniettato (per test deterministici). */
function rollDie(rng) {
  return Math.floor(rng() * 6) + 1;
}

/**
 * Verifica se `next` e' un rilancio valido rispetto a `current`.
 * Se `current` e' null (prima dichiarazione del round) basta che sia ben formato.
 * Ritorna { ok: boolean, reason?: string }.
 */
function validateBid(current, next) {
  if (!next || !Number.isInteger(next.quantity) || !Number.isInteger(next.face)) {
    return { ok: false, reason: 'Dichiarazione non valida.' };
  }
  if (next.quantity < 1) {
    return { ok: false, reason: 'La quantità deve essere almeno 1.' };
  }
  if (next.face < MIN_FACE || next.face > MAX_FACE) {
    return { ok: false, reason: 'Il valore del dado deve essere tra 1 e 6.' };
  }
  if (!current) {
    return { ok: true };
  }
  const higherQuantity = next.quantity > current.quantity;
  const sameQuantityHigherFace =
    next.quantity === current.quantity && next.face > current.face;
  if (higherQuantity || sameQuantityHigherFace) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'Rilancio non valido: aumenta la quantità, oppure mantieni la quantità ma alza il valore.',
  };
}

/** Conta i dadi col valore `face` su tutti i giocatori (vivi) del tavolo. */
function countFace(players, face) {
  let total = 0;
  for (const p of players) {
    if (!p.alive) continue;
    for (const d of p.dice) {
      if (d === face) total += 1;
    }
  }
  return total;
}

class Game {
  /**
   * @param {Array<{id:string,name:string}>} seats  giocatori in ordine di posto
   * @param {number} dicePerPlayer  dadi iniziali a testa (1..5)
   * @param {object} [opts]
   * @param {() => number} [opts.rng]  generatore casuale (0..1) iniettabile
   * @param {number} [opts.starterIndex]  indice dello starter del primo round
   */
  constructor(seats, dicePerPlayer, opts = {}) {
    this.rng = opts.rng || defaultRng;
    this.dicePerPlayer = Math.max(1, Math.min(5, dicePerPlayer | 0));
    this.players = seats.map((s) => ({
      id: s.id,
      name: s.name,
      diceCount: this.dicePerPlayer,
      dice: [],
      alive: true,
    }));
    this.phase = 'bidding'; // 'bidding' | 'reveal' | 'gameOver'
    this.currentBid = null; // { quantity, face, playerId }
    this.lastResult = null;
    this.winnerId = null;
    this.roundNumber = 0;

    const start =
      Number.isInteger(opts.starterIndex) &&
      opts.starterIndex >= 0 &&
      opts.starterIndex < this.players.length
        ? opts.starterIndex
        : Math.floor(this.rng() * this.players.length);
    this.roundStarterIndex = start;
    this.turnIndex = start;
    this._doubterIndex = start; // default finché non c'è un "dubito"
    this._roll();
    this.roundNumber = 1;
  }

  /** Indice del prossimo giocatore vivo (senso di gioco), partendo da from incluso. */
  _nextAliveFrom(from) {
    const n = this.players.length;
    for (let step = 0; step < n; step += 1) {
      const idx = (from + step) % n;
      if (this.players[idx].alive) return idx;
    }
    return -1;
  }

  /** Indice del prossimo giocatore vivo dopo `from` (escluso). */
  _nextAliveAfter(from) {
    return this._nextAliveFrom((from + 1) % this.players.length);
  }

  _aliveCount() {
    return this.players.filter((p) => p.alive).length;
  }

  _roll() {
    for (const p of this.players) {
      if (!p.alive) {
        p.dice = [];
        continue;
      }
      p.dice = Array.from({ length: p.diceCount }, () => rollDie(this.rng));
    }
  }

  currentPlayer() {
    return this.players[this.turnIndex] || null;
  }

  /**
   * Piazza una dichiarazione (rilancio). Ritorna { ok, reason? }.
   */
  placeBid(playerId, quantity, face) {
    if (this.phase !== 'bidding') {
      return { ok: false, reason: 'Non è il momento di dichiarare.' };
    }
    const player = this.currentPlayer();
    if (!player || player.id !== playerId) {
      return { ok: false, reason: 'Non è il tuo turno.' };
    }
    const bid = { quantity: quantity | 0, face: face | 0 };
    const check = validateBid(this.currentBid, bid);
    if (!check.ok) return check;

    this.currentBid = { ...bid, playerId };
    this.turnIndex = this._nextAliveAfter(this.turnIndex);
    return { ok: true };
  }

  /**
   * "Dubito": chi e' di turno dubita dell'ultima dichiarazione.
   * Scopre i dadi, conta, assegna la perdita del dado e prepara la fase reveal.
   * Ritorna { ok, reason? }.
   */
  challenge(playerId) {
    if (this.phase !== 'bidding') {
      return { ok: false, reason: 'Non è il momento di dubitare.' };
    }
    if (!this.currentBid) {
      return { ok: false, reason: "Non c'è ancora una dichiarazione da contestare." };
    }
    const challenger = this.currentPlayer();
    if (!challenger || challenger.id !== playerId) {
      return { ok: false, reason: 'Non è il tuo turno.' };
    }

    // Il round successivo lo aprirà chi ha dubitato (salvo eliminazione).
    this._doubterIndex = this.turnIndex;

    const bid = this.currentBid;
    const bidder = this.players.find((p) => p.id === bid.playerId);
    const actualCount = countFace(this.players, bid.face);
    const bidWasTrue = actualCount >= bid.quantity;

    // Chi ha dubitato correttamente sopravvive; l'altro perde un dado.
    const loser = bidWasTrue ? challenger : bidder;
    loser.diceCount -= 1;
    if (loser.diceCount <= 0) {
      loser.diceCount = 0;
      loser.alive = false;
    }

    // Snapshot dei dadi rivelati (per la schermata di rivelazione).
    const reveal = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      dice: [...p.dice],
      diceCount: p.diceCount,
      alive: p.alive,
    }));

    this.lastResult = {
      bid: { quantity: bid.quantity, face: bid.face },
      bidderId: bidder ? bidder.id : null,
      bidderName: bidder ? bidder.name : null,
      challengerId: challenger.id,
      challengerName: challenger.name,
      actualCount,
      bidWasTrue,
      loserId: loser.id,
      loserName: loser.name,
      loserEliminated: !loser.alive,
      reveal,
    };

    if (this._aliveCount() <= 1) {
      const winner = this.players.find((p) => p.alive) || null;
      this.winnerId = winner ? winner.id : null;
      this.lastResult.winnerId = this.winnerId;
      this.lastResult.winnerName = winner ? winner.name : null;
      this.phase = 'gameOver';
    } else {
      this.phase = 'reveal';
    }
    return { ok: true };
  }

  /**
   * Passa dalla fase 'reveal' al round successivo: apre chi ha dubitato (o, se
   * è stato eliminato, il primo giocatore vivo dopo di lui), ritiro dei dadi,
   * fase bidding. Ritorna { ok, reason? }.
   */
  startNextRound() {
    if (this.phase !== 'reveal') {
      return { ok: false, reason: 'Nessun round da avviare.' };
    }
    // Apre il round chi ha dubitato; se eliminato, il prossimo vivo in gioco.
    const from = Number.isInteger(this._doubterIndex)
      ? this._doubterIndex
      : this.roundStarterIndex;
    this.roundStarterIndex = this._nextAliveFrom(from);
    this.turnIndex = this.roundStarterIndex;
    this.currentBid = null;
    this._roll();
    this.roundNumber += 1;
    this.phase = 'bidding';
    return { ok: true };
  }

  /** Stato PUBBLICO: nessun dado nascosto (tranne durante reveal/gameOver). */
  publicState() {
    const revealing = this.phase === 'reveal' || this.phase === 'gameOver';
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      dicePerPlayer: this.dicePerPlayer,
      currentBid: this.currentBid
        ? { quantity: this.currentBid.quantity, face: this.currentBid.face, playerId: this.currentBid.playerId }
        : null,
      turnPlayerId: this.currentPlayer() ? this.currentPlayer().id : null,
      starterPlayerId: this.players[this.roundStarterIndex]
        ? this.players[this.roundStarterIndex].id
        : null,
      winnerId: this.winnerId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        diceCount: p.diceCount,
        alive: p.alive,
        // I dadi si vedono solo in rivelazione/fine partita.
        dice: revealing ? [...p.dice] : null,
      })),
    };
  }

  /** I dadi privati di un singolo giocatore (da inviare solo a lui). */
  diceFor(playerId) {
    const p = this.players.find((x) => x.id === playerId);
    return p ? [...p.dice] : [];
  }
}

module.exports = { Game, validateBid, countFace, rollDie };
