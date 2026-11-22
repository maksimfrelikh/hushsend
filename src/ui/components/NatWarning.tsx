import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Space, AlertLine } from '../ui';

/**
 * The network check's one visible verdict before a connection (core/natCheck.ts): this network is
 * behind a symmetric NAT, so Max privacy will very likely fail from here. Rendered under the title of
 * every screen a Max-privacy pairing waits on; nothing for `direct`, `unknown` or no answer yet — a
 * line that is always there is a line nobody reads. Advisory: it changes nothing by itself.
 *
 * `center` is for the centred screens (Connecting, the reconnect wait), where it is a description
 * paragraph like the ones around it instead of the alert line of the left-aligned screens.
 */
export function NatWarning({ center = false }: { center?: boolean }): ReactElement | null {
  const t = useT();
  const nat = useAppSelector((s) => s.connection.nat);
  if (nat?.verdict !== 'symmetric') return null;
  const text = nat.ipv6 ? `${t('natWarning')} ${t('natWarningIpv6')}` : t('natWarning');
  return (
    <>
      <Space h={12} />
      {center ? (
        <p className="hs-p hs-p--muted hs-p--narrow" role="alert" data-testid="nat-warning">
          {text}
        </p>
      ) : (
        <AlertLine testId="nat-warning">{text}</AlertLine>
      )}
    </>
  );
}
