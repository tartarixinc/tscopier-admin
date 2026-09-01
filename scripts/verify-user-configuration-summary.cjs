const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'src', 'lib', 'userConfigurationSummary.ts');
const bodyPath = path.join(root, 'src', 'components', 'pipeline', 'SignalPipelineBody.tsx');
const sectionsPath = path.join(root, 'src', 'components', 'pipeline', 'PipelineSections.tsx');

function loadTsModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require,
    console,
  }, { filename: filePath });
  return module.exports;
}

const {
  buildUserConfigurationSummary,
  formatConfigBoolean,
} = loadTsModule(helperPath);

const broker = {
  id: 'broker-1',
  label: 'Primary MT5',
  platform: 'MT5',
  broker_name: 'Example Broker',
  copier_mode: 'manual',
  trade_allowed: true,
  manual_settings: {
    risk_mode: 'fixed_lot',
    lot_size: 0.05,
    risk_percent: 1,
    require_sl: true,
    fallback_sl_pips: 30,
    take_profit_mode: 'first_tp',
    breakeven_enabled: false,
    trailing_stop_enabled: true,
    layering_mode: 'split_tp',
    range_trading_enabled: true,
    copy_limit: 3,
    password: 'do-not-render',
  },
  ai_settings: {
    ai_enabled: true,
    api_key: 'do-not-render',
  },
  channel_trading_configs: {
    'channel-1': {
      lot_size_override: 0.1,
      pip_tolerance_override: 5,
      token: 'do-not-render',
    },
  },
};

const signal = {
  channel_id: 'channel-1',
  channel_signal_id: null,
  parsed_data: { reason_code: 'SIGNAL_MISSING_REQUIRED_SL' },
  skip_reason: 'stop_loss_missing',
};

const executionLogs = [
  {
    action: 'dispatch_push_attempt',
    status: 'success',
    request_payload: {
      order: {
        volume: 0.1,
        applied_risk_percent: 1.5,
      },
      token: 'do-not-render',
    },
    response_payload: { ticket: 123 },
    broker_account_id: 'broker-1',
    created_at: '2026-08-25T12:00:00Z',
  },
];

const summary = buildUserConfigurationSummary(broker, signal, {
  trade: { broker_account_id: 'broker-1', lot_size: 0.1 },
  executionLogs,
});
const byLabel = new Map(summary.items.map(item => [item.label, item]));
const rendered = JSON.stringify(summary);

assert.equal(summary.brokerLabel, 'Primary MT5');
assert.equal(byLabel.get('Copier mode').value, 'Manual');
assert.equal(byLabel.get('Trading allowed').value, 'Yes');
assert.equal(byLabel.get('Lot size used').value, '0.1 lots');
assert.equal(byLabel.get('Lot size used').source, 'Channel override');
assert.equal(byLabel.get('Risk used').value, '1.5%');
assert.equal(byLabel.get('Risk used').source, 'Execution data');
assert.equal(byLabel.get('Stop loss required').value, 'Yes');
assert.equal(byLabel.get('Range trading').value, 'Enabled');
assert.ok(!byLabel.has('Channel lot override'));
assert.ok(summary.items.length <= 10);
assert.equal(formatConfigBoolean(false), 'Disabled');
assert.equal(formatConfigBoolean(false, 'yes'), 'No');
assert.ok(!rendered.includes('do-not-render'));
assert.ok(!rendered.includes('api_key'));
assert.equal(buildUserConfigurationSummary(null, null).items.length, 0);
assert.doesNotThrow(() => buildUserConfigurationSummary({ ...broker, manual_settings: null, ai_settings: null, channel_trading_configs: null }, {
  channel_id: null,
  channel_signal_id: null,
  parsed_data: null,
  skip_reason: null,
}));

const configuredOnlySummary = buildUserConfigurationSummary(broker, signal);
const configuredOnly = new Map(configuredOnlySummary.items.map(item => [item.label, item]));
assert.equal(configuredOnly.get('Configured lot size').value, '0.1 lots');
assert.equal(configuredOnly.get('Configured lot size').source, 'Channel override');
assert.equal(configuredOnly.get('Configured risk %').value, '1%');
assert.equal(configuredOnly.get('Configured risk %').source, 'Account setting');
assert.ok(!configuredOnly.has('Lot size used'));
assert.ok(!configuredOnly.has('Risk used'));

const olderSignalSummary = buildUserConfigurationSummary(
  { ...broker, manual_settings: {}, ai_settings: {}, channel_trading_configs: null },
  { channel_id: null, channel_signal_id: null, parsed_data: null, skip_reason: null },
);
assert.equal(olderSignalSummary.items.length >= 3, true);
assert.ok(!JSON.stringify(olderSignalSummary).includes('Not available'));

const managementSettingsSummary = buildUserConfigurationSummary({
  id: 'broker-2',
  label: 'Management MT5',
  platform: 'MT5',
  broker_name: null,
  copier_mode: null,
  trade_allowed: null,
  manual_settings: {
    breakeven_enabled: false,
    trailing_stop_enabled: true,
  },
  ai_settings: null,
  channel_trading_configs: null,
}, {
  channel_id: null,
  channel_signal_id: null,
  parsed_data: null,
  skip_reason: null,
});
const managementByLabel = new Map(managementSettingsSummary.items.map(item => [item.label, item]));
assert.equal(managementByLabel.get('Breakeven').value, 'Disabled');
assert.equal(managementByLabel.get('Trailing stop').value, 'Enabled');

const bodySource = fs.readFileSync(bodyPath, 'utf8');
const sectionsSource = fs.readFileSync(sectionsPath, 'utf8');
assert.ok(!bodySource.includes('ExecutionAttemptsSection'), 'Signal/Error pipeline body must not render ExecutionAttemptsSection');
assert.ok(bodySource.includes('UserConfigurationSection'), 'Signal/Error pipeline body should render UserConfigurationSection');
assert.ok(bodySource.includes('executionLogs={executionLogs}'), 'Execution logs should feed derived trade configuration only');
assert.ok(bodySource.includes('ModelDecisionChainSection'), 'Model decision chain should remain');
assert.ok(bodySource.includes('AiVerificationSection'), 'AI verification should remain');
assert.ok(bodySource.includes('PipelineTimelineSection'), 'Pipeline timeline should remain');
assert.ok(bodySource.includes('LatencyBreakdownSection'), 'Latency breakdown should remain');
assert.ok(sectionsSource.includes('Trade configuration'), 'Compact section should be titled Trade configuration');
assert.ok(!/JsonViewer\s+data=\{[^}]*manual_settings/.test(bodySource), 'Raw manual_settings JSON must not be dumped');
assert.ok(!/JsonViewer\s+data=\{[^}]*ai_settings/.test(bodySource), 'Raw ai_settings JSON must not be dumped');
assert.ok(!/JsonViewer\s+data=\{[^}]*channel_trading_configs/.test(bodySource), 'Raw channel_trading_configs JSON must not be dumped');

console.log('user configuration summary checks passed');
