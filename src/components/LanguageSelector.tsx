import React, { useState } from 'react';
import { Languages } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUser } from '../contexts/UserContext';

interface LanguageSelectorProps {
  className?: string;
}

export default function LanguageSelector({ className = '' }: LanguageSelectorProps) {
  const { languages, languageCode, setLanguage, t } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  const replaceLanguagePrefix = (pathname: string, nextCode: string) => {
    const match = /^\/([a-z0-9][a-z0-9_-]{1,15})(\/.*)?$/i.exec(pathname);
    if (match) {
      return `/${nextCode}${match[2] || ''}`;
    }
    if (pathname === '/') return `/${nextCode}`;
    return `/${nextCode}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  };

  const handleLanguageChange = async (nextCode: string) => {
    if (!nextCode || nextCode === languageCode) return;
    setSaving(true);
    try {
      await setLanguage(nextCode);
      navigate(replaceLanguagePrefix(location.pathname, nextCode), { replace: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Language update failed';
      alert(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className={`inline-flex items-center gap-2 px-2 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs ${className}`}>
      <Languages className="w-4 h-4" />
      <select
        value={languageCode}
        disabled={saving}
        onChange={(e) => void handleLanguageChange(e.target.value)}
        aria-label={t('common.language')}
        className="bg-transparent outline-none border-none text-xs pr-1 font-semibold tracking-wide"
      >
        {languages.map((language) => (
          <option key={language.code} value={language.code}>
            {language.code.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}
