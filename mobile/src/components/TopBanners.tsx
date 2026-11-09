import { useTopBanner, type TopBannerKey } from '../hooks/useTopBanners';
import OfflineBanner from './OfflineBanner';
import SSEReconnectBanner from './SSEReconnectBanner';
import SyncErrorBanner from './SyncErrorBanner';
import RevalidationErrorBanner from './RevalidationErrorBanner';
import SyncFailuresBanner from './SyncFailuresBanner';

/**
 * Renders the top-of-screen banner. All banners stay mounted so they can
 * animate in/out; {@link useTopBanner} picks the one that is shown, which also
 * owns the top safe-area inset. The priority between them lives there.
 *
 * Render this above `ContentSafeArea`, never inside it: the banners need the
 * device's real top inset, and everything below them needs it zeroed.
 */
export default function TopBanners() {
  const shown = useTopBanner();

  const propsFor = (key: TopBannerKey) => ({
    visible: shown === key,
    applyTopInset: shown === key,
  });

  return (
    <>
      <OfflineBanner {...propsFor('offline')} />
      <SSEReconnectBanner {...propsFor('sseReconnect')} />
      <SyncErrorBanner {...propsFor('syncError')} />
      <RevalidationErrorBanner {...propsFor('revalidation')} />
      <SyncFailuresBanner {...propsFor('syncFailures')} />
    </>
  );
}
