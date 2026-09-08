/**
 * bots.js — giocatori artificiali ("bot") per il tavolo.
 *
 * Principi:
 *  - NON onniscienti: ogni decisione usa solo la "vista" di un giocatore reale
 *    (i propri dadi + lo stato pubblico del tavolo), mai i dadi altrui.
 *  - Ragionamento probabilistico: stima binomiale sui dadi che il bot non vede.
 *  - Personalità: ogni bot nasce con parametri diversi (quanto bluffa, quanto
 *    è sospettoso, quanto rilancia pesante, quanto ci prova con la Calza...),
 *    così il tavolo non gioca mai in modo uniforme.
 *  - Umanità: soglie e scelte hanno rumore casuale; i tempi di "riflessione"
 *    variano per bot e per tipo di mossa.
 *
 * La "view" che ricevono le decisioni:
 *   { myDice, totalDice, currentBid: {quantity,face}|null, wild, palifico,
 *     lockedFace, canChangeFace }
 */
'use strict';

const BOT_NAMES = [
  'Gino', 'Piera', 'Ugo', 'Sonia', 'Bruno', 'Rita', 'Aldo', 'Vera',
  'Nino', 'Carla', 'Ettore', 'Mirella', 'Dante', 'Olga', 'Fausto', 'Ines',
];

// Con PERUDO_BOT_FAST=1 i tempi di riflessione si comprimono (per i test).
const SPEED = process.env.PERUDO_BOT_FAST ? 0.06 : 1;

function rand() {
  return Math.random();
}
function randIn(a, b) {
  return a + rand() * (b - a);
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

/** Crea n bot con nome unico (evitando excludeNames) e personalità casuale. */
function makeBots(n, excludeNames) {
  const excl = new Set((excludeNames || []).map((s) => String(s).toLowerCase()));
  const pool = BOT_NAMES.filter((name) => !excl.has(name.toLowerCase()));
  const names = pool.sort(() => rand() - 0.5).slice(0, n);
  return names.map((name) => ({
    name,
    personality: {
      bluff: randIn(0.08, 0.4), // frequenza di rilanci "sparati"
      doubtTh: randIn(0.22, 0.42), // dubita se P(dichiarazione vera) scende sotto
      aggr: randIn(0.15, 0.75), // propensione a rilanci più pesanti del minimo
      calzaTh: randIn(0.16, 0.3), // P(esatta) minima perché la Calza lo tenti
      calzaZeal: randIn(0.25, 0.75), // voglia di calzare quando conviene
      palifico: randIn(0.5, 0.9), // prob. di dichiarare Palifico quando può
      tempo: randIn(0.7, 1.5), // moltiplicatore dei tempi di riflessione
    },
  }));
}

// ---------- probabilità ----------

/** P che un singolo dado IGNOTO valga per la faccia dichiarata. */
function pFace(face, wild) {
  return wild && face !== 1 ? 2 / 6 : 1 / 6;
}

/** X ~ Binomiale(n, p): ritorna { tail: P(X>=k), exact: P(X==k) }. */
function binom(n, p, k) {
  if (k <= 0) {
    // tail certa; exact ha senso solo per k === 0
    let pmf0 = Math.pow(1 - p, n);
    return { tail: 1, exact: k === 0 ? pmf0 : 0 };
  }
  if (n <= 0) return { tail: 0, exact: 0 };
  let pmf = Math.pow(1 - p, n); // P(X = 0)
  let tail = 0;
  let exact = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i === k) exact = pmf;
    if (i >= k) tail += pmf;
    pmf = (pmf * (n - i) * p) / ((i + 1) * (1 - p));
  }
  return { tail, exact };
}

/** Quanti dei MIEI dadi valgono per la faccia (con jolly se attivi). */
function countMine(myDice, face, wild) {
  let c = 0;
  for (const v of myDice) {
    if (v === face || (wild && face !== 1 && v === 1)) c += 1;
  }
  return c;
}

/** Valuta una dichiarazione (q × face) dal punto di vista del bot. */
function evalBid(view, q, face) {
  const mine = countMine(view.myDice, face, view.wild);
  const unknown = view.totalDice - view.myDice.length;
  const need = q - mine;
  const { tail, exact } = binom(unknown, pFace(face, view.wild), need);
  return { pTrue: tail, pExact: exact, mine };
}

// ---------- mosse legali ----------

/** Candidati di rilancio legali sopra la dichiarazione corrente. */
function legalRaises(view) {
  const cb = view.currentBid;
  const out = [];
  const addQ = (q, f) => out.push({ q, f });

  if (view.palifico) {
    addQ(cb.quantity + 1, view.lockedFace);
    if (view.canChangeFace) {
      for (let f = cb.face + 1; f <= 6; f += 1) addQ(cb.quantity, f);
    }
    return out;
  }
  if (view.wild) {
    if (cb.face === 1) {
      addQ(cb.quantity + 1, 1); // più assi
      const q = cb.quantity * 2 + 1; // uscita dagli assi
      for (let f = 2; f <= 6; f += 1) addQ(q, f);
    } else {
      for (let f = cb.face + 1; f <= 6; f += 1) addQ(cb.quantity, f);
      for (let f = 2; f <= 6; f += 1) addQ(cb.quantity + 1, f);
      addQ(Math.ceil(cb.quantity / 2), 1); // passaggio agli assi
    }
    return out;
  }
  // standard
  for (let f = cb.face + 1; f <= 6; f += 1) addQ(cb.quantity, f);
  for (let f = 1; f <= 6; f += 1) addQ(cb.quantity + 1, f);
  return out;
}

/** Rilancio minimo sempre legale (rete di sicurezza). */
function fallbackAction(view) {
  const cb = view.currentBid;
  if (!cb) {
    if (view.palifico) return { type: 'bid', quantity: 1, face: view.lockedFace || pick(view.myDice) || 2 };
    return { type: 'bid', quantity: 1, face: view.wild ? 2 : 1 };
  }
  if (view.palifico) {
    return { type: 'bid', quantity: cb.quantity + 1, face: view.lockedFace };
  }
  if (view.wild && cb.face === 1) return { type: 'bid', quantity: cb.quantity + 1, face: 1 };
  return cb.face < 6
    ? { type: 'bid', quantity: cb.quantity, face: cb.face + 1 }
    : { type: 'bid', quantity: cb.quantity + 1, face: view.wild ? 2 : 1 };
}

// ---------- decisioni ----------

/** Apertura del round: dichiarazione prudente basata sui propri dadi
 *  (a volte, per bluff, su una faccia che il bot non ha affatto). */
function chooseOpen(view, pers) {
  const faces = [];
  const min = view.palifico ? 1 : view.wild ? 2 : 1;
  for (let f = min; f <= 6; f += 1) faces.push(f);

  let face;
  if (rand() < pers.bluff * 0.7) {
    face = pick(faces); // bluff d'apertura: faccia qualsiasi
  } else {
    // faccia più rappresentata nella mia mano (con un filo di rumore)
    face = faces
      .map((f) => ({ f, score: countMine(view.myDice, f, view.wild) + randIn(0, 0.8) }))
      .sort((a, b) => b.score - a.score)[0].f;
  }
  const mine = countMine(view.myDice, face, view.wild);
  const unknown = view.totalDice - view.myDice.length;
  const est = unknown * pFace(face, view.wild);
  // apertura bassa: mai mostrare subito le carte
  let q = Math.max(1, Math.round(mine + est * randIn(0.15, 0.55)));
  if (rand() < pers.bluff * 0.5) q += 1; // ogni tanto si parte già alti
  q = Math.min(q, Math.max(1, view.totalDice - 1));
  return { type: 'bid', quantity: q, face };
}

/** Mossa al proprio turno: dubita o rilancia (con eventuale bluff). */
function chooseTurnAction(view, pers) {
  if (!view.currentBid) return chooseOpen(view, pers);

  const cur = evalBid(view, view.currentBid.quantity, view.currentBid.face);
  const doubtTh = pers.doubtTh * randIn(0.8, 1.2);

  // Candidati legali con relativa probabilità di reggere a un dubito.
  const cands = legalRaises(view)
    .filter((c) => c.q <= view.totalDice) // dichiarare più dadi del totale è da pazzi
    .map((c) => ({ ...c, pTrue: evalBid(view, c.q, c.f).pTrue }))
    .sort((a, b) => b.pTrue - a.pTrue);

  // Dubito se la dichiarazione mi puzza.
  if (cur.pTrue < doubtTh) return { type: 'doubt' };
  // Nessun rilancio sensato e dichiarazione tutt'altro che certa → dubito.
  if ((!cands.length || cands[0].pTrue < 0.12) && cur.pTrue < 0.75) return { type: 'doubt' };
  if (!cands.length) return { type: 'doubt' };

  // Bluff: ogni tanto scelgo apposta un rilancio coraggioso.
  if (rand() < pers.bluff) {
    const bluffy = cands.filter((c) => c.pTrue >= 0.05 && c.pTrue <= 0.45);
    if (bluffy.length) {
      const c = pick(bluffy);
      return { type: 'bid', quantity: c.q, face: c.f };
    }
  }

  // Gioco solido: tra i rilanci "che reggono", l'aggressività decide quanto
  // spingersi oltre il minimo sindacale.
  const safe = cands.filter((c) => c.pTrue >= 0.35);
  const poolChoices = safe.length ? safe : cands.slice(0, 2);
  const idx = Math.min(
    poolChoices.length - 1,
    Math.floor(rand() * (1 + pers.aggr * (poolChoices.length - 1)))
  );
  const c = poolChoices[idx];
  return { type: 'bid', quantity: c.q, face: c.f };
}

/** Vale la pena calzare la dichiarazione corrente? */
function considerCalza(view, pers) {
  if (!view.currentBid) return false;
  const { pExact } = evalBid(view, view.currentBid.quantity, view.currentBid.face);
  return pExact >= pers.calzaTh && rand() < pers.calzaZeal;
}

/** Dichiarare Palifico quando se ne ha l'occasione? */
function choosePalificoBot(pers) {
  return rand() < pers.palifico;
}

// ---------- tempi di "riflessione" ----------

const DELAYS = {
  roll: [500, 1600],
  turn: [1400, 4200],
  palifico: [1200, 2600],
  ready: [900, 2600],
  calza: [700, 1900],
};
function thinkDelay(pers, kind) {
  const [a, b] = DELAYS[kind] || DELAYS.turn;
  return Math.max(60, Math.round(randIn(a, b) * (pers ? pers.tempo : 1) * SPEED));
}

module.exports = {
  makeBots,
  chooseTurnAction,
  chooseOpen,
  considerCalza,
  choosePalificoBot,
  fallbackAction,
  thinkDelay,
  // esposti per i test
  evalBid,
  legalRaises,
  binom,
  BOT_NAMES,
};
