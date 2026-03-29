import React, { useState, useEffect } from 'react';
import { useUser, Role } from '../contexts/UserContext';
import { UserPlus, Trash2, Shield, User as UserIcon, AlertCircle, ChevronRight, Palette, Users, Pencil, Eye, EyeOff, Upload, Languages } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import { builtInTranslations, englishBaseDictionary } from '../i18n/translations';
import LanguageSelector from './LanguageSelector';

interface UserData {
  id: number;
  username: string;
  role: Role;
  language_code?: string;
}

type AdminTab = 'users' | 'branding' | 'languages';

interface AdminLanguage {
  code: string;
  name: string;
  is_active: number;
}

export default function UserManagement() {
  const { user: currentUser, hasRole, settings, updateSettings, t, languageCode } = useUser();
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'OPERATOR' as Role });
  const [error, setError] = useState('');
  const [fetchError, setFetchError] = useState('');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoUploadError, setLogoUploadError] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editingUser, setEditingUser] = useState<{ id: number; username: string; role: Role } | null>(null);
  const [editForm, setEditForm] = useState({ username: '', role: 'OPERATOR' as Role, password: '', confirmPassword: '' });
  const [editError, setEditError] = useState('');
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [showEditConfirmPassword, setShowEditConfirmPassword] = useState(false);
  const [adminLanguages, setAdminLanguages] = useState<AdminLanguage[]>([]);
  const [selectedLanguageCode, setSelectedLanguageCode] = useState('');
  const [newLanguageCode, setNewLanguageCode] = useState('');
  const [newLanguageName, setNewLanguageName] = useState('');
  const [translationSearch, setTranslationSearch] = useState('');
  const [translationDrafts, setTranslationDrafts] = useState<Record<string, string>>({});
  const [translationsBusy, setTranslationsBusy] = useState(false);
  const [languageMessage, setLanguageMessage] = useState('');
  const [customTranslationKey, setCustomTranslationKey] = useState('');
  const [customTranslationValue, setCustomTranslationValue] = useState('');
  const [extractingLiterals, setExtractingLiterals] = useState(false);

  const [branding, setBranding] = useState({
    app_name: settings.app_name,
    primary_color: settings.primary_color,
    primary_hover_color: settings.primary_hover_color,
    logo_url: settings.logo_url,
    background_color: settings.background_color,
    surface_color: settings.surface_color,
    surface_alt_color: settings.surface_alt_color,
    text_color: settings.text_color,
    muted_text_color: settings.muted_text_color,
    border_color: settings.border_color,
    danger_color: settings.danger_color,
    danger_hover_color: settings.danger_hover_color,
  });

  useEffect(() => {
    fetchUsers();
    fetchAdminLanguages();
  }, []);

  useEffect(() => {
    setBranding({
      app_name: settings.app_name,
      primary_color: settings.primary_color,
      primary_hover_color: settings.primary_hover_color,
      logo_url: settings.logo_url,
      background_color: settings.background_color,
      surface_color: settings.surface_color,
      surface_alt_color: settings.surface_alt_color,
      text_color: settings.text_color,
      muted_text_color: settings.muted_text_color,
      border_color: settings.border_color,
      danger_color: settings.danger_color,
      danger_hover_color: settings.danger_hover_color,
    });
  }, [settings]);

  const fetchUsers = async () => {
    setFetchError('');
    try {
      const res = await fetch('/api/users');
      const data = await res.json();

      if (!res.ok) {
        setUsers([]);
        setFetchError(data?.error || 'Fout bij laden van gebruikers');
        return;
      }

      if (Array.isArray(data)) {
        setUsers(data);
      } else {
        setUsers([]);
        setFetchError('Ongeldige response bij laden van gebruikers');
      }
    } catch (err) {
      console.error(err);
      setUsers([]);
      setFetchError('Netwerkfout bij laden van gebruikers');
    } finally {
      setLoading(false);
    }
  };

  const fetchAdminLanguages = async () => {
    try {
      const res = await fetch('/api/admin/languages');
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data)) {
        return;
      }
      setAdminLanguages(data);
      setSelectedLanguageCode((prev) => {
        if (prev && data.some((lang: AdminLanguage) => lang.code === prev)) return prev;
        const firstCustom = data.find((lang: AdminLanguage) => lang.code !== 'en');
        return firstCustom?.code || '';
      });
    } catch (err) {
      console.error('Error loading languages', err);
    }
  };

  const loadLanguageTranslations = async (languageCode: string) => {
    if (!languageCode || languageCode === 'en') {
      setTranslationDrafts({});
      return;
    }
    const builtInForLanguage = (builtInTranslations as Record<string, Record<string, string>>)[languageCode] || {};
    setTranslationsBusy(true);
    setLanguageMessage('');
    try {
      const res = await fetch(`/api/admin/translations/${encodeURIComponent(languageCode)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.translations) {
        setTranslationDrafts({ ...builtInForLanguage });
        return;
      }
      setTranslationDrafts({
        ...builtInForLanguage,
        ...data.translations,
      });
    } finally {
      setTranslationsBusy(false);
    }
  };

  useEffect(() => {
    void loadLanguageTranslations(selectedLanguageCode);
  }, [selectedLanguageCode]);

  const handleSaveBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateSettings(branding);
    alert('Branding opgeslagen!');
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      });
      if (res.ok) {
        setShowAdd(false);
        setNewUser({ username: '', password: '', role: 'OPERATOR' });
        fetchUsers();
      } else {
        const data = await res.json();
        setError(data.error || 'Fout bij aanmaken gebruiker');
      }
    } catch (err) {
      setError('Netwerkfout');
    }
  };

  const handleDeleteUser = async (id: number) => {
    if (!confirm('Weet u zeker dat u deze gebruiker wilt verwijderen?')) return;
    try {
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchUsers();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const openEditUser = (user: UserData) => {
    setEditingUser({ id: user.id, username: user.username, role: user.role });
    setEditForm({
      username: user.username,
      role: user.role,
      password: '',
      confirmPassword: '',
    });
    setEditError('');
    setShowEditPassword(false);
    setShowEditConfirmPassword(false);
    setShowEdit(true);
  };

  const closeEditUser = () => {
    setShowEdit(false);
    setEditingUser(null);
    setEditError('');
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;

    setEditError('');
    const payload: Record<string, string> = {
      username: editForm.username.trim(),
      role: editForm.role,
    };

    if (!payload.username) {
      setEditError('Gebruikersnaam is verplicht');
      return;
    }

    if (editForm.password || editForm.confirmPassword) {
      if (editForm.password.length < 6) {
        setEditError('Wachtwoord moet minstens 6 tekens bevatten');
        return;
      }
      if (editForm.password !== editForm.confirmPassword) {
        setEditError('Nieuwe wachtwoorden komen niet overeen');
        return;
      }
      payload.password = editForm.password;
    }

    try {
      const res = await fetch(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setEditError(data?.error || 'Fout bij aanpassen gebruiker');
        return;
      }
      closeEditUser();
      fetchUsers();
    } catch (err) {
      setEditError('Netwerkfout');
    }
  };

  const handleAddLanguage = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = newLanguageCode.trim().toLowerCase();
    const name = newLanguageName.trim();
    if (!code || !name) return;

    setLanguageMessage('');
    try {
      const res = await fetch('/api/admin/languages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLanguageMessage(data?.error || t('admin.languages.error'));
        return;
      }
      setNewLanguageCode('');
      setNewLanguageName('');
      setLanguageMessage(t('admin.languages.created'));
      await fetchAdminLanguages();
      setSelectedLanguageCode(code);
    } catch (err) {
      setLanguageMessage(t('admin.languages.error'));
    }
  };

  const handleToggleLanguageActive = async (language: AdminLanguage) => {
    try {
      const res = await fetch(`/api/admin/languages/${encodeURIComponent(language.code)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: language.is_active ? 0 : 1 }),
      });
      if (!res.ok) return;
      await fetchAdminLanguages();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveTranslations = async () => {
    if (!selectedLanguageCode) return;
    setTranslationsBusy(true);
    setLanguageMessage('');
    try {
      const res = await fetch(`/api/admin/translations/${encodeURIComponent(selectedLanguageCode)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ translations: translationDrafts }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLanguageMessage(data?.error || t('admin.languages.error'));
        return;
      }
      setLanguageMessage(t('admin.languages.saved'));
    } catch (err) {
      setLanguageMessage(t('admin.languages.error'));
    } finally {
      setTranslationsBusy(false);
    }
  };

  const handleAddCustomTranslationKey = () => {
    const key = customTranslationKey.trim();
    if (!key) return;
    setTranslationDrafts((prev) => ({
      ...prev,
      [key]: customTranslationValue,
    }));
    setCustomTranslationKey('');
    setCustomTranslationValue('');
  };

  const handleExtractUiLiterals = async () => {
    setExtractingLiterals(true);
    setLanguageMessage('');
    try {
      const res = await fetch('/api/admin/translations/extract-literals');
      const data = await res.json().catch(() => null) as { keys?: Array<{ key: string; base: string }>; error?: string } | null;
      if (!res.ok || !data?.keys) {
        setLanguageMessage(data?.error || 'Failed to extract UI literals.');
        return;
      }

      let added = 0;
      setTranslationDrafts((prev) => {
        const next = { ...prev };
        for (const item of data.keys || []) {
          if (!item?.key) continue;
          if (!(item.key in next)) {
            next[item.key] = '';
            added += 1;
          }
        }
        return next;
      });
      setLanguageMessage(`UI literals extracted. Added ${added} new keys.`);
    } catch (_err) {
      setLanguageMessage('Failed to extract UI literals.');
    } finally {
      setExtractingLiterals(false);
    }
  };

  const baseCatalog = (() => {
    const merged: Record<string, string> = { ...englishBaseDictionary };
    for (const key of Object.keys(translationDrafts)) {
      if (!merged[key]) {
        merged[key] = key.startsWith('literal:') ? key.slice('literal:'.length) : key;
      }
    }
    return merged;
  })();

  const setBrandingValue = (key: keyof typeof branding, value: string) => {
    setBranding(prev => ({ ...prev, [key]: value }));
  };

  const handleLogoFileUpload = async (file: File) => {
    setLogoUploadError('');
    if (!file.type.startsWith('image/')) {
      setLogoUploadError('Selecteer een geldig afbeeldingsbestand.');
      return;
    }

    const toDataUrl = () =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Bestand lezen mislukt'));
        reader.readAsDataURL(file);
      });

    try {
      setUploadingLogo(true);
      const dataUrl = await toDataUrl();
      const res = await fetch('/api/settings/logo-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data_url: dataUrl,
          filename: file.name,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        setLogoUploadError(data?.error || 'Upload mislukt');
        return;
      }

      setBranding(prev => ({ ...prev, logo_url: data.url }));
      await updateSettings({ logo_url: data.url });
    } catch (err) {
      setLogoUploadError('Upload mislukt');
    } finally {
      setUploadingLogo(false);
    }
  };

  const renderColorField = (label: string, key: keyof typeof branding) => (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          type="color"
          value={branding[key]}
          onChange={e => setBrandingValue(key, e.target.value)}
          className="h-10 w-20 rounded border border-slate-200 p-1 cursor-pointer"
        />
        <input
          type="text"
          value={branding[key]}
          onChange={e => setBrandingValue(key, e.target.value)}
          className="flex-1 px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
        />
      </div>
    </div>
  );

  if (!hasRole(['ROOT', 'ADMIN'])) return <div className="p-8 text-center">{t('admin.noAccess')}</div>;

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8 overflow-x-hidden">
      <header className="mb-6">
        <Link to={`/${languageCode}`} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1 mb-2">
          <ChevronRight className="rotate-180 w-4 h-4" /> {t('common.backToDashboard')}
        </Link>
        <div className="flex flex-wrap gap-3 justify-between items-center">
          <h1 className="text-3xl font-bold text-slate-900">{t('admin.title')}</h1>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <LanguageSelector />
            {activeTab === 'users' && (
              <button
                onClick={() => setShowAdd(true)}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700 transition-colors text-sm font-medium w-full sm:w-auto"
              >
                <UserPlus className="w-4 h-4" /> {t('admin.addUser')}
              </button>
            )}
          </div>
        </div>
      </header>

      <nav className="mb-6 bg-white rounded-2xl border border-slate-200 p-2 flex gap-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('users')}
          className={`flex-1 min-w-[160px] px-4 py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
            activeTab === 'users'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Users className="w-4 h-4" /> {t('admin.tab.users')}
        </button>
        <button
          onClick={() => setActiveTab('branding')}
          className={`flex-1 min-w-[160px] px-4 py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
            activeTab === 'branding'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Palette className="w-4 h-4" /> {t('admin.tab.branding')}
        </button>
        <button
          onClick={() => setActiveTab('languages')}
          className={`flex-1 min-w-[160px] px-4 py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
            activeTab === 'languages'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Languages className="w-4 h-4" /> {t('admin.tab.languages')}
        </button>
      </nav>

      {activeTab === 'branding' && (
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-blue-600" /> Branding & Instellingen
          </h2>

          <form onSubmit={handleSaveBranding} className="space-y-4">
            <details open className="border border-slate-200 rounded-xl overflow-hidden">
              <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Basis</summary>
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Applicatie Naam</label>
                  <input
                    type="text"
                    value={branding.app_name}
                    onChange={e => setBranding(prev => ({ ...prev, app_name: e.target.value }))}
                    className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Logo URL</label>
                  <input
                    type="text"
                    value={branding.logo_url}
                    onChange={e => setBranding(prev => ({ ...prev, logo_url: e.target.value }))}
                    className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="https://example.com/logo.png"
                  />
                  <div className="mt-2 flex flex-col sm:flex-row gap-2">
                    <label className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 hover:bg-slate-50 cursor-pointer">
                      <Upload className="w-4 h-4" />
                      {uploadingLogo ? 'Uploaden...' : 'Upload Afbeelding'}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={uploadingLogo}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          await handleLogoFileUpload(file);
                          e.currentTarget.value = '';
                        }}
                      />
                    </label>
                    {branding.logo_url && (
                      <img
                        src={branding.logo_url}
                        alt="Logo preview"
                        className="h-10 w-auto max-w-[180px] object-contain rounded border border-slate-200 bg-white p-1"
                        referrerPolicy="no-referrer"
                      />
                    )}
                  </div>
                  {logoUploadError && (
                    <p className="mt-2 text-xs text-red-600">{logoUploadError}</p>
                  )}
                </div>
              </div>
            </details>

            <details open className="border border-slate-200 rounded-xl overflow-hidden">
              <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Primaire actie-kleuren</summary>
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderColorField('Primaire Kleur', 'primary_color')}
                {renderColorField('Primary Hover', 'primary_hover_color')}
              </div>
            </details>

            <details className="border border-slate-200 rounded-xl overflow-hidden">
              <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Achtergronden</summary>
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderColorField('Pagina Achtergrond', 'background_color')}
                {renderColorField('Kaart Achtergrond', 'surface_color')}
                {renderColorField('Subtiele Achtergrond', 'surface_alt_color')}
              </div>
            </details>

            <details className="border border-slate-200 rounded-xl overflow-hidden">
              <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Tekst en randen</summary>
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderColorField('Tekstkleur', 'text_color')}
                {renderColorField('Secundaire Tekst', 'muted_text_color')}
                {renderColorField('Randkleur', 'border_color')}
              </div>
            </details>

            <details className="border border-slate-200 rounded-xl overflow-hidden">
              <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Waarschuwingen</summary>
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {renderColorField('Waarschuwing / Verwijderen', 'danger_color')}
                {renderColorField('Waarschuwing Hover', 'danger_hover_color')}
              </div>
            </details>

            <div className="border border-slate-200 rounded-xl p-4" style={{ backgroundColor: branding.surface_alt_color }}>
              <p className="text-xs uppercase tracking-wider mb-2" style={{ color: branding.muted_text_color }}>Voorbeeld</p>
              <div className="rounded-lg p-4 border" style={{ backgroundColor: branding.surface_color, borderColor: branding.border_color }}>
                <h3 className="font-bold" style={{ color: branding.text_color }}>{branding.app_name || 'App naam'}</h3>
                <p className="text-sm mt-1" style={{ color: branding.muted_text_color }}>
                  Dit laat zien hoe kaarten en knoppen ongeveer tonen.
                </p>
                <div className="mt-3 flex gap-2 flex-wrap">
                  <button type="button" className="px-3 py-2 rounded text-sm font-medium text-white" style={{ backgroundColor: branding.primary_color }}>
                    Primaire knop
                  </button>
                  <button type="button" className="px-3 py-2 rounded text-sm font-medium text-white" style={{ backgroundColor: branding.danger_color }}>
                    Verwijderen
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-slate-800 transition-all"
              >
                Instellingen Opslaan
              </button>
            </div>
          </form>
        </section>
      )}

      {activeTab === 'users' && (
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 bg-slate-50">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <UserIcon className="w-5 h-5 text-slate-500" /> Gebruikers
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              Overzicht van accounts en rollen. Je kan hier gebruikers verwijderen of nieuwe toevoegen.
            </p>
          </div>

          {fetchError && (
            <div className="mx-6 mt-6 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-100">
              {fetchError}
            </div>
          )}

          {loading && (
            <div className="p-6 text-slate-500 text-sm">Gebruikers laden...</div>
          )}

          {!loading && (
            <>
              <div className="px-6 pt-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                    <p className="text-xs uppercase tracking-wider text-slate-500">Totaal</p>
                    <p className="text-2xl font-bold text-slate-900">{users.length}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                    <p className="text-xs uppercase tracking-wider text-slate-500">Admins</p>
                    <p className="text-2xl font-bold text-slate-900">{users.filter(u => u.role === 'ADMIN' || u.role === 'ROOT').length}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                    <p className="text-xs uppercase tracking-wider text-slate-500">Operators/Viewers</p>
                    <p className="text-2xl font-bold text-slate-900">{users.filter(u => u.role === 'OPERATOR' || u.role === 'VIEWER').length}</p>
                  </div>
                </div>
              </div>

              <details open className="m-6 border border-slate-200 rounded-xl overflow-hidden">
                <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Gebruikerslijst</summary>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="bg-slate-50 border-y border-slate-200">
                      <tr>
                        <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">Gebruikersnaam</th>
                        <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">Rol</th>
                        <th className="px-6 py-4 text-sm font-bold text-slate-500 uppercase tracking-wider text-right">Acties</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {users.map((u) => (
                        <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4 flex items-center gap-3">
                            <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center text-slate-500">
                              <UserIcon className="w-4 h-4" />
                            </div>
                            <span className="font-medium text-slate-900">{u.username}</span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest ${
                              u.role === 'ROOT' ? 'bg-purple-100 text-purple-700' :
                              u.role === 'ADMIN' ? 'bg-blue-100 text-blue-700' :
                              u.role === 'OPERATOR' ? 'bg-emerald-100 text-emerald-700' :
                              'bg-slate-100 text-slate-700'
                            }`}>
                              {u.role}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex justify-end items-center gap-1">
                              {u.id !== currentUser?.id && !(currentUser?.role === 'ADMIN' && u.role === 'ROOT') && (
                                <button
                                  onClick={() => openEditUser(u)}
                                  className="text-slate-400 hover:text-blue-600 transition-colors p-2"
                                  title="Bewerken"
                                >
                                  <Pencil className="w-4 h-4" />
                                </button>
                              )}
                              {u.id !== currentUser?.id && !(currentUser?.role === 'ADMIN' && u.role === 'ROOT') && (
                                <button
                                  onClick={() => handleDeleteUser(u.id)}
                                  className="text-slate-400 hover:text-red-600 transition-colors p-2"
                                  title="Verwijderen"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </section>
      )}

      {activeTab === 'languages' && (
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Languages className="w-5 h-5 text-blue-600" /> {t('admin.languages.title')}
            </h2>
            <p className="text-sm text-slate-500 mt-1">{t('admin.languages.subtitle')}</p>
          </div>

          <form onSubmit={handleAddLanguage} className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="text"
              value={newLanguageCode}
              onChange={(e) => setNewLanguageCode(e.target.value)}
              placeholder={t('admin.languages.code')}
              className="px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <input
              type="text"
              value={newLanguageName}
              onChange={(e) => setNewLanguageName(e.target.value)}
              placeholder={t('admin.languages.name')}
              className="px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              {t('admin.languages.add')}
            </button>
          </form>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3">{t('admin.languages.code')}</th>
                  <th className="px-4 py-3">{t('admin.languages.name')}</th>
                  <th className="px-4 py-3">{t('admin.languages.toggle.active')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {adminLanguages.map((language) => (
                  <tr key={language.code}>
                    <td className="px-4 py-3 font-mono">{language.code}</td>
                    <td className="px-4 py-3">{language.name}</td>
                    <td className="px-4 py-3">
                      <label className="inline-flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(language.is_active)}
                          onChange={() => void handleToggleLanguageActive(language)}
                        />
                        <span>{language.is_active ? 'ON' : 'OFF'}</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.languages.select')}</label>
              <select
                value={selectedLanguageCode}
                onChange={(e) => setSelectedLanguageCode(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="">-</option>
                {adminLanguages.filter((lang) => lang.code !== 'en').map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.name} ({language.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.languages.field.search')}</label>
              <input
                type="text"
                value={translationSearch}
                onChange={(e) => setTranslationSearch(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder={t('admin.languages.field.search')}
              />
            </div>
          </div>

          {!selectedLanguageCode && (
            <p className="text-sm text-slate-500">{t('admin.languages.noSelection')}</p>
          )}

          {selectedLanguageCode && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-5 gap-2 border border-slate-200 rounded-xl p-3 bg-slate-50">
                <input
                  type="text"
                  value={customTranslationKey}
                  onChange={(e) => setCustomTranslationKey(e.target.value)}
                  className="md:col-span-2 px-3 py-2 rounded-lg border border-slate-200 outline-none"
                  placeholder="Custom key (e.g. literal:Evenement Informatie)"
                />
                <input
                  type="text"
                  value={customTranslationValue}
                  onChange={(e) => setCustomTranslationValue(e.target.value)}
                  className="md:col-span-2 px-3 py-2 rounded-lg border border-slate-200 outline-none"
                  placeholder="Translation value"
                />
                <button
                  type="button"
                  onClick={handleAddCustomTranslationKey}
                  className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-100"
                >
                  Add key
                </button>
                <button
                  type="button"
                  onClick={() => void handleExtractUiLiterals()}
                  disabled={extractingLiterals}
                  className="md:col-span-5 px-3 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {extractingLiterals ? 'Extracting UI literals...' : 'Extract UI literals'}
                </button>
              </div>
              <div className="max-h-[55vh] overflow-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 w-[35%]">{t('admin.languages.field.english')}</th>
                      <th className="px-3 py-2 w-[15%]">Key</th>
                      <th className="px-3 py-2 w-[50%]">{t('admin.languages.field.translation')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {Object.entries(baseCatalog)
                      .filter(([key, value]) => {
                        const needle = translationSearch.trim().toLowerCase();
                        if (!needle) return true;
                        return key.toLowerCase().includes(needle) || String(value).toLowerCase().includes(needle);
                      })
                      .map(([key, baseValue]) => (
                        <tr key={key}>
                          <td className="px-3 py-2 text-slate-700">{baseValue}</td>
                          <td className="px-3 py-2 font-mono text-xs text-slate-500">{key}</td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={translationDrafts[key] || ''}
                              onChange={(e) => setTranslationDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">{translationsBusy ? t('common.loading') : languageMessage}</p>
                <button
                  type="button"
                  onClick={() => void handleSaveTranslations()}
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60"
                  disabled={translationsBusy}
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <h2 className="text-2xl font-bold mb-6">Nieuwe Gebruiker</h2>
            <form onSubmit={handleAddUser} className="space-y-4">
              {error && (
                <div className="p-3 bg-red-50 text-red-600 text-xs rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> {error}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Gebruikersnaam</label>
                <input
                  type="text"
                  required
                  value={newUser.username}
                  onChange={e => setNewUser(prev => ({ ...prev, username: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Wachtwoord</label>
                <input
                  type="password"
                  required
                  value={newUser.password}
                  onChange={e => setNewUser(prev => ({ ...prev, password: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Rol</label>
                <select
                  value={newUser.role}
                  onChange={e => setNewUser(prev => ({ ...prev, role: e.target.value as Role }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="OPERATOR">OPERATOR</option>
                  <option value="VIEWER">VIEWER</option>
                </select>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
                >
                  Annuleren
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Aanmaken
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {showEdit && editingUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <h2 className="text-2xl font-bold mb-6">Gebruiker Bewerken</h2>
            <form onSubmit={handleEditUser} className="space-y-4">
              {editError && (
                <div className="p-3 bg-red-50 text-red-600 text-xs rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> {editError}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Gebruikersnaam</label>
                <input
                  type="text"
                  required
                  value={editForm.username}
                  onChange={e => setEditForm(prev => ({ ...prev, username: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Rol</label>
                <select
                  value={editForm.role}
                  onChange={e => setEditForm(prev => ({ ...prev, role: e.target.value as Role }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {currentUser?.role === 'ROOT' && <option value="ROOT">ROOT</option>}
                  <option value="ADMIN">ADMIN</option>
                  <option value="OPERATOR">OPERATOR</option>
                  <option value="VIEWER">VIEWER</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nieuw wachtwoord (optioneel)</label>
                <div className="relative">
                  <input
                    type={showEditPassword ? 'text' : 'password'}
                    value={editForm.password}
                    onChange={e => setEditForm(prev => ({ ...prev, password: e.target.value }))}
                    className="w-full px-4 py-2 pr-11 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowEditPassword(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                  >
                    {showEditPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nieuw wachtwoord herhalen</label>
                <div className="relative">
                  <input
                    type={showEditConfirmPassword ? 'text' : 'password'}
                    value={editForm.confirmPassword}
                    onChange={e => setEditForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                    className="w-full px-4 py-2 pr-11 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowEditConfirmPassword(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                  >
                    {showEditConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 mt-8">
                <button
                  type="button"
                  onClick={closeEditUser}
                  className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
                >
                  Annuleren
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Opslaan
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}
