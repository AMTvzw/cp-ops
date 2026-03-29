import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { fetchJsonSafe } from '../utils/http';
import { builtInTranslations, interpolate } from '../i18n/translations';
import { setRuntimeTextTranslator } from '../i18n/runtimeAutoTranslate';

export type Role = 'ROOT' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

interface User {
  id: number;
  username: string;
  role: Role;
  language_code?: string;
}

export interface LanguageOption {
  code: string;
  name: string;
  is_active?: number;
}

interface Settings {
  app_name: string;
  primary_color: string;
  primary_hover_color: string;
  logo_url: string;
  background_color: string;
  surface_color: string;
  surface_alt_color: string;
  text_color: string;
  muted_text_color: string;
  border_color: string;
  danger_color: string;
  danger_hover_color: string;
}

interface UserContextType {
  user: User | null;
  settings: Settings;
  loading: boolean;
  languageCode: string;
  languages: LanguageOption[];
  login: (user: User) => void;
  logout: () => void;
  hasRole: (roles: Role[]) => boolean;
  updateSettings: (newSettings: Partial<Settings>) => Promise<void>;
  setLanguage: (languageCode: string) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

const defaultLanguages: LanguageOption[] = [
  { code: 'en', name: 'English', is_active: 1 },
  { code: 'nl', name: 'Nederlands', is_active: 1 },
];

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [languageCode, setLanguageCode] = useState('en');
  const [languages, setLanguages] = useState<LanguageOption[]>(defaultLanguages);
  const [customTranslations, setCustomTranslations] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Settings>({
    app_name: 'CP-OPS',
    primary_color: '#2563eb',
    primary_hover_color: '#1d4ed8',
    logo_url: '',
    background_color: '#f8fafc',
    surface_color: '#ffffff',
    surface_alt_color: '#f1f5f9',
    text_color: '#0f172a',
    muted_text_color: '#475569',
    border_color: '#cbd5e1',
    danger_color: '#dc2626',
    danger_hover_color: '#b91c1c'
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchJsonSafe<User>('/api/me'),
      fetchJsonSafe<Partial<Settings>>('/api/settings')
    ]).then(([userData, settingsData]) => {
      if (userData.response.ok && userData.data) {
        const normalizedUser = {
          ...userData.data,
          language_code: userData.data.language_code || 'en',
        };
        setUser(normalizedUser);
        setLanguageCode(normalizedUser.language_code || 'en');
      }
      if (settingsData.response.ok && settingsData.data) {
        setSettings(prev => ({ ...prev, ...settingsData.data }));
      }
    }).catch((err) => {
      console.error('Error loading user context:', err);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) {
      setLanguages(defaultLanguages);
      setCustomTranslations({});
      setLanguageCode('en');
      return;
    }

    const currentLanguage = user.language_code || 'en';
    setLanguageCode(currentLanguage);

    Promise.all([
      fetchJsonSafe<LanguageOption[]>('/api/languages'),
      fetchJsonSafe<{ language_code?: string; translations?: Record<string, string> }>(`/api/translations?lang=${encodeURIComponent(currentLanguage)}`),
    ]).then(([languagesResult, translationsResult]) => {
      if (languagesResult.response.ok && Array.isArray(languagesResult.data) && languagesResult.data.length > 0) {
        setLanguages(languagesResult.data);
      }
      if (translationsResult.response.ok && translationsResult.data?.translations) {
        setCustomTranslations(translationsResult.data.translations);
      } else {
        setCustomTranslations({});
      }
    }).catch((err) => {
      console.error('Error loading languages/translations:', err);
      setCustomTranslations({});
    });
  }, [user]);

  const login = (userData: User) => {
    const normalizedUser = {
      ...userData,
      language_code: userData.language_code || 'en',
    };
    setUser(normalizedUser);
    setLanguageCode(normalizedUser.language_code || 'en');
  };

  const logout = () => {
    fetch('/api/logout', { method: 'POST' }).finally(() => {
      setUser(null);
      setLanguageCode('en');
      setCustomTranslations({});
      setLanguages(defaultLanguages);
    });
  };

  const hasRole = (roles: Role[]) => {
    if (!user) return false;
    return roles.includes(user.role);
  };

  const updateSettings = async (newSettings: Partial<Settings>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });
    if (res.ok) {
      setSettings(prev => ({ ...prev, ...newSettings }));
    }
  };

  const setLanguage = useCallback(async (nextLanguageCode: string) => {
    if (!user) return;

    const res = await fetch('/api/users/me/language', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language_code: nextLanguageCode }),
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => null);
      throw new Error(errorData?.error || 'Language update failed');
    }

    setUser(prev => (prev ? { ...prev, language_code: nextLanguageCode } : prev));
    setLanguageCode(nextLanguageCode);

    const translationsResult = await fetchJsonSafe<{ translations?: Record<string, string> }>(`/api/translations?lang=${encodeURIComponent(nextLanguageCode)}`);
    if (translationsResult.response.ok && translationsResult.data?.translations) {
      setCustomTranslations(translationsResult.data.translations);
    } else {
      setCustomTranslations({});
    }
  }, [user]);

  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    const normalizedCode = (languageCode || 'en').toLowerCase();
    const builtInLanguage = builtInTranslations[normalizedCode as 'en' | 'nl'] || builtInTranslations.en;
    const raw = customTranslations[key]
      || customTranslations[`literal:${key}`]
      || builtInLanguage[key]
      || builtInLanguage[`literal:${key}`]
      || builtInTranslations.en[key]
      || builtInTranslations.en[`literal:${key}`]
      || key;
    return interpolate(raw, vars);
  }, [languageCode, customTranslations]);

  useEffect(() => {
    setRuntimeTextTranslator((text: string) => {
      const normalizedCode = (languageCode || 'en').toLowerCase();
      const builtInLanguage = builtInTranslations[normalizedCode as 'en' | 'nl'] || builtInTranslations.en;
      return customTranslations[text]
        || customTranslations[`literal:${text}`]
        || builtInLanguage[text]
        || builtInLanguage[`literal:${text}`]
        || builtInTranslations.en[text]
        || builtInTranslations.en[`literal:${text}`]
        || text;
    });
  }, [languageCode, customTranslations]);

  useEffect(() => {
    document.documentElement.lang = languageCode || 'en';
  }, [languageCode]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--app-primary', settings.primary_color);
    root.style.setProperty('--app-primary-hover', settings.primary_hover_color || settings.primary_color);
    root.style.setProperty('--app-bg', settings.background_color);
    root.style.setProperty('--app-surface', settings.surface_color);
    root.style.setProperty('--app-surface-alt', settings.surface_alt_color);
    root.style.setProperty('--app-text', settings.text_color);
    root.style.setProperty('--app-muted', settings.muted_text_color);
    root.style.setProperty('--app-border', settings.border_color);
    root.style.setProperty('--app-danger', settings.danger_color);
    root.style.setProperty('--app-danger-hover', settings.danger_hover_color || settings.danger_color);
  }, [settings]);

  useEffect(() => {
    if (!settings.logo_url) return;

    const applyFavicon = (rel: string) => {
      let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
      }
      link.href = settings.logo_url;
    };

    applyFavicon('icon');
    applyFavicon('shortcut icon');
    applyFavicon('apple-touch-icon');
  }, [settings.logo_url]);

  const contextValue = useMemo(() => ({
    user,
    settings,
    loading,
    languageCode,
    languages,
    login,
    logout,
    hasRole,
    updateSettings,
    setLanguage,
    t,
  }), [user, settings, loading, languageCode, languages, setLanguage, t]);

  return (
    <UserContext.Provider value={contextValue}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
