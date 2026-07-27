import { useSQLiteContext } from 'expo-sqlite';
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

import { writeTransaction } from './database';
import { normalizeLanguage, systemLanguage, translate, type Language } from './i18n';

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
  const db = useSQLiteContext();
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
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', 'language');
    if (operation !== operationRef.current) return;
    applyLanguage(row ? normalizeLanguage(row.value) : systemLanguage());
  }, [applyLanguage, db]);

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
      await writeTransaction(db, ['app_settings'], (transaction) => transaction.runAsync(
        `INSERT INTO app_settings(key, value, updated_at) VALUES ('language', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        nextLanguage,
      ));
    } catch (error) {
      if (operation === operationRef.current) applyLanguage(previousLanguage);
      throw error;
    } finally {
      savingRef.current = false;
      setLanguageSaving(false);
    }
  }, [applyLanguage, db]);

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
