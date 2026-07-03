import * as FileSystem from 'expo-file-system/legacy';

// Shared by every on-device cache/queue directory (profile icons, note images,
// pending offline uploads): create the directory if it doesn't exist yet.
export async function ensureDirExists(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}
