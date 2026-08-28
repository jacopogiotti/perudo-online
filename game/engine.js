'use strict';

/**
 * engine.js — Logica PURA del Perudo (Standard / Jolly / Calza).
 *
 * Nessuna dipendenza da socket/rete: qui vivono solo lo stato del gioco e le
 * regole. La parte piu' delicata (validazione rilancio + conteggio) sta in
 * funzioni pure testabili.
 *
 * Modalità:
 *  - 'standard': niente jolly, niente palifico, niente calza (comportamento base).
 *  - 'jolly'   : gli 1 sono jolly (wild), più il Palifico.
 *  - 'calza'   : come jolly, più l'azione "Calza" (dichiarazione esatta).
 *
 * Regole base (Standard):
 *  - Rilancio valido = quantità maggiore (valore qualsiasi) oppure stessa
 *    quantità con valore più alto. "Dubito" scopre i dadi e conta.
 *  - A 0 dadi si è eliminati. Vince l'ultimo rimasto.
 *  - Round 1: starter casuale. Poi apre chi ha perso il dado (o chi ha calzato);
 *    se eliminato, il primo giocatore vivo dopo di lui.
 *
 * Jolly (round normali delle modalità jolly/calza):
 *  - L'1 vale come qualsiasi valore dichiarato (conteggio: faccia + 1).
 *  - Non si può APRIRE dichiarando gli 1.
 *  - Conversioni: numero→1 = ceil(q/2); 1→numero = q*2+1; 1→1 = q maggiore.
 *
 * Palifico (jolly/calza, una volta a partita per giocatore):
 *  - Chi entra nel round con 1 dado (la prima volta) apre un round palifico.
 *  - Gli 1 NON sono wild e diventano una faccia normale puntabile.
 *  - Il valore è bloccato dall'apertura; solo chi ha 1 dado può cambiarlo (con
 *    un rilancio ordinario), ri-bloccandolo sul nuovo valore.
 *
 * Calza (solo modalità 'calza', gestione fuori turno lato server):
 *  - Dichiara che l'ultima scommessa è ESATTA. Esatta → recuperi un dado (max
 *    dicePerPlayer). Sbagliata → perdi un dado. Il round dopo apre chi ha calzato.
 */

const MIN_FACE = 1;
const MAX_FACE = 6;
const MODES = ['standard', 'jolly', 'calza'];

function defaultRng() {
  return Math.random();
}

/** Tira un dado 1..6 usando l'rng iniettato (per test deterministici). */
function rollDie(rng) {
  return Math.floor(rng() * 6) + 1;
}

function wellFormed(next) {
  if (!next || !Number.isInteger(next.quantity) || !Number.isInteger(next.face)) {
    return { ok: false, reason: 'Dichiarazione non valida.' };
  }
  if (next.quantity < 1) {
    return { ok: false, reason: 'La quantità deve essere almeno 1.' };
  }
  if (next.face < MIN_FACE || next.face > MAX_FACE) {
    return { ok: false, reason: 'Il valore del dado deve essere tra 1 e 6.' };
  }
  return { ok: true };
}

/**
 * Validazione STANDARD (nessun jolly): rilancio valido se quantità maggiore,
 * oppure stessa quantità con valore più alto. Facce 1..6 tutte normali.
 */
function validateBid(current, next) {
  const wf = wellFormed(next);
  if (!wf.ok) return wf;
  if (!current) return { ok: true };
  const higherQuantity = next.quantity > current.quantity;
  const sameQuantityHigherFace =
    next.quantity === current.quantity && next.face > current.face;
  if (higherQuantity || sameQuantityHigherFace) return { ok: true };
  return {
    ok: false,
    reason:
      'Rilancio non valido: aumenta la quantità, oppure mantieni la quantità ma alza il valore.',
  };
}

/**
 * Validazione JOLLY (round normali con gli 1 wild). Gestisce le conversioni
 * asimmetriche verso/da gli 1 e vieta l'apertura sugli 1.
 */
function validateBidWild(current, next) {
  const wf = wellFormed(next);
  if (!wf.ok) return wf;
  if (!current) {
    if (next.face === 1) {
      return { ok: false, reason: 'Non puoi aprire il round dichiarando gli 1 (jolly).' };
    }
    return { ok: true };
  }
  const cAce = current.face === 1;
  const nAce = next.face === 1;

  if (!cAce && !nAce) {
    const ok =
      next.quantity > current.quantity ||
      (next.quantity === current.quantity && next.face > current.face);
    return ok
      ? { ok: true }
      : { ok: false, reason: 'Rilancio non valido: aumenta la quantità o il valore.' };
  }
  if (!cAce && nAce) {
    const min = Math.ceil(current.quantity / 2);
    return next.quantity >= min
      ? { ok: true }
      : { ok: false, reason: `Per passare agli 1 servono almeno ${min} dadi.` };
  }
  if (cAce && !nAce) {
    const min = current.quantity * 2 + 1;
    return next.quantity >= min
      ? { ok: true }
      : { ok: false, reason: `Uscendo dagli 1 servono almeno ${min} dadi.` };
  }
  // 1 -> 1
  return next.quantity > current.quantity
    ? { ok: true }
    : { ok: false, reason: 'Aumenta la quantità di 1.' };
}

/**
 * Validazione PALIFICO: gli 1 sono normali. Il valore è bloccato (lockedFace),
 * salvo chi può cambiarlo (canChangeFace = ha 1 dado) che fa un rilancio
 * ordinario. All'apertura (current null) qualsiasi faccia va bene.
 */
function validateBidPalifico(current, next, lockedFace, canChangeFace) {
  const wf = wellFormed(next);
  if (!wf.ok) return wf;
  if (!current) return { ok: true }; // apertura del palifico: fissa il valore
  if (canChangeFace) {
    const ok =
      next.quantity > current.quantity ||
      (next.quantity === current.quantity && next.face > current.face);
    return ok
      ? { ok: true }
      : { ok: false, reason: 'Rilancio non valido: aumenta la quantità o il valore.' };
  }
  if (next.face !== lockedFace) {
    return { ok: false, reason: 'Round Palifico: il valore è bloccato, puoi solo aumentare la quantità.' };
  }
  return next.quantity > current.quantity
    ? { ok: true }
    : { ok: false, reason: 'Aumenta la quantità.' };
}

/** Conta i dadi col valore esatto `face` su tutti i giocatori vivi. */
function countFace(players, face) {
  let total = 0;
  for (const p of players) {
    if (!p.alive) continue;
    for (const d of p.dice) if (d === face) total += 1;
  }
  return total;
}

/** Conteggio con jolly: se face!==1, valgono anche gli 1. Se face===1, solo gli 1. */
function countWild(players, face) {
  if (face === 1) return countFace(players, 1);
  let total = 0;
  for (const p of players) {
    if (!p.alive) continue;
    for (const d of p.dice) if (d === face || d === 1) total += 1;
  }
  return total;
}

class Game {
  /**
   * @param {Array<{id:string,name:string}>} seats
   * @param {number} dicePerPlayer  dadi iniziali (1..5)
   * @param {object} [opts]  { rng, starterIndex, mode }
   */
  constructor(seats, dicePerPlayer, opts = {}) {
    this.rng = opts.rng || defaultRng;
    this.mode = MODES.includes(opts.mode) ? opts.mode : 'standard';
    this.dicePerPlayer = Math.max(1, Math.min(5, dicePerPlayer | 0));
    this.players = seats.map((s) => ({
      id: s.id,
      name: s.name,
      diceCount: this.dicePerPlayer,
      dice: [],
      alive: true,
      hasPalificoed: false,
    }));
    this.phase = 'bidding'; // 'bidding' | 'reveal' | 'gameOver'
    this.currentBid = null; // { quantity, face, playerId }
    this.lastResult = null;
    this.winnerId = null;
    this.roundNumber = 0;

    // Stato palifico (mai al round 1).
    this.palifico = false;
    this.palificoPlayerId = null;
    this.lockedFace = null;
    // Scelta palifico in sospeso: l'apertura con 1 dado deve decidere se attivarlo.
    this.palificoPending = false;
    this.palificoPendingId = null;

    const start =
      Number.isInteger(opts.starterIndex) &&
      opts.starterIndex >= 0 &&
      opts.starterIndex < this.players.length
        ? opts.starterIndex
        : Math.floor(this.rng() * this.players.length);
    this.roundStarterIndex = start;
    this.turnIndex = start;
    this._nextStarterIndex = start;
    this._roll();
    this.roundNumber = 1;
  }

  wildActive() {
    return this.mode !== 'standard' && !this.palifico;
  }

  _nextAliveFrom(from) {
    const n = this.players.length;
    for (let step = 0; step < n; step += 1) {
      const idx = (from + step) % n;
      if (this.players[idx].alive) return idx;
    }
    return -1;
  }

  _nextAliveAfter(from) {
    return this._nextAliveFrom((from + 1) % this.players.length);
  }

  _nextPlayerId() {
    const idx = this._nextAliveAfter(this.turnIndex);
    return this.players[idx] ? this.players[idx].id : null;
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

  /** Piazza una dichiarazione (rilancio). Ritorna { ok, reason? }. */
  placeBid(playerId, quantity, face) {
    if (this.phase !== 'bidding') {
      return { ok: false, reason: 'Non è il momento di dichiarare.' };
    }
    const player = this.currentPlayer();
    if (!player || player.id !== playerId) {
      return { ok: false, reason: 'Non è il tuo turno.' };
    }
    if (this.palificoPending) {
      return { ok: false, reason: 'Devi prima decidere se dichiarare Palifico.' };
    }
    const bid = { quantity: quantity | 0, face: face | 0 };

    let check;
    if (this.palifico) {
      const canChangeFace = player.diceCount === 1; // include l'apertura del palifico
      check = validateBidPalifico(this.currentBid, bid, this.lockedFace, canChangeFace);
    } else if (this.mode !== 'standard') {
      check = validateBidWild(this.currentBid, bid);
    } else {
      check = validateBid(this.currentBid, bid);
    }
    if (!check.ok) return check;

    this.currentBid = { ...bid, playerId };
    if (this.palifico) this.lockedFace = bid.face; // apertura o cambio mono-dado
    this.turnIndex = this._nextAliveAfter(this.turnIndex);
    return { ok: true };
  }

  /** Prepara la rivelazione dopo che un giocatore ha perso/guadagnato. */
  _finishRound() {
    if (this._aliveCount() <= 1) {
      const winner = this.players.find((p) => p.alive) || null;
      this.winnerId = winner ? winner.id : null;
      this.lastResult.winnerId = this.winnerId;
      this.lastResult.winnerName = winner ? winner.name : null;
      this.phase = 'gameOver';
    } else {
      this.phase = 'reveal';
    }
  }

  _revealSnapshot() {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      dice: [...p.dice],
      diceCount: p.diceCount,
      alive: p.alive,
    }));
  }

  /** "Dubito": chi è di turno contesta l'ultima dichiarazione. */
  challenge(playerId) {
    if (this.phase !== 'bidding') {
      return { ok: false, reason: 'Non è il momento di dubitare.' };
    }
    if (!this.currentBid) {
      return { ok: false, reason: "Non c'è ancora una dichiarazione da contestare." };
    }
    const challenger = this.currentPlayer();
    if (!challenger || challenger.id !== playerId) {
      return { ok: false, reason: 'Non è il tuo turno.' };
    }

    const bid = this.currentBid;
    const bidder = this.players.find((p) => p.id === bid.playerId);
    const wild = this.wildActive();
    const actualCount = wild ? countWild(this.players, bid.face) : countFace(this.players, bid.face);
    const bidWasTrue = actualCount >= bid.quantity;

    const loser = bidWasTrue ? challenger : bidder;
    this._nextStarterIndex = this.players.indexOf(loser); // apre chi perde
    loser.diceCount -= 1;
    if (loser.diceCount <= 0) {
      loser.diceCount = 0;
      loser.alive = false;
    }

    this.lastResult = {
      type: 'doubt',
      wild,
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
      reveal: this._revealSnapshot(),
    };
    this._finishRound();
    return { ok: true };
  }

  /**
   * "Calza" (solo modalità calza): un giocatore FUORI turno dichiara che
   * l'ultima scommessa è esatta. Vincoli e conflitti gestiti qui.
   * @param {string} playerId  chi calza
   * @param {{quantity:number,face:number}} [expectedBid]  bid atteso (anti-stale)
   */
  calza(playerId, expectedBid) {
    if (this.mode !== 'calza') {
      return { ok: false, reason: 'La Calza non è attiva in questa modalità.' };
    }
    if (this.phase !== 'bidding') {
      return { ok: false, reason: 'Non è il momento di calzare.' };
    }
    if (!this.currentBid) {
      return { ok: false, reason: "Non c'è una dichiarazione da calzare." };
    }
    if (this.palifico) {
      return { ok: false, reason: 'Niente Calza durante il Palifico.' };
    }
    if (this._aliveCount() <= 2) {
      return { ok: false, reason: 'Niente Calza in due giocatori.' };
    }
    const caller = this.players.find((p) => p.id === playerId);
    if (!caller || !caller.alive) {
      return { ok: false, reason: 'Non puoi calzare.' };
    }
    if (caller.diceCount >= this.dicePerPlayer) {
      return { ok: false, reason: 'Puoi calzare solo se hai già perso almeno un dado.' };
    }
    const turnId = this.currentPlayer() ? this.currentPlayer().id : null;
    const nextId = this._nextPlayerId();
    if (playerId === turnId) {
      return { ok: false, reason: 'Chi è di turno non può calzare.' };
    }
    if (playerId === nextId) {
      return { ok: false, reason: 'Il giocatore successivo non può calzare.' };
    }
    if (
      expectedBid &&
      (expectedBid.quantity !== this.currentBid.quantity || expectedBid.face !== this.currentBid.face)
    ) {
      return { ok: false, reason: 'La dichiarazione è cambiata, riprova.' };
    }

    const bid = this.currentBid;
    const actualCount = countWild(this.players, bid.face); // calza sempre in round wild
    const exact = actualCount === bid.quantity;
    this._nextStarterIndex = this.players.indexOf(caller); // apre chi ha calzato

    if (exact) {
      caller.diceCount = Math.min(this.dicePerPlayer, caller.diceCount + 1);
    } else {
      caller.diceCount -= 1;
      if (caller.diceCount <= 0) {
        caller.diceCount = 0;
        caller.alive = false;
      }
    }

    this.lastResult = {
      type: 'calza',
      wild: true,
      bid: { quantity: bid.quantity, face: bid.face },
      bidderId: bid.playerId,
      bidderName: (this.players.find((p) => p.id === bid.playerId) || {}).name || null,
      callerId: caller.id,
      callerName: caller.name,
      actualCount,
      exact,
      gained: exact,
      loserId: exact ? null : caller.id,
      loserName: exact ? null : caller.name,
      loserEliminated: exact ? false : !caller.alive,
      reveal: this._revealSnapshot(),
    };
    this._finishRound();
    return { ok: true };
  }

  /** Reveal -> round successivo. Apre chi ha perso/calzato; imposta il palifico. */
  startNextRound() {
    if (this.phase !== 'reveal') {
      return { ok: false, reason: 'Nessun round da avviare.' };
    }
    const from = Number.isInteger(this._nextStarterIndex)
      ? this._nextStarterIndex
      : this.roundStarterIndex;
    this.roundStarterIndex = this._nextAliveFrom(from);
    this.turnIndex = this.roundStarterIndex;
    this.currentBid = null;

    // Palifico non è automatico: se l'apertura ha 1 dado (e non l'ha già usato)
    // resta una SCELTA che il giocatore fa a inizio round (choosePalifico).
    this.palifico = false;
    this.palificoPlayerId = null;
    this.lockedFace = null;
    const opener = this.players[this.roundStarterIndex];
    const eligible =
      this.mode !== 'standard' &&
      opener &&
      opener.diceCount === 1 &&
      !opener.hasPalificoed;
    this.palificoPending = !!eligible;
    this.palificoPendingId = eligible ? opener.id : null;

    this._roll();
    this.roundNumber += 1;
    this.phase = 'bidding';
    return { ok: true };
  }

  /**
   * L'apertura con 1 dado sceglie se dichiarare Palifico. Se lo attiva vale una
   * sola volta a partita (hasPalificoed). Ritorna { ok, reason? }.
   */
  choosePalifico(playerId, activate) {
    if (!this.palificoPending) {
      return { ok: false, reason: 'Nessuna scelta Palifico in corso.' };
    }
    if (playerId !== this.palificoPendingId) {
      return { ok: false, reason: 'Non tocca a te decidere il Palifico.' };
    }
    const opener = this.players.find((p) => p.id === playerId);
    if (activate) {
      this.palifico = true;
      this.palificoPlayerId = opener ? opener.id : null;
      this.lockedFace = null;
      if (opener) opener.hasPalificoed = true; // consumato solo se attivato
    } else {
      this.palifico = false;
      this.palificoPlayerId = null;
      this.lockedFace = null;
    }
    this.palificoPending = false;
    this.palificoPendingId = null;
    return { ok: true };
  }

  /** Stato PUBBLICO: nessun dado nascosto (tranne in reveal/gameOver). */
  publicState() {
    const revealing = this.phase === 'reveal' || this.phase === 'gameOver';
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      dicePerPlayer: this.dicePerPlayer,
      mode: this.mode,
      wild: this.wildActive(),
      palifico: this.palifico,
      palificoPlayerId: this.palificoPlayerId,
      palificoPending: this.palificoPending,
      palificoPendingId: this.palificoPendingId,
      lockedFace: this.lockedFace,
      nextPlayerId: this._nextPlayerId(),
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
        hasPalificoed: p.hasPalificoed,
        dice: revealing ? [...p.dice] : null,
      })),
    };
  }

  diceFor(playerId) {
    const p = this.players.find((x) => x.id === playerId);
    return p ? [...p.dice] : [];
  }
}

module.exports = {
  Game,
  validateBid,
  validateBidWild,
  validateBidPalifico,
  countFace,
  countWild,
  rollDie,
};
