/**
 * Loads the subscriber record into the state before a run and saves it
 * after, even when a node throws. The record carries everything that has to
 * survive between messages: country, add-ons, saved route and station, and
 * the open steps (a pending fare amount, a road report waiting for a place).
 * That is what makes a conversation resumable on any server instance.
 */
const caps = require('../capabilities');
const fuelChecks = require('../fuel-checks');
const broadcast = require('../broadcast');
const { ready: apiReady } = require('../api');

class SubscriberCheckpointer {
  async load(state) {
    await caps.ready();
    await fuelChecks.ready();
    await apiReady();
    await broadcast.ready();
    state.user = await caps.ensure(state.hash, state.channel);
    if (state.from) state.user.reach = state.from;
  }

  async save(state) {
    if (state.user) await caps.flush(state.hash, state.channel);
  }
}

module.exports = { SubscriberCheckpointer };
