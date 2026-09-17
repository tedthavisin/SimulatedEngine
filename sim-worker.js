"use strict";
// ---------------------------------------------------------------------------
// sim-worker.js - runs the simulation (sim.js) off the main thread.
// The page tells it how many fixed steps to run each frame (plus that frame's
// input); it replies with the prev/curr snapshots the page interpolates between.
// ---------------------------------------------------------------------------
importScripts('sim.js');

let state = Sim.createState(Sim.SEED);

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'run') return;
  const result = Sim.run(state, msg.n, msg.input);
  state = result.curr;
  self.postMessage(result); // structured clone - the page gets its own copy
};
