import { useState } from 'react';
import { Zap, TrendingUp, ScrollText, BarChart3 } from 'lucide-react';
import { Tabs } from '../ui/Tabs';
import { UserStatisticsTab } from './UserStatisticsTab';
import { UserSignalsTab } from './UserSignalsTab';
import { UserTradesTab } from './UserTradesTab';
import { UserCopierLogsTab } from './UserCopierLogsTab';

type ActivityTab = 'statistics' | 'signals' | 'trades' | 'logs';

interface UserActivityTabsProps {
  userId: string;
  counts: { signals: number; trades: number; logs: number };
}

export function UserActivityTabs({ userId, counts }: UserActivityTabsProps) {
  const [active, setActive] = useState<ActivityTab>('statistics');

  return (
    <div>
      <Tabs<ActivityTab>
        value={active}
        onChange={setActive}
        tabs={[
          { value: 'statistics', label: 'Statistics', icon: <BarChart3 className="w-4 h-4" /> },
          { value: 'signals', label: 'Signals', count: counts.signals, icon: <Zap className="w-4 h-4" /> },
          { value: 'trades', label: 'Trades', count: counts.trades, icon: <TrendingUp className="w-4 h-4" /> },
          { value: 'logs', label: 'Copier Logs', count: counts.logs, icon: <ScrollText className="w-4 h-4" /> },
        ]}
      />
      <div className="mt-4">
        {active === 'statistics' && <UserStatisticsTab userId={userId} />}
        {active === 'signals' && <UserSignalsTab userId={userId} />}
        {active === 'trades' && <UserTradesTab userId={userId} />}
        {active === 'logs' && <UserCopierLogsTab userId={userId} />}
      </div>
    </div>
  );
}
