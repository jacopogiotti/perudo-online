/* global PerudoEngine, PerudoBots */
/**
 * local.js — partita LOCALE contro i bot: un "server in miniatura" nel browser.
 *
 * Riproduce, per un tavolo umano+bot, lo stesso flusso di server.js — lanci
 * scaglionati, turni dei bot con tempi di riflessione, scelta Palifico, Calza
 * fuori turno, conto alla rovescia della rivelazione — ed emette verso la UI
 * gli STESSI eventi del socket ('state', 'yourDice', 'spectatorDice'), così
 * l'interfaccia esistente funziona identica senza sapere di essere offline.
 *
 * Usa engine.js e bots.js (serviti come /lib/*): lo stesso identico codice
 * delle partite online.
 */
'use strict';

const Local = (() => {
  const REVEAL_MS = 20000;
  const MAX_PLAYERS = 8;
  const ME = 'me';

  let sim = null; // stato del tavolo locale
  const listeners = {}; // evento -> [callback]

  function on(ev, fn) {
    (listeners[ev] = listeners[ev] || []).push(fn);
  }
  function emit(ev, data) {
    for (const fn of listeners[ev] || []) fn(data);
  }
  function E() {
    return window.PerudoEngine;
  }
  function B() {
    return window.PerudoBots;
  }
  function active() {
    return !!sim;
  }

  // ---------- creazione / smontaggio ----------

  function start({ hostName, dicePerPlayer, mode, calzaRule, bots }) {
    const dice = Math.max(1, Math.min(5, parseInt(dicePerPlayer, 10) || 5));
    const n = Math.max(1, Math.min(MAX_PLAYERS - 1, parseInt(bots, 10) || 1));
    sim = {
      status: 'lobby',
      dicePerPlayer: dice,
      mode: ['standard', 'jolly', 'calza'].includes(mode) ? mode : 'standard',
      calzaRule: calzaRule === 'house' ? 'house' : 'official',
      players: [{ id: ME, name: hostName, isBot: false }],
      brains: {},
      game: null,
      rolled: new Set(),
      readyNext: new Set(),
      bidLog: [],
      _botTimer: null,
      _revealTimer: null,
      _calzaEval: null,
    };
    let i = 0;
    for (const b of B().makeBots(n, [hostName])) {
      i += 1;
      const id = 'bot' + i;
      sim.players.push({ id, name: b.name, isBot: true });
      sim.brains[id] = b.personality;
    }
    broadcast();
  }

  function destroy() {
    if (!sim) return;
    clearTimeout(sim._botTimer);
    clearTimeout(sim._revealTimer);
    sim = null;
  }

  // ---------- payload identico a quello del server ----------

  function readyInfo(gs) {
    if (!gs || gs.phase !== 'reveal') return null;
    const act = gs.players.filter((p) => p.alive).map((p) => p.id);
    return { readyIds: [...sim.readyNext].filter((id) => act.includes(id)), total: act.length };
  }
  function rollingInfo(gs) {
    if (!gs || gs.phase !== 'bidding') return null;
    const need = gs.players.filter((p) => p.alive).map((p) => p.id);
    return {
      rolledIds: [...sim.rolled].filter((id) => need.includes(id)),
      need,
      allRolled: need.length > 0 && need.every((id) => sim.rolled.has(id)),
    };
  }
  function allRolled() {
    const gs = sim.game.publicState();
    const need = gs.players.filter((p) => p.alive).map((p) => p.id);
    return need.length > 0 && need.every((id) => sim.rolled.has(id));
  }

  function payload() {
    const gs = sim.game ? sim.game.publicState() : null;
    const players = sim.players.map((p) => {
      const gp = gs && gs.players.find((x) => x.id === p.id);
      return {
        id: p.id,
        name: p.name,
        isHost: p.id === ME,
        connected: true,
        diceCount: gp ? gp.diceCount : sim.dicePerPlayer,
        alive: gp ? gp.alive : true,
        dice: gp ? gp.dice : null,
        isBot: p.isBot,
      };
    });
    return {
      local: true,
      code: null,
      status: sim.status,
      dicePerPlayer: sim.dicePerPlayer,
      mode: sim.mode,
      calzaRule: sim.calzaRule,
      maxPlayers: MAX_PLAYERS,
      minPlayers: 2,
      hostId: ME,
      paused: false,
      waitingFor: [],
      leftPlayers: [],
      disconnectedPlayers: [],
      players,
      game: gs
        ? {
            phase: gs.phase,
            roundNumber: gs.roundNumber,
            currentBid: gs.currentBid,
            turnPlayerId: gs.turnPlayerId,
            starterPlayerId: gs.starterPlayerId,
            winnerId: gs.winnerId,
            mode: gs.mode,
            calzaRule: gs.calzaRule,
            wild: gs.wild,
            palifico: gs.palifico,
            palificoPlayerId: gs.palificoPlayerId,
            palificoPending: gs.palificoPending,
            palificoPendingId: gs.palificoPendingId,
            lockedFace: gs.lockedFace,
            nextPlayerId: gs.nextPlayerId,
            lastResult: sim.game.lastResult || null,
            ready: readyInfo(gs),
            rolling: rollingInfo(gs),
            bidLog: sim.bidLog,
          }
        : null,
    };
  }

  function broadcast() {
    if (!sim) return;
    emit('state', payload());
    if (sim.game && sim.game.phase === 'bidding') {
      emit('yourDice', { dice: sim.game.diceFor(ME) });
      const me = sim.game.players.find((p) => p.id === ME);
      if (me && !me.alive) {
        emit('spectatorDice', {
          round: sim.game.roundNumber,
          players: sim.game.players
            .filter((p) => p.alive)
            .map((p) => ({ id: p.id, dice: p.dice })),
        });
      }
    }
    pump();
  }

  // ---------- flusso di partita (specchio di server.js) ----------

  function scheduleReveal() {
    if (!sim || sim._revealTimer) return;
    sim._revealTimer = setTimeout(() => {
      if (!sim) return;
      sim._revealTimer = null;
      if (!sim.game || sim.game.phase !== 'reveal') return;
      sim.game.startNextRound();
      sim.readyNext = new Set();
      sim.rolled = new Set();
      sim.bidLog = [];
      broadcast();
    }, REVEAL_MS);
  }

  function afterMove() {
    if (sim.game.phase === 'gameOver') {
      sim.status = 'finished';
    } else if (sim.game.phase === 'reveal') {
      sim.readyNext = new Set();
      if (sim._revealTimer) {
        clearTimeout(sim._revealTimer);
        sim._revealTimer = null;
      }
    }
    broadcast();
    if (sim.game && sim.game.phase === 'reveal') scheduleReveal();
  }

  function isBotId(id) {
    const p = sim.players.find((x) => x.id === id);
    return !!(p && p.isBot);
  }
  function botView(botId) {
    const g = sim.game;
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

  /** Prossima azione bot da pianificare (o null) — porting di server.js. */
  function planNext() {
    const g = sim.game;
    const brains = sim.brains;
    const bots = B();

    if (g.phase === 'reveal') {
      const act = g.players.filter((p) => p.alive).map((p) => p.id);
      const waiting = act.filter((id) => isBotId(id) && !sim.readyNext.has(id));
      if (!waiting.length) return null;
      const id = waiting[0];
      return {
        delay: bots.thinkDelay(brains[id], 'ready'),
        run: () => {
          if (!sim.game || sim.game.phase !== 'reveal') return pump();
          sim.readyNext.add(id);
          const act2 = sim.game.players.filter((p) => p.alive).map((p) => p.id);
          if (act2.length > 0 && act2.every((x) => sim.readyNext.has(x))) {
            clearTimeout(sim._revealTimer);
            sim._revealTimer = null;
            sim.game.startNextRound();
            sim.readyNext = new Set();
            sim.rolled = new Set();
            sim.bidLog = [];
          }
          broadcast();
        },
      };
    }

    if (g.phase !== 'bidding') return null;
    const gs = g.publicState();

    // 1) lanci scaglionati dei bot
    const toRoll = gs.players
      .filter((p) => p.alive && isBotId(p.id) && !sim.rolled.has(p.id))
      .map((p) => p.id);
    if (toRoll.length) {
      const id = toRoll[0];
      return {
        delay: bots.thinkDelay(brains[id], 'roll'),
        run: () => {
          if (!sim.game || sim.game.phase !== 'bidding') return pump();
          sim.rolled.add(id);
          broadcast();
        },
      };
    }

    // 2) scelta Palifico di un bot
    if (g.palificoPending && isBotId(g.palificoPendingId)) {
      const id = g.palificoPendingId;
      const pers = brains[id];
      return {
        delay: bots.thinkDelay(pers, 'palifico'),
        run: () => {
          if (!sim.game || !sim.game.palificoPending || sim.game.palificoPendingId !== id) {
            return pump();
          }
          sim.game.choosePalifico(id, bots.choosePalificoBot(pers));
          broadcast();
        },
      };
    }

    if (!allRolled() || g.palificoPending) return null;

    // 3) Calza fuori turno: una valutazione per dichiarazione
    if (sim.mode === 'calza' && g.currentBid && !g.palifico) {
      const bidKey =
        g.roundNumber + ':' + g.currentBid.quantity + 'x' + g.currentBid.face + ':' + g.currentBid.playerId;
      if (sim._calzaEval !== bidKey) {
        sim._calzaEval = bidKey;
        const turnP = g.currentPlayer();
        const cands = sim.players.filter((p) => p.isBot).sort(() => Math.random() - 0.5);
        for (const p of cands) {
          const gp = g.players.find((x) => x.id === p.id);
          if (!gp || !gp.alive || gp.diceCount >= g.dicePerPlayer) continue;
          if (p.id === g.currentBid.playerId) continue;
          if (g.calzaRule === 'official' && turnP && p.id === turnP.id) continue;
          if (!bots.considerCalza(botView(p.id), brains[p.id])) continue;
          const expected = { quantity: g.currentBid.quantity, face: g.currentBid.face };
          return {
            delay: bots.thinkDelay(brains[p.id], 'calza'),
            run: () => {
              if (!sim.game) return;
              const res = sim.game.calza(p.id, expected);
              if (res.ok) afterMove();
              else pump();
            },
          };
        }
      }
    }

    // 4) turno di un bot
    const turn = g.currentPlayer();
    if (turn && turn.alive && isBotId(turn.id)) {
      const pers = brains[turn.id];
      const bidBefore = g.currentBid ? g.currentBid.quantity + 'x' + g.currentBid.face : 'open';
      return {
        delay: bots.thinkDelay(pers, 'turn'),
        run: () => {
          const g2 = sim.game;
          if (!g2 || g2.phase !== 'bidding' || g2.palificoPending) return pump();
          const t2 = g2.currentPlayer();
          const bidNow = g2.currentBid ? g2.currentBid.quantity + 'x' + g2.currentBid.face : 'open';
          if (!t2 || t2.id !== turn.id || bidNow !== bidBefore) return pump();

          const view = botView(turn.id);
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
              sim.bidLog.push({ name: turn.name, quantity: action.quantity, face: action.face });
            }
          }
          if (!res || !res.ok) return pump();
          afterMove();
        },
      };
    }

    return null;
  }

  function pump() {
    if (!sim) return;
    if (sim._botTimer) {
      clearTimeout(sim._botTimer);
      sim._botTimer = null;
    }
    if (sim.status !== 'playing' || !sim.game) return;
    const plan = planNext();
    if (!plan) return;
    sim._botTimer = setTimeout(() => {
      if (!sim) return;
      sim._botTimer = null;
      if (sim.status !== 'playing' || !sim.game) return;
      plan.run();
    }, plan.delay);
  }

  // ---------- azioni dell'umano (stessa interfaccia degli eventi socket) ----------

  function handle(ev, data, cb) {
    const ok = (extra) => cb && cb(Object.assign({ ok: true }, extra || {}));
    const ko = (error) => cb && cb({ ok: false, error });
    if (!sim) return ko('Partita non attiva.');
    const g = sim.game;

    switch (ev) {
      case 'addBot': {
        if (sim.status !== 'lobby') return ko("I bot si aggiungono prima dell'avvio.");
        if (sim.players.length >= MAX_PLAYERS) {
          return ko(`Tavolo pieno (max ${MAX_PLAYERS} giocatori).`);
        }
        const [b] = B().makeBots(1, sim.players.map((p) => p.name));
        if (!b) return ko('Nessun nome disponibile per un altro bot.');
        const id = 'bot' + (sim.players.length + Math.floor(Math.random() * 1000));
        sim.players.push({ id, name: b.name, isBot: true });
        sim.brains[id] = b.personality;
        ok();
        return broadcast();
      }
      case 'kickPlayer': {
        if (sim.status !== 'lobby') return ko("Puoi espellere solo prima dell'avvio.");
        sim.players = sim.players.filter((p) => p.id !== data.playerId || p.id === ME);
        ok();
        return broadcast();
      }
      case 'movePlayer': {
        if (sim.status !== 'lobby') return ko("Si può riordinare solo prima dell'avvio.");
        const idx = sim.players.findIndex((p) => p.id === data.playerId);
        if (idx < 0) return ko('Mossa non valida.');
        let to = Number.isInteger(data.to) ? data.to : idx + (data.dir < 0 ? -1 : 1);
        to = Math.max(0, Math.min(sim.players.length - 1, to));
        if (to !== idx) {
          const [pl] = sim.players.splice(idx, 1);
          sim.players.splice(to, 0, pl);
        }
        ok();
        return broadcast();
      }
      case 'startGame': {
        if (sim.status !== 'lobby') return ko('La partita è già iniziata.');
        if (sim.players.length < 2) return ko('Servono almeno 2 giocatori.');
        const seats = sim.players.map((p) => ({ id: p.id, name: p.name }));
        sim.game = new (E().Game)(seats, sim.dicePerPlayer, {
          mode: sim.mode,
          calzaRule: sim.calzaRule,
        });
        sim.status = 'playing';
        sim.rolled = new Set();
        sim.bidLog = [];
        ok();
        return broadcast();
      }
      case 'rollDice': {
        if (!g || g.phase !== 'bidding') return ko('Non ora.');
        sim.rolled.add(ME);
        ok();
        return broadcast();
      }
      case 'placeBid': {
        if (!g) return ko('Partita non attiva.');
        if (!allRolled()) return ko('Aspetta che tutti lancino i dadi.');
        const res = g.placeBid(ME, data.quantity, data.face);
        if (!res.ok) return ko(res.reason);
        const meP = sim.players.find((p) => p.id === ME);
        sim.bidLog.push({ name: meP.name, quantity: data.quantity | 0, face: data.face | 0 });
        ok();
        return broadcast();
      }
      case 'challenge': {
        if (!g) return ko('Partita non attiva.');
        if (!allRolled()) return ko('Aspetta che tutti lancino i dadi.');
        const res = g.challenge(ME);
        if (!res.ok) return ko(res.reason);
        ok();
        return afterMove();
      }
      case 'calza': {
        if (!g) return ko('Partita non attiva.');
        if (!allRolled()) return ko('Aspetta che tutti lancino i dadi.');
        const res = g.calza(ME, data.expectedBid);
        if (!res.ok) return ko(res.reason);
        ok();
        return afterMove();
      }
      case 'choosePalifico': {
        if (!g) return ko('Partita non attiva.');
        const res = g.choosePalifico(ME, !!data.activate);
        if (!res.ok) return ko(res.reason);
        ok();
        return broadcast();
      }
      case 'readyNext': {
        if (!g || g.phase !== 'reveal') return ko('Non ora.');
        sim.readyNext.add(ME);
        ok();
        const act = g.players.filter((p) => p.alive).map((p) => p.id);
        if (act.length > 0 && act.every((x) => sim.readyNext.has(x))) {
          clearTimeout(sim._revealTimer);
          sim._revealTimer = null;
          g.startNextRound();
          sim.readyNext = new Set();
          sim.rolled = new Set();
          sim.bidLog = [];
        }
        return broadcast();
      }
      case 'rematch': {
        if (sim.status !== 'finished') return ko('La partita non è ancora finita.');
        const seats = sim.players.map((p) => ({ id: p.id, name: p.name }));
        sim.game = new (E().Game)(seats, sim.dicePerPlayer, {
          mode: sim.mode,
          calzaRule: sim.calzaRule,
        });
        sim.status = 'playing';
        sim.rolled = new Set();
        sim.readyNext = new Set();
        sim.bidLog = [];
        sim._calzaEval = null;
        ok();
        return broadcast();
      }
      case 'endGame': {
        ok();
        return destroy();
      }
      default:
        return ko('Azione non supportata in locale.');
    }
  }

  return { start, destroy, handle, on, active };
})();
