import React from 'react';
import { useVisibleTopBanners, type TopBannerKey } from '../hooks/useTopBanners';
import OfflineBanner from './OfflineBanner';
import SSEReconnectBanner from './SSEReconnectBanner';
import SyncErrorBanner from './SyncErrorBanner';
import RevalidationErrorBanner from './RevalidationErrorBanner';
import SyncFailuresBanner from './SyncFailuresBanner';

/**
 * Renders the top-of-screen banner stack. All banners stay mounted so they can
 * animate in/out; {@link useVisibleTopBanners} is the single source of truth
 * for which are visible and which one owns the top safe-area inset (the topmost
 * visible banner). This is the only place stacking order is encoded.
 *
 * Render this above `ContentSafeArea`, never inside it: the banners need the
 * device's real top inset, and everything below them needs it zeroed.
 */
export default function TopBanners() {
  const visible = useVisibleTopBanners();
  const topMost = visible[0];

  const propsFor = (key: TopBannerKey) => ({
    visible: visible.includes(key),
    applyTopInset: topMost === key,
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
