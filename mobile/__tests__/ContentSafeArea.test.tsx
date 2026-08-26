import { useContext } from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';
import { ContentSafeArea, useDeviceSafeAreaInsets } from '../src/components/ContentSafeArea';
import { useBannerShown } from '../src/hooks/useBannerShown';

jest.mock('../src/hooks/useBannerShown', () => ({
  useBannerShown: jest.fn(),
}));

const mockBannerShown = useBannerShown as jest.MockedFunction<typeof useBannerShown>;

const DEVICE_INSETS: EdgeInsets = { top: 47, right: 4, bottom: 34, left: 4 };

function ContentInsetsProbe() {
  const insets = useContext(SafeAreaInsetsContext);
  return <Text testID="content-insets">{JSON.stringify(insets)}</Text>;
}

function DeviceInsetsProbe() {
  const insets = useDeviceSafeAreaInsets();
  return <Text testID="device-insets">{JSON.stringify(insets)}</Text>;
}

function renderProbes() {
  return render(
    <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>
      <ContentSafeArea>
        <ContentInsetsProbe />
        <DeviceInsetsProbe />
      </ContentSafeArea>
    </SafeAreaInsetsContext.Provider>,
  );
}

const readInsets = (element: { props: Record<string, unknown> }): EdgeInsets =>
  JSON.parse(element.props.children as string);

describe('ContentSafeArea', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the device insets through untouched when no banner is shown', async () => {
    mockBannerShown.mockReturnValue(false);

    const { getByTestId } = await renderProbes();

    expect(readInsets(getByTestId('content-insets'))).toEqual(DEVICE_INSETS);
  });

  // Regression: the banner pads the top safe area itself, so content below it
  // that also applies insets.top leaves a gap the height of the status bar —
  // which is what the drawer, the Archive/Bin headers, and Diagnostics each hit
  // when they applied the inset unconditionally.
  it('zeroes the top inset for content below the banners while a banner is shown', async () => {
    mockBannerShown.mockReturnValue(true);

    const { getByTestId } = await renderProbes();

    expect(readInsets(getByTestId('content-insets'))).toEqual({ ...DEVICE_INSETS, top: 0 });
  });

  it('leaves the other edges alone while a banner is shown', async () => {
    mockBannerShown.mockReturnValue(true);

    const { getByTestId } = await renderProbes();
    const insets = readInsets(getByTestId('content-insets'));

    expect(insets.bottom).toBe(DEVICE_INSETS.bottom);
    expect(insets.left).toBe(DEVICE_INSETS.left);
    expect(insets.right).toBe(DEVICE_INSETS.right);
  });

  it('still exposes the real device insets to full-screen modals above the banners', async () => {
    mockBannerShown.mockReturnValue(true);

    const { getByTestId } = await renderProbes();

    expect(readInsets(getByTestId('device-insets'))).toEqual(DEVICE_INSETS);
  });
});

describe('useDeviceSafeAreaInsets outside ContentSafeArea', () => {
  it('falls back to the ambient safe-area insets', async () => {
    const { getByTestId } = await render(
      <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>
        <DeviceInsetsProbe />
      </SafeAreaInsetsContext.Provider>,
    );

    expect(readInsets(getByTestId('device-insets'))).toEqual(DEVICE_INSETS);
  });

  it('falls back to zero insets when there is no provider at all', async () => {
    const { getByTestId } = await render(<DeviceInsetsProbe />);

    expect(readInsets(getByTestId('device-insets'))).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
