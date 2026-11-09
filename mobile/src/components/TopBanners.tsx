import { useTopBanners } from '../hooks/useTopBanners';
import StatusBanner from './StatusBanner';
import SyncFailuresBanner from './SyncFailuresBanner';

/**
 * Renders the top-of-screen banners: the connection/session status, and below
 * it the failed-changes banner. {@link useTopBanners} decides what is shown;
 * the upper of the two shown banners owns the top safe-area inset.
 *
 * Render this above `ContentSafeArea`, never inside it: the banners need the
 * device's real top inset, and everything below them needs it zeroed.
 */
export default function TopBanners() {
  const { status, syncFailures } = useTopBanners();

  return (
    <>
      <StatusBanner status={status} applyTopInset={status !== null} />
      <SyncFailuresBanner visible={syncFailures} applyTopInset={status === null && syncFailures} />
    </>
  );
}
