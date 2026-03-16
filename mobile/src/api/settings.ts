import { Platform } from 'react-native';
import api from './client';
import { User, AuthResponse, UpdateMeRequest, ChangePasswordRequest, AboutInfo } from '../types';

export async function updateMe(data: UpdateMeRequest): Promise<AuthResponse> {
  const res = await api.patch('/users/me', data);
  return res.data;
}

export async function changePassword(data: ChangePasswordRequest): Promise<void> {
  await api.put('/users/me/password', data);
}

export async function uploadProfileIcon(uri: string): Promise<User> {
  const formData = new FormData();
  const filename = uri.split('/').pop() || 'photo.jpg';
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpeg';
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const type = mimeMap[ext] || 'image/jpeg';

  formData.append('file', {
    uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
    name: filename,
    type,
  } as unknown as Blob);

  const res = await api.post('/users/me/profile-icon', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function deleteProfileIcon(): Promise<void> {
  await api.delete('/users/me/profile-icon');
}

export async function getAboutInfo(): Promise<AboutInfo> {
  const res = await api.get('/about');
  return res.data;
}
