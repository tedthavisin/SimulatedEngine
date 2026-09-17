"use strict";
// ---------------------------------------------------------------------------
// sim.js - the MODEL. Pure simulation state + fixed-step update.
// No DOM or canvas code here, so the same file is loaded by index.html
// (main-thread fallback) and by sim-worker.js (Web Worker).
//
// Everything in the state is plain data (numbers, arrays, objects) so it can
// be structured-cloned and posted between threads.
// ---------------------------------------------------------------------------
var Sim = (function () {

const DEBUG = true;       // log state every step (determinism check)
const DEBUG_TICKS = 180;  // ...but only for the first 3 seconds of simulation
const SEED = 20260916;    // fixed seed => identical runs every refresh
const DT = 1 / 60;        // fixed simulation step, in seconds

const DEG = Math.PI / 180;
const SWING_ANGLE = 40 * DEG;
const PICKUP_ANGLE = SWING_ANGLE;
const DROP_ANGLE = -SWING_ANGLE;
const MAX_ANGLE = 55 * DEG;
const SNAP = 4 * DEG;         // how close the arm must be to a station to grab / place
const TURN_SPEED = 75 * DEG;  // rad/sec while an arrow key is held
const GRIP_SPEED = 1 / 0.3;   // gripper fully closes in 0.3 sec

const BELT_Y = 380;
const FLOOR_Y = 460;
const CRATE = 40;

const L1 = 170;   // the single rigid arm segment
const WRIST = 40; // wrist housing + gripper hub, held vertical
const PIVOT = { x: 450, y: (BELT_Y - CRATE) - L1 * Math.cos(SWING_ANGLE) - WRIST };

const PICKUP = { x: PIVOT.x - L1 * Math.sin(SWING_ANGLE), y: BELT_Y };
const DROP = { x: PIVOT.x + L1 * Math.sin(SWING_ANGLE), y: BELT_Y };

const BELT_LEN = 300;
const INFEED_LEFT = Math.round(PICKUP.x) - BELT_LEN, INFEED_RIGHT = Math.round(PICKUP.x);
const OUTFEED_LEFT = Math.round(DROP.x), OUTFEED_RIGHT = Math.round(DROP.x) + BELT_LEN;
const MIN_GAP = 55;     // closest two crates on the same belt may sit
const BELT_SPEED = 35;  // px/sec

const GRAVITY = 1400;      // px/sec^2 for dropped crates
const SHATTER_TIME = 0.6;  // sec a broken crate's pieces stay on screen
const MAX_BROKEN = 3;

// mulberry32 - tiny seeded PRNG whose state lives inside the sim state,
// so crate colors are the same on every run.
function random(s) {
  let t = (s.rngSeed = (s.rngSeed + 0x6D2B79F5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function newCrate(s, x) {
  return { id: s.nextId++, x, y: BELT_Y, hue: Math.floor(random(s) * 360) };
}

function spawnInterval(score) {
  return Math.max(1.8, 5 - 0.15 * score); // crates arrive faster as you score
}

function createState(seed, best, game) {
  const s = {
    game: game || 0, // bumped on restart so the renderer never interpolates across games
    tick: 0,
    rngSeed: seed | 0,
    nextId: 1,
    arm: { angle: 0, grip: 0, gripTarget: 0, carrying: null },
    infeed: [],
    outfeed: [],
    falling: [],
    score: 0,
    best: best || 0,
    broken: 0,
    spawnTimer: 0,
    gameOver: false,
    gameOverReason: '',
  };
  s.infeed.push(newCrate(s, PICKUP.x - 120), newCrate(s, PICKUP.x - 175));
  s.spawnTimer = spawnInterval(0);
  return s;
}

// Forward kinematics - same transforms drawArm applies:
// rotate(angle), translate(0, L1), rotate(-angle), translate(0, WRIST).
function gripperHub(angle) {
  return { x: PIVOT.x - L1 * Math.sin(angle), y: PIVOT.y + L1 * Math.cos(angle) + WRIST };
}

function groundY(x) {
  const onInfeed = x >= INFEED_LEFT && x <= INFEED_RIGHT;
  const onOutfeed = x >= OUTFEED_LEFT && x <= OUTFEED_RIGHT;
  return onInfeed || onOutfeed ? BELT_Y : FLOOR_Y;
}

function approach(value, target, maxDelta) {
  return value < target ? Math.min(target, value + maxDelta) : Math.max(target, value - maxDelta);
}

function advanceQueue(queue, wallX, dt) {
  queue.sort((a, b) => b.x - a.x);
  for (let i = 0; i < queue.length; i++) {
    const maxX = i === 0 ? wallX : queue[i - 1].x - MIN_GAP;
    queue[i].x = Math.min(queue[i].x + BELT_SPEED * dt, maxX);
  }
}

function frontCrateReady(s) {
  return s.infeed.length > 0 && s.infeed[0].x >= PICKUP.x - 0.5;
}

// Which station (if any) the arm is currently lined up with - used for the
// gripper highlight so the player knows when to press Space.
function hint(s) {
  const arm = s.arm;
  if (arm.carrying) return Math.abs(arm.angle - DROP_ANGLE) <= SNAP ? 'drop' : null;
  return Math.abs(arm.angle - PICKUP_ANGLE) <= SNAP && frontCrateReady(s) ? 'pickup' : null;
}

function tryPickup(s) {
  const arm = s.arm;
  if (Math.abs(arm.angle - PICKUP_ANGLE) > SNAP || !frontCrateReady(s)) return;
  const crate = s.infeed.shift();
  arm.carrying = { id: crate.id, hue: crate.hue };
  arm.angle = PICKUP_ANGLE;
}

function release(s) {
  const arm = s.arm;
  const crate = arm.carrying;
  arm.carrying = null;

  const nearDrop = Math.abs(arm.angle - DROP_ANGLE) <= SNAP;
  const last = s.outfeed[s.outfeed.length - 1]; // queue is sorted, so this is the crate nearest DROP
  const room = !last || last.x >= DROP.x + MIN_GAP - 0.5;

  if (nearDrop && room) {
    arm.angle = DROP_ANGLE;
    s.outfeed.push({ id: crate.id, x: DROP.x, y: BELT_Y, hue: crate.hue });
    s.score++;
    s.best = Math.max(s.best, s.score);
  } else {
    // Let go in the wrong place (or on top of another crate) - it drops and breaks.
    const hub = gripperHub(arm.angle);
    s.falling.push({ id: crate.id, x: hub.x, y: hub.y + CRATE, vy: 0, hue: crate.hue, shatter: -1 });
  }
}

function updateFalling(s) {
  for (const c of s.falling) {
    if (c.shatter >= 0) { c.shatter += DT; continue; }
    c.vy += GRAVITY * DT;
    c.y += c.vy * DT;
    const ground = groundY(c.x);
    if (c.y >= ground) {
      c.y = ground;
      c.shatter = 0;
      s.broken++;
    }
  }
  s.falling = s.falling.filter(c => c.shatter < SHATTER_TIME);
}

function endGame(s, reason) {
  s.gameOver = true;
  s.gameOverReason = reason;
}

// One fixed step of the simulation. input = { left, right, toggleGrip, restart }.
// Returns the (possibly new) state object.
function update(s, input) {
  if (input.restart) {
    return createState(Math.floor(random(s) * 0x7fffffff), s.best, s.game + 1);
  }

  s.tick++;
  updateFalling(s);

  if (!s.gameOver) {
    const arm = s.arm;

    // ←/→ move the gripper left/right. Canvas rotation is clockwise, so moving
    // the gripper right means a smaller angle.
    const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    arm.angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, arm.angle - turn * TURN_SPEED * DT));

    if (input.toggleGrip) {
      arm.gripTarget = arm.gripTarget ? 0 : 1;
      if (!arm.gripTarget && arm.carrying) release(s);
    }
    const wasClosed = arm.grip >= 1;
    arm.grip = approach(arm.grip, arm.gripTarget, GRIP_SPEED * DT);
    if (!wasClosed && arm.grip >= 1 && !arm.carrying) tryPickup(s);

    advanceQueue(s.infeed, PICKUP.x, DT);
    advanceQueue(s.outfeed, Infinity, DT);
    s.outfeed = s.outfeed.filter(c => c.x < OUTFEED_RIGHT); // shipped out the chute

    s.spawnTimer -= DT;
    if (s.spawnTimer <= 0) {
      const last = s.infeed[s.infeed.length - 1];
      if (last && last.x < INFEED_LEFT + MIN_GAP) {
        endGame(s, 'The infeed belt backed up!');
      } else {
        s.infeed.push(newCrate(s, INFEED_LEFT));
        s.spawnTimer = spawnInterval(s.score);
      }
    }

    if (s.broken >= MAX_BROKEN) endGame(s, MAX_BROKEN + ' crates broken!');
  }

  if (DEBUG && s.tick <= DEBUG_TICKS) {
    console.log("tick: " + s.tick + " arm.angle: " + s.arm.angle +
                " infeed[0].x: " + (s.infeed.length ? s.infeed[0].x : '-'));
  }
  return s;
}

// Runs n fixed steps. The first step gets the frame's input as-is; later steps
// in the same frame only see held keys, so a single Space press toggles once.
// Returns the state before the last step (prev) and after it (curr) for
// interpolated rendering.
function run(state, n, input) {
  const heldOnly = { left: input.left, right: input.right, toggleGrip: false, restart: false };
  let prev = state;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) prev = structuredClone(state);
    state = update(state, i === 0 ? input : heldOnly);
  }
  return { prev, curr: state };
}

return {
  DEBUG, DEBUG_TICKS, SEED, DT, SHATTER_TIME, MAX_BROKEN,
  BELT_Y, FLOOR_Y, CRATE, L1, WRIST, PIVOT, BELT_SPEED,
  INFEED_LEFT, INFEED_RIGHT, OUTFEED_LEFT, OUTFEED_RIGHT,
  createState, update, run, hint,
};

})();
