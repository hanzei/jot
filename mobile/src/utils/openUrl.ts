import { Linking } from 'react-native';

/**
 * Opens an external URL, swallowing the failure.
 *
 * Shared by every surface that renders a link out of user-authored text, so the
 * logging rule below is stated once: URLs here come from note content, and logs
 * are persisted to disk and embedded in shared diagnostics reports, so only the
 * scheme is logged. The scheme is what makes an open fail, which keeps the
 * diagnostic value without the note content.
 */
export async function openUrl(url: string): Promise<void> {
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) return;
    await Linking.openURL(url);
  } catch (e) {
    const scheme = url.split(':', 1)[0];
    console.warn(`openUrl: failed to open url with scheme "${scheme}"`, e);
  }
}
