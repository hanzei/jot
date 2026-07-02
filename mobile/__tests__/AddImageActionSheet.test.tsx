import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import AddImageActionSheet from '../src/components/AddImageActionSheet';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    colors: {
      overlay: 'rgba(0,0,0,0.4)',
      sheetBackground: '#fff',
      handleColor: '#ddd',
      text: '#111',
      icon: '#444',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockDocumentPicker = DocumentPicker as jest.Mocked<typeof DocumentPicker>;

describe('AddImageActionSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('picks a photo from the camera when permission is granted', async () => {
    mockImagePicker.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: true } as never);
    mockImagePicker.launchCameraAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', fileSize: 1234 }],
    } as never);
    const onPick = jest.fn();

    const { getByTestId } = render(
      <AddImageActionSheet visible onClose={jest.fn()} onPick={onPick} onPermissionDenied={jest.fn()} remainingSlots={10} />,
    );
    fireEvent.press(getByTestId('add-image-camera'));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith([
      { uri: 'file:///photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 1234 },
    ]));
  });

  it('reports a denied camera permission instead of launching the camera', async () => {
    mockImagePicker.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: false } as never);
    const onPermissionDenied = jest.fn();

    const { getByTestId } = render(
      <AddImageActionSheet visible onClose={jest.fn()} onPick={jest.fn()} onPermissionDenied={onPermissionDenied} remainingSlots={10} />,
    );
    fireEvent.press(getByTestId('add-image-camera'));

    await waitFor(() => expect(onPermissionDenied).toHaveBeenCalledWith('camera'));
    expect(mockImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('caps the library selection limit at the remaining image slots', async () => {
    mockImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValueOnce({ granted: true } as never);
    mockImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true } as never);

    const { getByTestId } = render(
      <AddImageActionSheet visible onClose={jest.fn()} onPick={jest.fn()} onPermissionDenied={jest.fn()} remainingSlots={3} />,
    );
    fireEvent.press(getByTestId('add-image-library'));

    await waitFor(() => expect(mockImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ selectionLimit: 3, allowsMultipleSelection: true }),
    ));
  });

  it('never asks the library picker for a zero selection limit', async () => {
    mockImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValueOnce({ granted: true } as never);
    mockImagePicker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true } as never);

    const { getByTestId } = render(
      <AddImageActionSheet visible onClose={jest.fn()} onPick={jest.fn()} onPermissionDenied={jest.fn()} remainingSlots={0} />,
    );
    fireEvent.press(getByTestId('add-image-library'));

    await waitFor(() => expect(mockImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ selectionLimit: 1 }),
    ));
  });

  it('picks multiple image files from the Files source', async () => {
    mockDocumentPicker.getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: 'file:///a.png', name: 'a.png', mimeType: 'image/png', size: 10 },
        { uri: 'file:///b.png', name: 'b.png', mimeType: null, size: 20 },
      ],
    } as never);
    const onPick = jest.fn();

    const { getByTestId } = render(
      <AddImageActionSheet visible onClose={jest.fn()} onPick={onPick} onPermissionDenied={jest.fn()} remainingSlots={10} />,
    );
    fireEvent.press(getByTestId('add-image-files'));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith([
      { uri: 'file:///a.png', name: 'a.png', mimeType: 'image/png', sizeBytes: 10 },
      { uri: 'file:///b.png', name: 'b.png', mimeType: 'image/png', sizeBytes: 20 },
    ]));
  });

  it('does nothing when the Files picker is canceled', async () => {
    mockDocumentPicker.getDocumentAsync.mockResolvedValueOnce({ canceled: true } as never);
    const onPick = jest.fn();

    const { getByTestId } = render(
      <AddImageActionSheet visible onClose={jest.fn()} onPick={onPick} onPermissionDenied={jest.fn()} remainingSlots={10} />,
    );
    fireEvent.press(getByTestId('add-image-files'));

    await waitFor(() => expect(mockDocumentPicker.getDocumentAsync).toHaveBeenCalled());
    expect(onPick).not.toHaveBeenCalled();
  });
});
