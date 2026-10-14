import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultConfig, validateConfig } from '../src/shared/config.js';
import EntryExecutionSelector from '../web/src/EntryExecutionSelector.js';
import { boundedPage } from '../web/src/use-bounded-page.js';
import { acceptSettingsSave, changeSettingsField, changeSettingsSymbols, initialSettingsDraft, observeSettingsConfig,
  restoreSettingsDraft, settingsConfigKey, settingsDraftForSave } from '../web/src/settings-draft.js';

test('accepted settings survive failed refresh and identical old dashboard snapshots', () => {
  const original = { ...defaultConfig, orderNotionalUsd: 100, autoEnabled: false };
  let state = changeSettingsField(initialSettingsDraft(original), 'orderNotionalUsd', 120);
  const accepted = validateConfig(settingsDraftForSave(state));
  state = acceptSettingsSave(state, state.editRevision, accepted);
  assert.equal(state.dirty, false);
  state = observeSettingsConfig(state, structuredClone(original));
  assert.equal(state.draft.orderNotionalUsd, 120, 'An unchanged, old observation cannot undo an accepted save.');
  state = restoreSettingsDraft(changeSettingsField(state, 'orderNotionalUsd', 130));
  assert.equal(state.draft.orderNotionalUsd, 120, 'Restore uses the last accepted configuration.');
  state = observeSettingsConfig(state, accepted);
  state = observeSettingsConfig(state, { ...accepted, orderNotionalUsd: 140 });
  assert.equal(state.draft.orderNotionalUsd, 140, 'A genuinely changed server configuration still synchronizes.');
});

test('editing during save keeps the new draft and restores the accepted baseline if requested', () => {
  const original = { ...defaultConfig, orderNotionalUsd: 100 };
  let state = changeSettingsField(initialSettingsDraft(original), 'orderNotionalUsd', 120);
  const submittedRevision = state.editRevision, accepted = validateConfig(settingsDraftForSave(state));
  state = changeSettingsField(state, 'orderNotionalUsd', 130);
  state = acceptSettingsSave(state, submittedRevision, accepted);
  state = observeSettingsConfig(state, accepted);
  assert.equal(state.draft.orderNotionalUsd, 130);
  assert.equal(state.dirty, true);
  assert.equal(state.expectedConfig.orderNotionalUsd, 120, 'The next save compares against the accepted version, even with later edits.');
  assert.equal(restoreSettingsDraft(state).draft.orderNotionalUsd, 120);
});

test('background polls cannot replace the version that an unsaved draft was based on', () => {
  const initial = { ...defaultConfig, orderNotionalUsd: 100 };
  let state = changeSettingsField(initialSettingsDraft(initial), 'orderNotionalUsd', 120);
  state = observeSettingsConfig(state, { ...initial, orderNotionalUsd: 150 });
  assert.equal(state.draft.orderNotionalUsd, 120);
  assert.equal(state.expectedConfig.orderNotionalUsd, 100);
  assert.equal(state.baseline.orderNotionalUsd, 150);
  state = restoreSettingsDraft(state);
  assert.equal(state.expectedConfig.orderNotionalUsd, 150);
  assert.equal(state.draft.orderNotionalUsd, 150);
});

test('Maker switching produces a supported draft without changing saved configuration', () => {
  const original = { ...defaultConfig, entryPolicy: 'aligned' as const, entryExecutionMode: 'maker-ioc' as const };
  for (const next of ['funding', 'dual'] as const) {
    const state = changeSettingsField(initialSettingsDraft(original), 'entryPolicy', next);
    assert.equal(state.draft.entryExecutionMode, 'ioc');
    assert.equal(validateConfig(settingsDraftForSave(state)).entryExecutionMode, 'ioc');
    assert.equal(original.entryExecutionMode, 'maker-ioc');
    const markup = renderToStaticMarkup(createElement(EntryExecutionSelector, { config: state.draft, onChange: () => {} }));
    assert.match(markup, /value="maker-ioc" disabled=""/);
    assert.match(markup, /当前入场模式使用 IOC/);
  }
  const aligned = renderToStaticMarkup(createElement(EntryExecutionSelector, { config: original, onChange: () => {} }));
  assert.doesNotMatch(aligned, /value="maker-ioc" disabled/);
});

test('unchanged configuration comparison includes native fee changes and ignores key ordering', () => {
  const original = { ...defaultConfig }, reverse = Object.fromEntries(Object.entries(original).reverse()) as typeof original;
  assert.equal(settingsConfigKey(original), settingsConfigKey(reverse));
  assert.notEqual(settingsConfigKey(original), settingsConfigKey({ ...original, takerFees: { ...original.takerFees, gate: .00049 } }));
});

test('symbol text accepts Chinese commas, removes duplicate symbols, and leaves the prior config intact', () => {
  const state = changeSettingsSymbols(initialSettingsDraft(defaultConfig), ' ct，SIREN, ct,, ');
  assert.deepEqual(settingsDraftForSave(state).symbols, ['CT', 'SIREN']);
  assert.notDeepEqual(defaultConfig.symbols, ['CT', 'SIREN']);
});

test('bounded pagination handles shrinking, empty and malformed list bounds', () => {
  assert.equal(boundedPage(3, 2), 2);
  assert.equal(boundedPage(2, 0), 1);
  assert.equal(boundedPage(NaN, 3), 1);
  assert.equal(boundedPage(2.7, 2.8), 2);
});
