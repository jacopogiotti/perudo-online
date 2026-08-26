'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  Game,
  validateBid,
  validateBidWild,
  validateBidPalifico,
  countFace,
  countWild,
} = require('./engine');

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

// ---------------- JOLLY ----------------

test('countWild: gli 1 valgono come la faccia dichiarata (2..6)', () => {
  const players = [
    { alive: true, dice: [5, 1, 3] },
    { alive: true, dice: [1, 5] },
  ];
  assert.strictEqual(countWild(players, 5), 4); // due 5 + due 1
  assert.strictEqual(countWild(players, 1), 2); // solo gli 1
});

test('validateBidWild: non si può aprire dichiarando gli 1', () => {
  assert.strictEqual(validateBidWild(null, { quantity: 3, face: 1 }).ok, false);
  assert.strictEqual(validateBidWild(null, { quantity: 3, face: 4 }).ok, true);
});

test('validateBidWild: numero->1 richiede ceil(q/2)', () => {
  assert.strictEqual(validateBidWild({ quantity: 6, face: 5 }, { quantity: 3, face: 1 }).ok, true);
  assert.strictEqual(validateBidWild({ quantity: 6, face: 5 }, { quantity: 2, face: 1 }).ok, false);
  assert.strictEqual(validateBidWild({ quantity: 5, face: 5 }, { quantity: 3, face: 1 }).ok, true); // ceil(5/2)=3
});

test('validateBidWild: 1->numero richiede q*2+1', () => {
  assert.strictEqual(validateBidWild({ quantity: 3, face: 1 }, { quantity: 7, face: 4 }).ok, true);
  assert.strictEqual(validateBidWild({ quantity: 3, face: 1 }, { quantity: 6, face: 4 }).ok, false);
});

test('validateBidWild: 1->1 solo aumentando la quantità', () => {
  assert.strictEqual(validateBidWild({ quantity: 2, face: 1 }, { quantity: 3, face: 1 }).ok, true);
  assert.strictEqual(validateBidWild({ quantity: 2, face: 1 }, { quantity: 2, face: 1 }).ok, false);
});

test('jolly: il dubito conta anche gli 1', () => {
  // A=[5,1], B=[1,2] -> i "5" con jolly sono 3 (un 5 + due 1)
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 2, {
    starterIndex: 0,
    mode: 'jolly',
    rng: diceRng([5, 1, 1, 2]),
  });
  assert.strictEqual(g.placeBid('a', 3, 5).ok, true); // "tre 5": vera coi jolly
  assert.strictEqual(g.challenge('b').ok, true);
  assert.strictEqual(g.lastResult.actualCount, 3);
  assert.strictEqual(g.lastResult.bidWasTrue, true);
  assert.strictEqual(g.lastResult.loserId, 'b'); // dubito sbagliato
  assert.strictEqual(g.lastResult.wild, true);
});

// ---------------- PALIFICO ----------------

test('palifico: si attiva quando l\'apertura ha 1 dado (prima volta), non a 2 giocatori', () => {
  // 3 giocatori: A con 1 dado apre e va in palifico.
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    5,
    { starterIndex: 0, mode: 'jolly' }
  );
  g.players[0].diceCount = 1; // simuliamo A a 1 dado
  g.phase = 'reveal';
  g._nextStarterIndex = 0;
  assert.strictEqual(g.startNextRound().ok, true);
  // Ora è una SCELTA in sospeso, non attivo d'ufficio.
  assert.strictEqual(g.palificoPending, true);
  assert.strictEqual(g.palificoPendingId, 'a');
  assert.strictEqual(g.palifico, false);
  // A decide di attivarlo.
  assert.strictEqual(g.choosePalifico('a', true).ok, true);
  assert.strictEqual(g.palifico, true);
  assert.strictEqual(g.palificoPlayerId, 'a');
  assert.strictEqual(g.players[0].hasPalificoed, true);
  assert.strictEqual(g.palificoPending, false);
  assert.strictEqual(g.wildActive(), false); // niente jolly in palifico
});

test('palifico: se rifiutato, round normale e NON si consuma', () => {
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    5,
    { starterIndex: 0, mode: 'jolly' }
  );
  g.players[0].diceCount = 1;
  g.phase = 'reveal';
  g._nextStarterIndex = 0;
  g.startNextRound();
  assert.strictEqual(g.choosePalifico('a', false).ok, true);
  assert.strictEqual(g.palifico, false);
  assert.strictEqual(g.players[0].hasPalificoed, false); // non consumato
  assert.strictEqual(g.wildActive(), true); // round normale con jolly
});

test('palifico: valore bloccato per i non-mono-dado, eccezione per chi ha 1 dado', () => {
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    5,
    { starterIndex: 0, mode: 'jolly' }
  );
  // Setup palifico manuale: A apre con 1 dado, B ha 3, C ha 1.
  g.players[0].diceCount = 1;
  g.players[1].diceCount = 3;
  g.players[2].diceCount = 1;
  g.phase = 'reveal';
  g._nextStarterIndex = 0;
  g.startNextRound();
  assert.strictEqual(g.choosePalifico('a', true).ok, true); // A attiva il palifico
  assert.strictEqual(g.palifico, true);
  // A apre bloccando il valore 4
  assert.strictEqual(g.placeBid('a', 2, 4).ok, true);
  assert.strictEqual(g.lockedFace, 4);
  // B (3 dadi) NON può cambiare valore: solo aumentare quantità sullo stesso 4
  assert.strictEqual(g.placeBid('b', 2, 5).ok, false);
  assert.strictEqual(g.placeBid('b', 3, 4).ok, true);
  // C (1 dado) PUÒ cambiare valore con rilancio ordinario
  assert.strictEqual(g.placeBid('c', 3, 6).ok, true);
  assert.strictEqual(g.lockedFace, 6);
});

test('palifico: una sola volta a partita', () => {
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    5,
    { starterIndex: 0, mode: 'jolly' }
  );
  g.players[0].diceCount = 1;
  g.players[0].hasPalificoed = true; // ha già fatto palifico
  g.phase = 'reveal';
  g._nextStarterIndex = 0;
  g.startNextRound();
  assert.strictEqual(g.palifico, false); // niente secondo palifico
  assert.strictEqual(g.palificoPending, false); // nemmeno la scelta
});

// ---------------- CALZA ----------------

/** Prepara un tavolo calza a 4 giocatori con dadi e conteggi impostati a mano. */
function calzaSetup(dDiceCount) {
  const g = new Game(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }],
    2,
    { starterIndex: 0, mode: 'calza' }
  );
  // Board coerente (dice array == diceCount). countWild(5) = 4.
  g.players[0].dice = [5, 5]; g.players[0].diceCount = 2; // A
  g.players[1].dice = [5, 2]; g.players[1].diceCount = 2; // B
  g.players[2].dice = [2, 2]; g.players[2].diceCount = 2; // C
  g.players[3].dice = dDiceCount === 1 ? [5] : [5, 5];
  g.players[3].diceCount = dDiceCount; // D
  return g;
}

test('calza: esatta -> recupera un dado e apre chi ha calzato', () => {
  const g = calzaSetup(1); // D ha 1 dado (ha già perso), board: quattro 5 (coi jolly)
  assert.strictEqual(g.placeBid('a', 4, 5).ok, true); // apertura valida; turno->B, successivo=C
  const r = g.calza('d'); // D non è né di turno né il successivo, ha perso un dado
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.lastResult.type, 'calza');
  assert.strictEqual(g.lastResult.exact, true);
  assert.strictEqual(g.players[3].diceCount, 2); // recupera un dado
  assert.strictEqual(g._nextStarterIndex, 3); // apre chi ha calzato (D)
});

test('calza: sbagliata -> chi calza perde un dado', () => {
  const g = calzaSetup(2); // D ha 2 dadi ma... deve aver perso: usiamo 1 per eleggibilità
  g.players[3].dice = [5]; g.players[3].diceCount = 1;
  assert.strictEqual(g.placeBid('a', 3, 5).ok, true); // dichiara "tre 5" ma ce ne sono 4 -> non esatta
  const r = g.calza('d');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(g.lastResult.exact, false);
  assert.strictEqual(g.players[3].diceCount, 0); // perde l'unico dado
  assert.strictEqual(g.players[3].alive, false);
});

test('calza: eleggibilità (turno e successivo non possono; servono dadi persi)', () => {
  const g = calzaSetup(1); // D ha 1 dado
  assert.strictEqual(g.placeBid('a', 4, 5).ok, true); // turno: B; successivo: C
  assert.strictEqual(g.calza('a').ok, false); // A ha 2 dadi (pieni)
  assert.strictEqual(g.calza('b').ok, false); // B è di turno
  assert.strictEqual(g.calza('c').ok, false); // C è il successivo
  assert.strictEqual(g.calza('d').ok, true); // D eleggibile
});

test('calza: niente calza a 2 giocatori', () => {
  const g2 = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 3, {
    starterIndex: 0,
    mode: 'calza',
  });
  g2.placeBid('a', 1, 3);
  assert.strictEqual(g2.calza('b').ok, false); // 2 giocatori
});
