import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import { normalizeLanguage, systemLanguage, translate, type Language } from './i18n';
import { readResource, writeResource } from './practiq/cache';

interface LanguageContextValue {
  language: Language;
  tr: (english: string, simplifiedChinese: string) => string;
  setLanguage: (language: Language) => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<Language>(() => systemLanguage());
  const languageRef = useRef<Language>(language);
  // Set once the user picks a language (or the provider unmounts) so a slow
  // startup cache read cannot override the explicit choice.
  const touchedRef = useRef(false);

  const applyLanguage = useCallback((nextLanguage: Language) => {
    languageRef.current = nextLanguage;
    setLanguageState(nextLanguage);
  }, []);

  useEffect(() => {
    void readResource<string>('setting:language')
      .then((value) => {
        if (!touchedRef.current && value) applyLanguage(normalizeLanguage(value));
      })
      .catch(() => undefined);
    return () => { touchedRef.current = true; };
  }, [applyLanguage]);

  const setLanguage = useCallback(async (nextLanguage: Language) => {
    touchedRef.current = true;
    if (nextLanguage === languageRef.current) return;
    const previousLanguage = languageRef.current;
    applyLanguage(nextLanguage);
    try {
      await writeResource('setting:language', nextLanguage);
    } catch (error) {
      applyLanguage(previousLanguage);
      throw error;
    }
  }, [applyLanguage]);

  const value = useMemo(() => ({
    language,
    setLanguage,
    tr: (english: string, simplifiedChinese: string) => translate(language, english, simplifiedChinese),
  }), [language, setLanguage]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}
