import test from 'node:test';
import assert from 'node:assert/strict';
import {displayPollInterval,listenForForeground} from '../web/src/display-polling.js';

test('display polling slows only hidden pages and foreground restoration requests fresh data', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,'document');
  const document = Object.assign(new EventTarget(),{hidden:false});
  Object.defineProperty(globalThis,'document',{value:document,configurable:true});
  try {
    let refreshes = 0;
    const stop = listenForForeground(() => { refreshes++; });
    assert.equal(displayPollInterval(2000),2000);
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(displayPollInterval(2000),15_000);
    assert.equal(displayPollInterval(5000),15_000);
    assert.equal(displayPollInterval(30_000),30_000);
    assert.equal(refreshes,0);
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(refreshes,1);
    assert.equal(displayPollInterval(5000),5000);
    stop();
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(refreshes,1,'unmounted pages must not restart a request');
  } finally {
    if(original) Object.defineProperty(globalThis,'document',original);
    else Reflect.deleteProperty(globalThis,'document');
  }
});
