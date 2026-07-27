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
import { readResource, writeResource } from './openwook/cache';

interface LanguageContextValue {
  language: Language;
  tr: (english: string, simplifiedChinese: string) => string;
}

interface LanguageActionsContextValue {
  languageSaving: boolean;
  reloadLanguage: () => Promise<void>;
  setLanguage: (language: Language) => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);
const LanguageActionsContext = createContext<LanguageActionsContextValue | null>(null);

export function LanguageProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<Language>(() => systemLanguage());
  const [languageSaving, setLanguageSaving] = useState(false);
  const languageRef = useRef<Language>(language);
  const operationRef = useRef(0);
  const savingRef = useRef(false);

  const applyLanguage = useCallback((nextLanguage: Language) => {
    languageRef.current = nextLanguage;
    setLanguageState(nextLanguage);
  }, []);

  const reloadLanguage = useCallback(async () => {
    const operation = ++operationRef.current;
    const value = await readResource<string>('setting:language');
    if (operation !== operationRef.current) return;
    applyLanguage(value ? normalizeLanguage(value) : systemLanguage());
  }, [applyLanguage]);

  useEffect(() => {
    void reloadLanguage().catch(() => undefined);
    return () => { operationRef.current += 1; };
  }, [reloadLanguage]);

  const setLanguage = useCallback(async (nextLanguage: Language) => {
    if (savingRef.current || nextLanguage === languageRef.current) return;
    const operation = ++operationRef.current;
    const previousLanguage = languageRef.current;
    savingRef.current = true;
    setLanguageSaving(true);
    applyLanguage(nextLanguage);
    try {
      await writeResource('setting:language', nextLanguage);
    } catch (error) {
      if (operation === operationRef.current) applyLanguage(previousLanguage);
      throw error;
    } finally {
      savingRef.current = false;
      setLanguageSaving(false);
    }
  }, [applyLanguage]);

  const tr = useCallback(
    (english: string, simplifiedChinese: string) => translate(language, english, simplifiedChinese),
    [language],
  );
  const languageValue = useMemo(() => ({ language, tr }), [language, tr]);
  const actionsValue = useMemo(
    () => ({ languageSaving, reloadLanguage, setLanguage }),
    [languageSaving, reloadLanguage, setLanguage],
  );
  return (
    <LanguageContext.Provider value={languageValue}>
      <LanguageActionsContext.Provider value={actionsValue}>
        {children}
      </LanguageActionsContext.Provider>
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}

export function useLanguageActions() {
  const context = useContext(LanguageActionsContext);
  if (!context) throw new Error('useLanguageActions must be used within LanguageProvider');
  return context;
}
