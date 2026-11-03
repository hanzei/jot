import { Linking } from 'react-native';
import { act, waitFor } from '@testing-library/react-native';

type RenderedNode = { props?: Record<string, unknown>; children?: unknown[] } | string | null;

/**
 * The URL handed to the OS when the first tappable node in `tree` is pressed.
 * Mobile passes a link node's `href` straight to `Linking`, so this is where an
 * unencoded target would surface.
 */
export async function openedUrl(tree: RenderedNode): Promise<string> {
  const canOpenURL = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const find = (node: RenderedNode): (() => void) | null => {
    if (node === null || typeof node === 'string') return null;
    if (typeof node.props?.onPress === 'function') return node.props.onPress as () => void;
    for (const child of node.children ?? []) {
      const hit = find(child as RenderedNode);
      if (hit) return hit;
    }
    return null;
  };
  try {
    const press = find(tree);
    if (!press) throw new Error('nothing tappable');
    await act(async () => press());
    await waitFor(() => expect(openURL).toHaveBeenCalled());
    return openURL.mock.calls[0]![0];
  } finally {
    canOpenURL.mockRestore();
    openURL.mockRestore();
  }
}
