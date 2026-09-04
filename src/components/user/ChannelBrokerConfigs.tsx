import { useState } from 'react';
import { Copy, Check, Wallet, Target, Settings2, Filter, MessageSquareText, Coins, ScrollText } from 'lucide-react';
import { formatRelative } from '../../lib/formatters';
import { StatusBadge } from '../StatusBadge';
import { JsonViewer } from '../JsonViewer';
import { Tabs } from '../ui/Tabs';
import clsx from 'clsx';

interface ChannelInfo {
  id: string;
  display_name: string | null;
  channel_username: string | null;
  is_active: boolean;
  last_live_at: string | null;
}

interface BrokerAccountInfo {
  id: string;
  label: string;
  platform: string | null;
  connection_status: string | null;
  last_balance: number | null;
  last_equity: number | null;
  account_login: string | null;
  channel_trading_configs: unknown;
}

interface TradingConfig {
  copier_mode?: string | null;
  manual_settings?: unknown;
  ai_settings?: unknown;
}

type SettingRow = [string, string];

interface SettingsSection {
  title: string;
  rows: SettingRow[];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asManualSettings(raw: unknown): Record<string, unknown> | null {
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : null;
}

function configsForChannel(
  brokers: BrokerAccountInfo[],
  channelId: string,
): { linked: { broker: BrokerAccountInfo; config: TradingConfig }[]; unlinked: BrokerAccountInfo[] } {
  const key = channelId.toLowerCase();
  const linked: { broker: BrokerAccountInfo; config: TradingConfig }[] = [];
  const unlinked: BrokerAccountInfo[] = [];
  for (const b of brokers) {
    const map = (b.channel_trading_configs && typeof b.channel_trading_configs === 'object')
      ? b.channel_trading_configs as Record<string, TradingConfig>
      : {};
    const cfg = Object.entries(map).find(([k]) => k.toLowerCase() === key)?.[1];
    if (cfg) linked.push({ broker: b, config: cfg }); else unlinked.push(b);
  }
  return { linked, unlinked };
}

function describeManualSettings(ms: Record<string, unknown>): SettingsSection[] {
  const sections: SettingsSection[] = [];

  // Symbols
  const symbols: SettingRow[] = [];
  const symbolToTrade = ms.symbol_to_trade as string | null | undefined;
  const prefix = ms.symbol_prefix as string | null | undefined;
  const suffix = ms.symbol_suffix as string | null | undefined;
  const mapping = ms.symbol_mapping as Record<string, string> | null | undefined;
  const exclude = ms.symbols_exclude as string[] | null | undefined;
  if (symbolToTrade) {
    symbols.push(['Fixed symbol', `Always trades ${symbolToTrade}`]);
  } else {
    if (prefix) symbols.push(['Symbol prefix', `Adds "${prefix}" before the symbol name`]);
    if (suffix) symbols.push(['Symbol suffix', `Adds "${suffix}" after the symbol name`]);
  }
  if (Array.isArray(exclude) && exclude.length > 0) {
    symbols.push(['Excluded symbols', exclude.join(', ')]);
  }
  if (mapping && typeof mapping === 'object' && Object.keys(mapping).length > 0) {
    symbols.push(['Symbol mapping', `${Object.keys(mapping).length} symbol(s) renamed automatically`]);
  }
  if (symbols.length > 0) sections.push({ title: 'Symbols', rows: symbols });

  // Risk
  const risk: SettingRow[] = [];
  const riskMode = ms.risk_mode as string | null | undefined;
  const fixedLot = num(ms.fixed_lot);
  const dynamicPct = num(ms.dynamic_balance_percent);
  if (riskMode === 'dynamic_balance_percent' && dynamicPct != null) {
    risk.push(['Lot sizing', `Balance percent · ${dynamicPct}% per trade`]);
  } else if (fixedLot != null) {
    risk.push(['Lot sizing', `Fixed lot · ${fixedLot} per trade`]);
  }
  const tradeStyle = ms.trade_style as string | null | undefined;
  const legPct = num(ms.multi_trade_leg_percent);
  if (tradeStyle === 'multi') {
    risk.push(['Trade style', 'Opens several positions per signal']);
    if (legPct != null) risk.push(['Position size', `Each position uses ${legPct}% of the base lot`]);
  } else if (tradeStyle === 'single') {
    risk.push(['Trade style', 'One position per signal']);
  }
  const rangeTrading = ms.range_trading as boolean | null | undefined;
  const rangePct = num(ms.range_percent);
  const rangeStep = num(ms.range_step_pips);
  const rangeDist = num(ms.range_distance_pips);
  if (rangeTrading) {
    let rangeDesc = 'Spreads entries across a price range in layers';
    const parts: string[] = [];
    if (rangePct != null) parts.push(`${rangePct}% of plan`);
    if (rangeStep != null) parts.push(`${rangeStep}-pip steps`);
    if (rangeDist != null) parts.push(`up to ${rangeDist} pips`);
    if (parts.length > 0) rangeDesc = `Range entries · ${parts.join(', ')}`;
    risk.push(['Range entries', rangeDesc]);
    const layeringType = ms.range_layering_type as string | null | undefined;
    if (layeringType) risk.push(['Layering', layeringType === 'dynamic' ? 'Dynamic layer sizing' : 'Fixed layer sizing']);
    const tillClose = num(ms.range_layer_till_close);
    if (tillClose != null) risk.push(['Layer close', `Closes layers at ${tillClose} pips profit`]);
  }
  const singleTp = num(ms.single_tp_target);
  if (singleTp != null) risk.push(['Single TP', `Closes full position at ${singleTp} pips`]);
  const tolerance = num(ms.signal_entry_pip_tolerance);
  const useEntryPrice = ms.use_signal_entry_price as boolean | null | undefined;
  const useEntryRange = ms.use_signal_entry_range as boolean | null | undefined;
  if (useEntryPrice && tolerance != null) {
    risk.push(['Entry tolerance', `Only fills if live price is within ${tolerance} pips of the signal`]);
  } else if (useEntryRange) {
    risk.push(['Entry rule', 'Waits for price to reach the signal zone before entering']);
  }
  const closeWorse = ms.close_worse_entries as boolean | null | undefined;
  const cwPips = num(ms.close_worse_entries_pips);
  if (closeWorse === true) {
    risk.push(['Close early entries', cwPips != null ? `Closes instant entries if price moves ${cwPips}+ pips past signal` : 'Closes instant entries if price drifts past signal']);
  }
  if (risk.length > 0) sections.push({ title: 'Risk', rows: risk });

  // Targets
  const targets: SettingRow[] = [];
  const usePredefSl = ms.use_predefined_sl_pips as boolean | null | undefined;
  const predefSlPips = num(ms.predefined_sl_pips);
  if (usePredefSl && predefSlPips != null) {
    targets.push(['Stop loss', `Always set · ${predefSlPips} pips from entry`]);
  } else {
    targets.push(['Stop loss', 'Taken from the signal']);
  }
  const usePredefTp = ms.use_predefined_tp_pips as boolean | null | undefined;
  const predefTpPips = ms.predefined_tp_pips as number[] | null | undefined;
  if (usePredefTp && Array.isArray(predefTpPips) && predefTpPips.length > 0) {
    targets.push(['Take profits', predefTpPips.map((v, i) => `TP${i + 1} ${v}`).join(' · ')]);
  }
  if (targets.length > 0) sections.push({ title: 'Targets', rows: targets });

  // Management
  const mgmt: SettingRow[] = [];
  const bePips = num(ms.breakeven_offset_pips);
  if (bePips != null) mgmt.push(['Break-even', `Moves SL to entry once trade is +${bePips} pips`]);
  const trailing = ms.trailing_enabled as boolean | null | undefined;
  const tStart = num(ms.trailing_start_pips);
  const tStep = num(ms.trailing_step_pips);
  const tDist = num(ms.trailing_distance_pips);
  if (trailing) {
    const parts: string[] = [];
    if (tStart != null) parts.push(`starts at ${tStart} pips`);
    if (tStep != null) parts.push(`moves in ${tStep}-pip steps`);
    if (tDist != null) parts.push(`stays ${tDist} pips behind price`);
    mgmt.push(['Trailing stop', parts.length > 0 ? parts.join(' · ') : 'Active']);
  }
  const closeOpp = ms.close_on_opposite_signal as boolean | null | undefined;
  if (closeOpp === true) mgmt.push(['Opposite signal', 'Closes open trades first']);
  else if (closeOpp === false) mgmt.push(['Opposite signal', 'Keeps current trades open']);
  const pendingExp = num(ms.pending_expiry_hours);
  if (pendingExp != null) mgmt.push(['Pending orders', `Expire after ${pendingExp} hours`]);
  const moveSlMode = ms.move_sl_to_entry_after_mode as string | null | undefined;
  const moveSlVal = num(ms.move_sl_to_entry_after_value);
  if (moveSlMode && moveSlMode !== 'none') {
    const moveDesc = moveSlMode === 'pips' ? `after +${moveSlVal ?? '?'} pips`
      : moveSlMode === 'rr' ? `after risk-reward target`
        : moveSlMode === 'tp_hit' ? 'on TP hit'
          : moveSlMode;
    mgmt.push(['Move SL to entry', moveDesc]);
  }
  const moveSlTpIndex = num(ms.move_sl_to_entry_tp_index);
  if (moveSlTpIndex != null) mgmt.push(['Move SL trigger', `On TP${moveSlTpIndex} hit`]);
  const moveSlType = ms.move_sl_to_entry_type as string | null | undefined;
  if (moveSlType && moveSlType !== 'breakeven') mgmt.push(['Move SL type', moveSlType === 'trailing' ? 'Trailing entry level' : moveSlType]);
  const reverse = ms.reverse_signal as boolean | null | undefined;
  if (reverse === true) mgmt.push(['Reverse signal', 'Trades in the opposite direction of the signal']);
  const rrSlEnabled = ms.rr_for_sl_enabled as boolean | null | undefined;
  const rrSl = num(ms.rr_for_sl);
  if (rrSlEnabled && rrSl != null) mgmt.push(['RR for SL', `1 : ${rrSl}`]);
  const rrTpsEnabled = ms.rr_for_tps_enabled as boolean | null | undefined;
  const rrTps = ms.rr_for_tps as number[] | null | undefined;
  if (rrTpsEnabled && Array.isArray(rrTps) && rrTps.length > 0) {
    mgmt.push(['RR for TPs', rrTps.map(v => `1 : ${v}`).join(', ')]);
  }
  const partialClose = num(ms.half_close_percent);
  if (partialClose != null) mgmt.push(['Partial close', `${partialClose}% at first target`]);
  if (mgmt.length > 0) sections.push({ title: 'Management', rows: mgmt });

  // Filters
  const filters: SettingRow[] = [];
  const timeFilter = ms.time_filter_enabled as boolean | null | undefined;
  const startTime = ms.trade_start_time as string | null | undefined;
  const endTime = ms.trade_end_time as string | null | undefined;
  if (timeFilter && startTime && endTime) {
    filters.push(['Trading hours', `${startTime} → ${endTime}`]);
  }
  const daysFilter = ms.days_filter_enabled as boolean | null | undefined;
  const tradeDays = ms.trade_days as number[] | null | undefined;
  if (daysFilter && Array.isArray(tradeDays) && tradeDays.length > 0) {
    filters.push(['Trading days', tradeDays.map(d => DAY_NAMES[d] ?? `Day ${d}`).join(', ')]);
  }
  const newsEnabled = ms.news_trading_enabled as boolean | null | undefined;
  const impacts = ms.news_avoid_impacts as Array<'high' | 'medium' | 'low'> | null | undefined;
  if (newsEnabled === false) {
    const lvl = Array.isArray(impacts) && impacts.length > 0 ? impacts.map(i => `${i}-impact`).join('/') : 'high-impact';
    filters.push(['News filter', `Skips ${lvl} news`]);
  } else if (newsEnabled === true) {
    filters.push(['News filter', 'Trades through news windows']);
  }
  const closeBefore = num(ms.close_before_news_minutes);
  if (closeBefore != null) filters.push(['Close before news', `Closes ${closeBefore} min before high-impact events`]);
  const resumeAfter = num(ms.resume_after_news_minutes);
  if (resumeAfter != null) filters.push(['Resume after news', `Reopens ${resumeAfter} min after high-impact events`]);
  if (filters.length > 0) sections.push({ title: 'Filters', rows: filters });

  return sections;
}

function SettingRowComp({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-32 shrink-0 text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-xs text-slate-800 dark:text-slate-200">{value}</span>
    </div>
  );
}

function BrokerConfigCard({ broker, config, activeSection }: { broker: BrokerAccountInfo; config: TradingConfig; activeSection: string }) {
  const realMode = (config.copier_mode as string | null) ?? 'manual';

  const rawMs = config.manual_settings;
  const manualSettings = asManualSettings(rawMs);
  const rawAi = config.ai_settings;
  const aiSettings = (rawAi && typeof rawAi === 'object') ? rawAi : null;

  const sections = manualSettings ? describeManualSettings(manualSettings) : [];
  const section = sections.find(s => s.title === activeSection);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      {/* Broker header */}
      <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/60 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{broker.label}</span>
        {broker.platform && (
          <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px]">{broker.platform}</span>
        )}
        <StatusBadge status={broker.connection_status} dot />
        {broker.account_login && (
          <span className="text-[11px] font-mono text-slate-400">#{broker.account_login}</span>
        )}
        <span className="ml-auto text-xs text-slate-400">
          Balance {broker.last_balance != null ? `$${broker.last_balance.toLocaleString()}` : '—'}
        </span>
        <span className="text-xs text-slate-400">
          Equity {broker.last_equity != null ? `$${broker.last_equity.toLocaleString()}` : '—'}
        </span>
      </div>

      {/* Mode badge */}
      <div className="px-4 pt-3">
        <span className={clsx(
          'inline-block px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide',
          realMode === 'ai'
            ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
            : 'bg-warning-100 text-warning-700 dark:bg-warning-900/40 dark:text-warning-300',
        )}>
          {realMode === 'ai' ? 'AI' : 'Manual'}
        </span>
      </div>

      {/* Active section */}
      <div className="px-4 py-3">
        {activeSection === 'Signal Examples' ? (
          aiSettings && Object.keys(aiSettings as object).length > 0 ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              <SettingRowComp label="AI mode" value="Active — AI parses signals automatically" />
              <JsonViewer data={aiSettings} collapsed label="AI settings" />
            </div>
          ) : (
            <p className="text-xs text-slate-400 dark:text-slate-500">No AI training data configured.</p>
          )
        ) : activeSection === 'Instructions' ? (
          aiSettings && Object.keys(aiSettings as object).length > 0 ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              <SettingRowComp label="AI mode" value="Active — AI interprets signals with custom instructions" />
              <JsonViewer data={aiSettings} collapsed label="AI settings" />
            </div>
          ) : (
            <p className="text-xs text-slate-400 dark:text-slate-500">No channel instructions configured.</p>
          )
        ) : realMode === 'ai' ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The AI engine decides lot size and risk automatically based on account balance and signal quality.
          </p>
        ) : section && section.rows.length > 0 ? (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {section.rows.map(([label, value]) => (
              <SettingRowComp key={label} label={label} value={value} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400 dark:text-slate-500">{activeSection} not configured for this account.</p>
        )}

        {manualSettings && (
          <div className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-3">
            <JsonViewer data={manualSettings} collapsed label="All settings (JSON)" />
          </div>
        )}
      </div>
    </div>
  );
}

const SECTION_TABS: { value: string; label: string; icon: React.ReactNode }[] = [
  { value: 'Signal Examples', label: 'Signal Examples', icon: <MessageSquareText className="w-4 h-4" /> },
  { value: 'Symbols', label: 'Symbols', icon: <Coins className="w-4 h-4" /> },
  { value: 'Instructions', label: 'Instructions', icon: <ScrollText className="w-4 h-4" /> },
  { value: 'Risk', label: 'Risk', icon: <Wallet className="w-4 h-4" /> },
  { value: 'Targets', label: 'Targets', icon: <Target className="w-4 h-4" /> },
  { value: 'Management', label: 'Management', icon: <Settings2 className="w-4 h-4" /> },
  { value: 'Filters', label: 'Filters', icon: <Filter className="w-4 h-4" /> },
];

function sectionIdsForBrokers(linked: { broker: BrokerAccountInfo; config: TradingConfig }[]): string[] {
  const found = new Set<string>();
  for (const { config } of linked) {
    const manualSettings = asManualSettings(config.manual_settings);
    if (manualSettings) {
      for (const s of describeManualSettings(manualSettings)) found.add(s.title);
    }
    const rawAi = config.ai_settings;
    const aiSettings = (rawAi && typeof rawAi === 'object' && Object.keys(rawAi as object).length > 0) ? rawAi : null;
    if (aiSettings) {
      found.add('Signal Examples');
      found.add('Instructions');
    }
  }
  return SECTION_TABS.filter(t => found.has(t.value)).map(t => t.value);
}

export function ChannelBrokerConfigs({ channel, brokers }: { channel: ChannelInfo; brokers: BrokerAccountInfo[] }) {
  const { linked, unlinked } = configsForChannel(brokers, channel.id);
  const [copied, setCopied] = useState(false);
  const availableSections = sectionIdsForBrokers(linked);
  const [activeSection, setActiveSection] = useState<string>(availableSections[0] ?? 'Symbols');

  const handleCopy = () => {
    navigator.clipboard.writeText(channel.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const hasManual = availableSections.length > 0;

  return (
    <div className="space-y-4">
      {/* Channel meta */}
      <div className="flex items-center gap-3 flex-wrap">
        <StatusBadge status={channel.is_active ? 'active' : 'inactive'} dot />
        {channel.last_live_at && (
          <span className="text-xs text-slate-400">Last live {formatRelative(channel.last_live_at)}</span>
        )}
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400 hover:text-primary-500 transition-colors"
          title="Copy channel ID"
        >
          {channel.id.slice(0, 8)}…
          {copied ? <Check className="w-3 h-3 text-success-500" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>

      {/* Main layout: configured brokers + unlinked sidebar */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Left: configured brokers */}
        <div className="space-y-3 min-w-0 flex-1">
          {linked.length > 0 ? (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                  Copying to {linked.length} broker {linked.length === 1 ? 'account' : 'accounts'}
                </p>
              </div>

              {hasManual && (
                <Tabs
                  value={activeSection}
                  onChange={setActiveSection}
                  tabs={availableSections.map(v => {
                    const t = SECTION_TABS.find(s => s.value === v);
                    return t ? { value: t.value, label: t.label, icon: t.icon } : { value: v, label: v };
                  })}
                />
              )}

              <div className={clsx('grid gap-3', linked.length > 1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1')}>
                {linked.map(({ broker, config }) => (
                  <BrokerConfigCard key={broker.id} broker={broker} config={config} activeSection={activeSection} />
                ))}
              </div>
            </>
          ) : (
            <div className="text-center py-6">
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">No broker configurations</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Nothing from this channel is being copied anywhere right now.
                {unlinked.length > 0
                  ? ` The user has ${unlinked.length} broker account${unlinked.length > 1 ? 's' : ''} but none ${unlinked.length > 1 ? 'are' : 'is'} connected to this channel.`
                  : ' The user does not have any broker accounts.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
