import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../store/AuthContext';
import i18n from './index';
import { getLanguagePreference, resolveLanguage } from './language';

export default function MobileI18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useAuth();

  useEffect(() => {
    const preference = getLanguagePreference(settings?.language);
    void i18n.changeLanguage(resolveLanguage(preference));
  }, [settings?.language]);

  return <>{children}</>;
}
