'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Game, validateBid, countFace } = require('./engine');

/** RNG deterministico: restituisce in sequenza i valori forniti (ciclando). */
function seqRng(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

/** Costruisce un rng che fa uscire esattamente i valori di dado voluti (1..6). */
function diceRng(faces) {
  // rollDie fa: floor(rng()*6)+1  => per ottenere face f serve rng in [(f-1)/6, f/6)
  return seqRng(faces.map((f) => (f - 1) / 6 + 0.01));
}

test('validateBid: prima dichiarazione ben formata è valida', () => {
  assert.deepStrictEqual(validateBid(null, { quantity: 2, face: 3 }), { ok: true });
});

test('validateBid: quantità < 1 non valida', () => {
  assert.strictEqual(validateBid(null, { quantity: 0, face: 3 }).ok, false);
});

test('validateBid: face fuori range non valida', () => {
  assert.strictEqual(validateBid(null, { quantity: 1, face: 7 }).ok, false);
  assert.strictEqual(validateBid(null, { quantity: 1, face: 0 }).ok, false);
});

test('validateBid: stessa quantità, valore più alto => valido', () => {
  assert.strictEqual(validateBid({ quantity: 3, face: 2 }, { quantity: 3, face: 4 }).ok, true);
});

test('validateBid: stessa quantità, valore uguale o più basso => non valido', () => {
  assert.strictEqual(validateBid({ quantity: 3, face: 4 }, { quantity: 3, face: 4 }).ok, false);
  assert.strictEqual(validateBid({ quantity: 3, face: 4 }, { quantity: 3, face: 2 }).ok, false);
});

test('validateBid: quantità maggiore con valore qualsiasi => valido', () => {
  assert.strictEqual(validateBid({ quantity: 3, face: 5 }, { quantity: 4, face: 1 }).ok, true);
});

test('validateBid: quantità minore => non valido anche con valore più alto', () => {
  assert.strictEqual(validateBid({ quantity: 4, face: 2 }, { quantity: 3, face: 6 }).ok, false);
});

test('countFace conta su tutti i giocatori vivi', () => {
  const players = [
    { alive: true, dice: [1, 3, 3] },
    { alive: true, dice: [3, 2] },
    { alive: false, dice: [3, 3] }, // eliminato: non conta
  ];
  assert.strictEqual(countFace(players, 3), 3);
});

test('turno: parte lo starter indicato e avanza in ordine', () => {
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    5,
    { starterIndex: 0 }
  );
  assert.strictEqual(g.currentPlayer().id, 'a');
  assert.strictEqual(g.placeBid('a', 1, 2).ok, true);
  assert.strictEqual(g.currentPlayer().id, 'b');
  assert.strictEqual(g.placeBid('b', 2, 2).ok, true);
  assert.strictEqual(g.currentPlayer().id, 'c');
});

test('placeBid rifiutato se non è il tuo turno', () => {
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 5, { starterIndex: 0 });
  assert.strictEqual(g.placeBid('b', 1, 2).ok, false);
});

test('dubito: dichiarazione FALSA => chi ha dichiarato perde un dado', () => {
  // 2 giocatori, 2 dadi ciascuno. Dadi forzati: A=[1,1], B=[6,6].
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 2, {
    starterIndex: 0,
    rng: diceRng([1, 1, 6, 6]),
  });
  // A dichiara "tre dadi da 5" (in realtà ci sono 0 cinque) -> falsa
  assert.strictEqual(g.placeBid('a', 3, 5).ok, true);
  // B dubita
  assert.strictEqual(g.challenge('b').ok, true);
  assert.strictEqual(g.lastResult.bidWasTrue, false);
  assert.strictEqual(g.lastResult.loserId, 'a');
  const a = g.players.find((p) => p.id === 'a');
  assert.strictEqual(a.diceCount, 1);
});

test('dubito: dichiarazione VERA => chi ha dubitato perde un dado', () => {
  // Dadi: A=[3,3], B=[3,4]. Ci sono 3 tre in tavola.
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 2, {
    starterIndex: 0,
    rng: diceRng([3, 3, 3, 4]),
  });
  // A dichiara "due dadi da 3" -> in tavola ce ne sono 3 => vera
  assert.strictEqual(g.placeBid('a', 2, 3).ok, true);
  assert.strictEqual(g.challenge('b').ok, true);
  assert.strictEqual(g.lastResult.bidWasTrue, true);
  assert.strictEqual(g.lastResult.loserId, 'b');
  const b = g.players.find((p) => p.id === 'b');
  assert.strictEqual(b.diceCount, 1);
});

test('conteggio al limite: actualCount == quantity => dichiarazione vera', () => {
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 2, {
    starterIndex: 0,
    rng: diceRng([5, 1, 5, 2]),
  });
  // Due 5 in tavola. A dichiara "due da 5" => actual(2) >= 2 => vera.
  assert.strictEqual(g.placeBid('a', 2, 5).ok, true);
  assert.strictEqual(g.challenge('b').ok, true);
  assert.strictEqual(g.lastResult.bidWasTrue, true);
  assert.strictEqual(g.lastResult.loserId, 'b');
});

test('eliminazione a 0 dadi e vittoria dell\'ultimo rimasto', () => {
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 1, {
    starterIndex: 0,
    rng: diceRng([1, 6]),
  });
  // 1 dado a testa: A=[1], B=[6]. A dichiara "due da 3" => falsa => A perde il suo unico dado.
  assert.strictEqual(g.placeBid('a', 2, 3).ok, true);
  assert.strictEqual(g.challenge('b').ok, true);
  assert.strictEqual(g.phase, 'gameOver');
  assert.strictEqual(g.winnerId, 'b');
  const a = g.players.find((p) => p.id === 'a');
  assert.strictEqual(a.alive, false);
});

test('nuovo round: apre chi ha perso il dado (il dichiarante che ha bluffato)', () => {
  // Nessun 6 in tavola: la dichiarazione sui 6 sarà falsa e perde il dichiarante.
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }],
    5,
    { starterIndex: 0, rng: diceRng(Array(20).fill(1)) }
  );
  assert.strictEqual(g.roundStarterIndex, 0); // apre A
  assert.strictEqual(g.placeBid('a', 1, 2).ok, true);
  assert.strictEqual(g.placeBid('b', 1, 3).ok, true);
  assert.strictEqual(g.placeBid('c', 5, 6).ok, true); // "5 da 6": falsa (0 sei)
  assert.strictEqual(g.challenge('d').ok, true); // D dubita bene -> perde C (dichiarante)
  assert.strictEqual(g.lastResult.loserId, 'c');
  assert.strictEqual(g.startNextRound().ok, true);
  // Apre chi ha perso il dado = C (index 2), NON il dubitante D.
  assert.strictEqual(g.currentPlayer().id, 'c');
  assert.strictEqual(g.roundStarterIndex, 2);
});

test('nuovo round: se chi perde è eliminato, apre il primo vivo dopo di lui', () => {
  // 3 giocatori con 1 dado, nessun 6: A dichiara il falso, B dubita, A (dichiarante)
  // perde il suo unico dado ed è eliminato -> apre il primo vivo dopo A, cioè B.
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    1,
    { starterIndex: 0, rng: diceRng([1, 1, 1]) }
  );
  assert.strictEqual(g.placeBid('a', 3, 6).ok, true); // "tre da 6": falsa (0 sei)
  assert.strictEqual(g.challenge('b').ok, true);
  assert.strictEqual(g.lastResult.loserId, 'a');
  assert.strictEqual(g.lastResult.loserEliminated, true);
  assert.strictEqual(g.startNextRound().ok, true);
  assert.strictEqual(g.currentPlayer().id, 'b'); // A eliminato -> apre B
});

test('stato pubblico non espone i dadi durante il bidding', () => {
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 3, { starterIndex: 0 });
  const pub = g.publicState();
  for (const p of pub.players) {
    assert.strictEqual(p.dice, null);
  }
  // Ma i dadi privati del proprietario sono disponibili tramite diceFor.
  assert.strictEqual(g.diceFor('a').length, 3);
});
