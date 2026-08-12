import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthGuard } from './components/AuthGuard';
import { AdminShell } from './components/AdminShell';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { UsersPage } from './pages/UsersPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { BrokerAccountsPage } from './pages/BrokerAccountsPage';
import { BrokerErrorsPage } from './pages/BrokerErrorsPage';
import { TelegramSessionsPage } from './pages/TelegramSessionsPage';
import { TelegramChannelsPage } from './pages/TelegramChannelsPage';
import { ChannelSignalProfilesPage } from './pages/ChannelSignalProfilesPage';
import { TelegramAuthPendingPage } from './pages/TelegramAuthPendingPage';
import { SignalsPage } from './pages/SignalsPage';
import { SignalStatsPage } from './pages/SignalStatsPage';
import { TradesPage } from './pages/TradesPage';
import { OpenPositionsPage } from './pages/OpenPositionsPage';
import { TradeExecutionLogsPage } from './pages/TradeExecutionLogsPage';
import { TradesAnalyticsPage } from './pages/TradesAnalyticsPage';
import { BacktestRunsPage } from './pages/BacktestRunsPage';
import { BacktestRunDetailPage } from './pages/BacktestRunDetailPage';
import { ListenerEventsPage } from './pages/ListenerEventsPage';
import { WorkerLeasesPage } from './pages/WorkerLeasesPage';
import { DeadLettersPage } from './pages/DeadLettersPage';
import { AffiliatesPage } from './pages/AffiliatesPage';
import { PresetsPage } from './pages/PresetsPage';
import { AppSettingsPage } from './pages/AppSettingsPage';
import { CopierLogsPage } from './pages/CopierLogsPage';
import { CopierEnginePage } from './pages/CopierEnginePage';
import { ErrorsPage } from './pages/ErrorsPage';
import { ErrorsAnalyticsPage } from './pages/ErrorsAnalyticsPage';
import { ReportsPage } from './pages/ReportsPage';

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AdminShell>{children}</AdminShell>
    </AuthGuard>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<ProtectedLayout><OverviewPage /></ProtectedLayout>} />
        <Route path="/users" element={<ProtectedLayout><UsersPage /></ProtectedLayout>} />
        <Route path="/users/:userId" element={<ProtectedLayout><UserDetailPage /></ProtectedLayout>} />
        <Route path="/brokers" element={<ProtectedLayout><BrokerAccountsPage /></ProtectedLayout>} />
        <Route path="/brokers/errors" element={<ProtectedLayout><BrokerErrorsPage /></ProtectedLayout>} />
        <Route path="/telegram/sessions" element={<ProtectedLayout><TelegramSessionsPage /></ProtectedLayout>} />
        <Route path="/telegram/channels" element={<ProtectedLayout><TelegramChannelsPage /></ProtectedLayout>} />
        <Route path="/telegram/profiles" element={<ProtectedLayout><ChannelSignalProfilesPage /></ProtectedLayout>} />
        <Route path="/telegram/auth-pending" element={<ProtectedLayout><TelegramAuthPendingPage /></ProtectedLayout>} />
        <Route path="/signals" element={<ProtectedLayout><SignalsPage /></ProtectedLayout>} />
        <Route path="/signals/stats" element={<ProtectedLayout><SignalStatsPage /></ProtectedLayout>} />
        <Route path="/trades" element={<ProtectedLayout><TradesPage /></ProtectedLayout>} />
        <Route path="/trades/open" element={<ProtectedLayout><OpenPositionsPage /></ProtectedLayout>} />
        <Route path="/trades/execution-logs" element={<ProtectedLayout><TradeExecutionLogsPage /></ProtectedLayout>} />
        <Route path="/trades/analytics" element={<ProtectedLayout><TradesAnalyticsPage /></ProtectedLayout>} />
        <Route path="/backtests" element={<ProtectedLayout><BacktestRunsPage /></ProtectedLayout>} />
        <Route path="/backtests/:runId" element={<ProtectedLayout><BacktestRunDetailPage /></ProtectedLayout>} />
        <Route path="/monitoring/listener-events" element={<ProtectedLayout><ListenerEventsPage /></ProtectedLayout>} />
        <Route path="/monitoring/workers" element={<ProtectedLayout><WorkerLeasesPage /></ProtectedLayout>} />
        <Route path="/monitoring/copier-engine" element={<ProtectedLayout><CopierEnginePage /></ProtectedLayout>} />
        <Route path="/monitoring/dead-letters" element={<ProtectedLayout><DeadLettersPage /></ProtectedLayout>} />
        <Route path="/affiliates" element={<ProtectedLayout><AffiliatesPage /></ProtectedLayout>} />
        <Route path="/presets" element={<ProtectedLayout><PresetsPage /></ProtectedLayout>} />
        <Route path="/settings" element={<ProtectedLayout><AppSettingsPage /></ProtectedLayout>} />
        <Route path="/copier-logs" element={<ProtectedLayout><CopierLogsPage /></ProtectedLayout>} />
        <Route path="/errors" element={<ProtectedLayout><ErrorsPage /></ProtectedLayout>} />
        <Route path="/errors/analytics" element={<ProtectedLayout><ErrorsAnalyticsPage /></ProtectedLayout>} />
        <Route path="/reports" element={<ProtectedLayout><ReportsPage /></ProtectedLayout>} />
      </Routes>
    </BrowserRouter>
  );
}
