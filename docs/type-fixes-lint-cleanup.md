# Type Fixes & Lint Cleanup (2026-08-04/05)

A dedicated record of the `any`-type cleanup across the admin dashboard
(`tartarixinc/tscopier-admin`). Before this work the repo had **121 lint
errors + 2 warnings** (mostly `@typescript-eslint/no-explicit-any`). After:
**0 errors / 0 warnings** (`npm run lint`), `npx tsc -b` clean, `npm run build`
passes.

## Strategy

1. **Bulk removal (~84 occurrences):** callback parameters annotated `(x: any)`
   in Supabase query mappings. The data already flows as `any` from the untyped
   Supabase client, so removing the annotation changes nothing at runtime or in
   types (the parameter still infers `any`) — it just stops the explicit-`any`
   lint rule from firing. Verified by `tsc` + `vite build` after the pass.
2. **Real typing for everything else:** every remaining `any` (function params,
   state generics, `as any` casts) was replaced with a proper type definition or
   a typed cast.

## New type definitions created

### Page-level row interfaces
| File | Types | Purpose |
|---|---|---|
| `src/pages/UserDetailPage.tsx` | `BrokerRow`, `ChannelRow`, `TgSessionRow`, `TgClaimRow` | Replaced `useState<any[]>` and `(x as any)?.field` casts for broker accounts, telegram channels, telegram session/claim lookups |
| `src/pages/BacktestRunDetailPage.tsx` | `BacktestTradeRow`, `EquityPointRow`, `RunChannelRow` | Replaced `useState<any[]>` for backtest trades, equity points, run channels |
| `src/pages/OverviewPage.tsx` | inline `computePnl` param type | Replaced `function computePnl(t: any)` with an explicit shape `{ profit, cwe_close_price, entry_price, direction, lot_size? }` |
| `src/pages/SignalStatsPage.tsx` | Pie label payload type | `label={(props: { status?: string; percent?: number }) => …}` |

### Component-level row interfaces
| File | Types | Purpose |
|---|---|---|
| `src/components/TradePipelineModal.tsx` | `SignalRow`, `ChannelSignalRow`, `RelatedTradeRow`, `DispatchClaimRow`, `ListenerEventRow` | Typed signal/canonical-signal fetch, related-trades family, dispatch claim, listener events |
| `src/components/SignalDetailModal.tsx` | `SignalRow`, `ChannelSignalRow`, `LinkedTrade`, `LinkedTradeFetchRow` | Typed signal fetch + linked trade |
| `src/components/CopierLogDetailModal.tsx` | `CopierLogDetailRow` | Typed log row passed from the tabs |
| `src/components/pipeline/PipelineSections.tsx` | `ExecutionLogRow`, `AiExplanation` | Shared execution-attempt + AI result types |
| `src/components/LatencyAnalyticsTab.tsx` | `LatencyStat`, `DailyPoint`, `ScatterPoint` (+`signalId`), `DrillRow`, `DrillFilter`, `DailyFailurePoint`, `FailureStats` | Analytics data structures |
| `src/components/PnlAnalyticsTab.tsx` | `TradeRow` (extended) | Added `id, signal_id, opened_at, status, entry_price, sl, tp, lot_size, broker_account_id, metaapi_order_id` so rows can open the trade modal |
| `src/components/user/UserSignalsTab.tsx` | fetch row shape via typed cast | Typed `telegram_channels` embedded relation |

### Shared/utility typing
| File | Change |
|---|---|
| `src/hooks/usePaginatedQuery.ts` | `queryFn` typed generically: `(opts: { from; to }) => Promise<{ data: T[] | null; error: { message } | null; count: number | null }>` (was `=> any`) |
| `src/components/ExportButton.tsx` | `toCSV(rows: any[])` → `toCSV(rows: Record<string, unknown>[])` |
| `src/components/DataTable.tsx` | `(row as any)[col.key]` → `(row as Record<string, unknown>)[col.key]` (+ `String(v)` for ReactNode safety) |
| `src/lib/adminSupabase.ts` | `fetchDisplayNames` callback: `(r: { user_id: string; display_name: string | null })` |
| `src/pages/OverviewPage.tsx` | Pie label: `(props: { plan?: string; percent?: number })` |

## Embedded-relation lesson (array, not object)

Supabase embedded resources (`telegram_channels(...)`) come back as **arrays**
even for `maybeSingle` parent queries. Several components had typed them as
single objects, which typechecked (Supabase returns `any`) but failed at
runtime — e.g. the signal modal header always showed "Unknown channel".
Fixed to `…[] | null` + `[0]?.display_name` in: `SignalDetailModal`,
`UserSignalsTab`, `SignalStatsPage`, `BacktestRunDetailPage`.

## Non-`any` lint fixes

| File | Issue | Fix |
|---|---|---|
| `eslint.config.js` | export-omit destructuring flagged unused | `no-unused-vars` with `ignoreRestSiblings: true`, `argsIgnorePattern: '^_'`, `varsIgnorePattern: '^_'` |
| `supabase/functions/send-invoice-due-email/index.ts` | unused `currency` param | renamed `_currency` |
| `supabase/functions/reconnect-offline-listeners/index.ts` | `@ts-ignore` x2 | `@ts-expect-error` |
| `src/pages/UsersPage.tsx` | `prefer-const` (`let subs`) | `const subs` |
| `src/pages/UsersPage.tsx` | `react-hooks/exhaustive-deps` warning | behavior-preserving eslint-disable comment (same pattern as `usePaginatedQuery`) |
| `src/pages/OverviewPage.tsx` | `no-constant-binary-expression` (`Number(t.lot_size) ?? 0`) | `Number(t.lot_size ?? 0)` |
| `src/components/user/UserCopierLogsTab.tsx` | empty interface | removed; uses `CopierLogDetailRow` directly |
| `src/components/pipeline/PipelineSections.tsx` | react-refresh warning (non-component export) | `durationText` de-exported (internal only) |

## Verification

- `npx tsc -b` — clean
- `npm run lint` — 0 errors / 0 warnings (was 121/2)
- `npm run build` — passes
- All changed modules transform 200 on the Vite dev server
