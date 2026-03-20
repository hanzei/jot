import type { TFunction } from 'i18next';
import i18n from './index';

export function displayMessage(t: TFunction, message: string): string {
  return i18n.exists(message) ? t(message) : message;
}

export function getCurrentLocale(): string | undefined {
  return i18n.resolvedLanguage || i18n.language || undefined;
}
