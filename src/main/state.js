'use strict';

const STATES = Object.freeze([
  'idle',
  'arming',
  'listening',
  'thinking',
  'pasting',
  'error',
]);

const TRANSITIONS = Object.freeze({
  idle: Object.freeze({ BEGIN: 'arming' }),
  arming: Object.freeze({
    CAPTURE_STARTED: 'listening',
    CANCEL: 'idle',
  }),
  listening: Object.freeze({
    RELEASE: 'thinking',
    CANCEL: 'idle',
  }),
  thinking: Object.freeze({
    TEXT_READY: 'pasting',
    CANCEL: 'idle',
  }),
  pasting: Object.freeze({
    COMPLETE: 'idle',
    CANCEL: 'idle',
  }),
  error: Object.freeze({ RESET: 'idle' }),
});

class DictationStateMachine {
  #onTransition;
  #state = 'idle';

  constructor({ onTransition = () => {} } = {}) {
    if (typeof onTransition !== 'function') {
      throw new TypeError('onTransition must be a function.');
    }
    this.#onTransition = onTransition;
  }

  get state() {
    return this.#state;
  }

  can(event) {
    return event === 'FAIL' || Boolean(TRANSITIONS[this.#state]?.[event]);
  }

  transition(event, detail = {}) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('A state-machine event must be a non-empty string.');
    }

    const from = this.#state;
    const to = event === 'FAIL' ? 'error' : TRANSITIONS[from]?.[event];
    if (!to) {
      throw new Error(`Invalid dictation transition: ${from} + ${event}.`);
    }

    this.#state = to;
    const transition = Object.freeze({
      from,
      to,
      event,
      detail: Object.freeze({ ...detail }),
    });
    this.#onTransition(transition);
    return transition;
  }
}

module.exports = {
  DictationStateMachine,
  STATES,
  TRANSITIONS,
};
