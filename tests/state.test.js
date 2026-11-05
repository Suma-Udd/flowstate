'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DictationStateMachine,
  STATES,
} = require('../src/main/state');

test('dictation state machine follows the complete happy-path trace', () => {
  const trace = [];
  const machine = new DictationStateMachine({
    onTransition: ({ from, to }) => trace.push(`${from}->${to}`),
  });

  for (const event of [
    'BEGIN',
    'CAPTURE_STARTED',
    'RELEASE',
    'TEXT_READY',
    'COMPLETE',
  ]) {
    machine.transition(event);
  }

  assert.equal(machine.state, 'idle');
  assert.deepEqual(trace, [
    'idle->arming',
    'arming->listening',
    'listening->thinking',
    'thinking->pasting',
    'pasting->idle',
  ]);
});

test('sub-threshold capture cancels from arming or listening', () => {
  for (const captureStarted of [false, true]) {
    const machine = new DictationStateMachine();
    machine.transition('BEGIN');
    if (captureStarted) machine.transition('CAPTURE_STARTED');
    machine.transition('CANCEL');
    assert.equal(machine.state, 'idle');
  }
});

test('shutdown cancellation can return every active phase to idle', () => {
  for (const path of [
    ['BEGIN'],
    ['BEGIN', 'CAPTURE_STARTED'],
    ['BEGIN', 'CAPTURE_STARTED', 'RELEASE'],
    ['BEGIN', 'CAPTURE_STARTED', 'RELEASE', 'TEXT_READY'],
  ]) {
    const machine = new DictationStateMachine();
    for (const event of path) machine.transition(event);
    machine.transition('CANCEL');
    assert.equal(machine.state, 'idle');
  }
});

test('error is reachable from every state and resets only to idle', () => {
  for (const target of STATES) {
    const machine = new DictationStateMachine();
    const path = {
      idle: [],
      arming: ['BEGIN'],
      listening: ['BEGIN', 'CAPTURE_STARTED'],
      thinking: ['BEGIN', 'CAPTURE_STARTED', 'RELEASE'],
      pasting: ['BEGIN', 'CAPTURE_STARTED', 'RELEASE', 'TEXT_READY'],
      error: ['FAIL'],
    }[target];
    for (const event of path) machine.transition(event);

    if (target !== 'error') machine.transition('FAIL', { reason: 'failure' });
    assert.equal(machine.state, 'error');
    machine.transition('RESET');
    assert.equal(machine.state, 'idle');
  }
});

test('invalid state transitions are rejected instead of becoming ad-hoc state', () => {
  const machine = new DictationStateMachine();
  assert.throws(() => machine.transition('RELEASE'), /Invalid dictation transition/);
  assert.equal(machine.state, 'idle');
});
