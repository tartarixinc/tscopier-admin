import { useState } from 'react';
import { Zap, TrendingUp, ScrollText } from 'lucide-react';
import { Tabs } from '../ui/Tabs';
import { UserSignalsTab } from './UserSignalsTab';
import { UserTradesTab } from './UserTradesTab';
import { UserCopierLogsTab } from './UserCopierLogsTab';

type ActivityTab = 'signals' | 'trades' | 'logs';

interface UserActivityTabsProps {
  userId: string;
  counts: { signals: number; trades: number; logs: number };
}

export function UserActivityTabs({ userId, counts }: UserActivityTabsProps) {
  const [active, setActive] = useState<ActivityTab>('signals');

  return (
    <div>
      <Tabs<ActivityTab>
        value={active}
        onChange={setActive}
        tabs={[
          { value: 'signals', label: 'Signals', count: counts.signals, icon: <Zap className="w-4 h-4" /> },
          { value: 'trades', label: 'Trades', count: counts.trades, icon: <TrendingUp className="w-4 h-4" /> },
          { value: 'logs', label: 'Copier Logs', count: counts.logs, icon: <ScrollText className="w-4 h-4" /> },
        ]}
      />
      <div className="mt-4">
        {active === 'signals' && <UserSignalsTab userId={userId} />}
        {active === 'trades' && <UserTradesTab userId={userId} />}
        {active === 'logs' && <UserCopierLogsTab userId={userId} />}
      </div>
    </div>
  );
}