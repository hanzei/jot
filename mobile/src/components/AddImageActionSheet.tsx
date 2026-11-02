import { useCallback } from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Camera, Folder, Images } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useTheme } from '../theme/ThemeContext';
import BottomSheet from './BottomSheet';
import type { ImageUploadFile } from '../api/images';

interface AddImageActionSheetProps {
  visible: boolean;
  onClose: () => void;
  onPick: (files: ImageUploadFile[]) => void;
  onPermissionDenied: (source: 'camera' | 'library') => void;
  /** Passed to the library picker's selection cap; always at least 1 so a full note can still open the picker (the resulting overflow is rejected with an error, mirroring the webapp). */
  remainingSlots: number;
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function inferImageMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME_TYPES[ext] ?? 'image/jpeg';
}

function assetToFile(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): ImageUploadFile {
  const name = asset.fileName ?? asset.uri.split('/').pop() ?? 'photo.jpg';
  return {
    uri: asset.uri,
    name,
    mimeType: asset.mimeType ?? inferImageMimeType(name),
    sizeBytes: asset.fileSize ?? undefined,
  };
}

// Bottom sheet offering the three image sources from spec §3.2: Camera, Photo
// Library, and Files (Expo pickers, images only). Each source's picker call
// and permission handling lives here so NoteEditorScreen only deals with the
// resulting file list.
export default function AddImageActionSheet({ visible, onClose, onPick, onPermissionDenied, remainingSlots }: AddImageActionSheetProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const handleCamera = useCallback(async () => {
    onClose();
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      onPermissionDenied('camera');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled || !result.assets?.length) return;
    onPick(result.assets.map(assetToFile));
  }, [onClose, onPick, onPermissionDenied]);

  const handleLibrary = useCallback(async () => {
    onClose();
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      onPermissionDenied('library');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(remainingSlots, 1),
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.length) return;
    onPick(result.assets.map(assetToFile));
  }, [onClose, onPick, onPermissionDenied, remainingSlots]);

  const handleFiles = useCallback(async () => {
    onClose();
    const result = await DocumentPicker.getDocumentAsync({
      type: 'image/*',
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;
    onPick(
      result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? inferImageMimeType(asset.name),
        sizeBytes: asset.size ?? undefined,
      })),
    );
  }, [onClose, onPick]);

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('images.addImage')} testID="add-image-sheet">
      <TouchableOpacity style={styles.row} onPress={handleCamera} testID="add-image-camera" accessibilityRole="button">
        <Camera size={22} color={colors.icon} />
        <Text style={[styles.rowText, { color: colors.text }]}>{t('images.camera')}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.row} onPress={handleLibrary} testID="add-image-library" accessibilityRole="button">
        <Images size={22} color={colors.icon} />
        <Text style={[styles.rowText, { color: colors.text }]}>{t('images.photoLibrary')}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.row} onPress={handleFiles} testID="add-image-files" accessibilityRole="button">
        <Folder size={22} color={colors.icon} />
        <Text style={[styles.rowText, { color: colors.text }]}>{t('images.files')}</Text>
      </TouchableOpacity>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
  },
  rowText: {
    fontSize: 16,
  },
});
