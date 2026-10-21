import { Toggle } from './ui/Toggle';
import { useHideTestAccounts } from '../lib/testAccounts';

export function HideTestAccountsToggle() {
  const [hideTestAccounts, setHideTestAccounts] = useHideTestAccounts();

  return (
    <Toggle
      checked={hideTestAccounts}
      onChange={setHideTestAccounts}
      label="Hide test accounts"
      size="sm"
    />
  );
}
