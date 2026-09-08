'use strict';
/* Test dei bot: le mosse proposte devono SEMPRE essere legali per l'engine,
 * in tutte le modalità, qualunque sia lo stato del tavolo. */
const test = require('node:test');
const assert = require('node:assert');

const { validateBid, validateBidWild, validateBidPalifico } = require('./engine');
const bots = require('./bots');

function d6() {
  return 1 + Math.floor(Math.random() * 6);
}
function dice(n) {
  return Array.from({ length: n }, d6);
}
function anyPers() {
  return bots.makeBots(1)[0].personality;
}

test('makeBots: nomi unici, esclusioni rispettate, personalità nei range', () => {
  const bs = bots.makeBots(7, ['Gino']);
  assert.strictEqual(bs.length, 7);
  const names = bs.map((b) => b.name);
  assert.strictEqual(new Set(names).size, 7);
  assert.ok(!names.includes('Gino'));
  for (const b of bs) {
    const p = b.personality;
    assert.ok(p.bluff > 0 && p.bluff < 1);
    assert.ok(p.doubtTh > 0 && p.doubtTh < 1);
    assert.ok(p.tempo > 0);
  }
});

test('binom: casi noti', () => {
  assert.strictEqual(bots.binom(10, 1 / 6, 0).tail, 1);
  const b = bots.binom(6, 0.5, 3);
  assert.ok(Math.abs(b.exact - 0.3125) < 1e-9); // C(6,3)/64
  assert.ok(b.tail > b.exact);
  assert.strictEqual(bots.binom(0, 0.5, 2).tail, 0);
});

test('apertura: sempre una dichiarazione valida (mai gli 1 in jolly)', () => {
  for (let i = 0; i < 200; i += 1) {
    const wild = Math.random() < 0.5;
    const mine = dice(1 + Math.floor(Math.random() * 5));
    const view = {
      myDice: mine,
      totalDice: mine.length + 1 + Math.floor(Math.random() * 20),
      currentBid: null,
      wild,
      palifico: false,
      lockedFace: null,
      canChangeFace: mine.length === 1,
    };
    const a = bots.chooseTurnAction(view, anyPers());
    assert.strictEqual(a.type, 'bid');
    assert.ok(a.quantity >= 1);
    assert.ok(a.face >= 1 && a.face <= 6);
    if (wild) assert.notStrictEqual(a.face, 1, 'in jolly non si apre sugli 1');
  }
});

test('fuzz standard: rilanci sempre legali', () => {
  for (let i = 0; i < 400; i += 1) {
    const mine = dice(1 + Math.floor(Math.random() * 5));
    const cur = { quantity: 1 + Math.floor(Math.random() * 8), face: d6() };
    const view = {
      myDice: mine,
      totalDice: mine.length + 2 + Math.floor(Math.random() * 25),
      currentBid: cur,
      wild: false,
      palifico: false,
      lockedFace: null,
      canChangeFace: mine.length === 1,
    };
    const a = bots.chooseTurnAction(view, anyPers());
    if (a.type === 'bid') {
      const v = validateBid(cur, { quantity: a.quantity, face: a.face });
      assert.ok(v.ok, `rilancio illegale std: ${JSON.stringify({ cur, a })} → ${v.reason}`);
    }
  }
});

test('fuzz jolly: rilanci sempre legali (conversioni incluse)', () => {
  for (let i = 0; i < 400; i += 1) {
    const mine = dice(1 + Math.floor(Math.random() * 5));
    const cur = { quantity: 1 + Math.floor(Math.random() * 8), face: d6() };
    const view = {
      myDice: mine,
      totalDice: mine.length + 2 + Math.floor(Math.random() * 25),
      currentBid: cur,
      wild: true,
      palifico: false,
      lockedFace: null,
      canChangeFace: mine.length === 1,
    };
    const a = bots.chooseTurnAction(view, anyPers());
    if (a.type === 'bid') {
      const v = validateBidWild(cur, { quantity: a.quantity, face: a.face });
      assert.ok(v.ok, `rilancio illegale jolly: ${JSON.stringify({ cur, a })} → ${v.reason}`);
    }
  }
});

test('fuzz palifico: rilanci sempre legali (valore bloccato)', () => {
  for (let i = 0; i < 400; i += 1) {
    const canChange = Math.random() < 0.5;
    const mine = dice(canChange ? 1 : 1 + Math.floor(Math.random() * 4));
    const locked = d6();
    const cur = { quantity: 1 + Math.floor(Math.random() * 6), face: locked };
    const view = {
      myDice: mine,
      totalDice: mine.length + 2 + Math.floor(Math.random() * 12),
      currentBid: cur,
      wild: false,
      palifico: true,
      lockedFace: locked,
      canChangeFace: canChange,
    };
    const a = bots.chooseTurnAction(view, anyPers());
    if (a.type === 'bid') {
      const v = validateBidPalifico(cur, { quantity: a.quantity, face: a.face }, locked, canChange);
      assert.ok(v.ok, `rilancio illegale palifico: ${JSON.stringify({ cur, a, locked, canChange })} → ${v.reason}`);
    }
  }
});

test('fallbackAction: sempre legale sopra qualunque dichiarazione', () => {
  for (let i = 0; i < 200; i += 1) {
    const wild = Math.random() < 0.5;
    const cur = { quantity: 1 + Math.floor(Math.random() * 8), face: d6() };
    const view = {
      myDice: dice(3),
      totalDice: 12,
      currentBid: cur,
      wild,
      palifico: false,
      lockedFace: null,
      canChangeFace: false,
    };
    const fb = bots.fallbackAction(view);
    assert.strictEqual(fb.type, 'bid');
    const v = wild
      ? validateBidWild(cur, { quantity: fb.quantity, face: fb.face })
      : validateBid(cur, { quantity: fb.quantity, face: fb.face });
    assert.ok(v.ok, `fallback illegale: ${JSON.stringify({ cur, fb, wild })} → ${v.reason}`);
  }
});

test('il dubbio scatta su dichiarazioni assurde', () => {
  // 20 dadi dichiarati su un tavolo da 10: qualunque personalità deve dubitare.
  const view = {
    myDice: [2, 3, 4],
    totalDice: 10,
    currentBid: { quantity: 20, face: 5 },
    wild: false,
    palifico: false,
    lockedFace: null,
    canChangeFace: false,
  };
  for (let i = 0; i < 50; i += 1) {
    const a = bots.chooseTurnAction(view, anyPers());
    assert.strictEqual(a.type, 'doubt');
  }
});
