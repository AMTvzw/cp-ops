import React, { createContext, useContext, useState, useEffect } from 'react';

export type Role = 'ROOT' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

interface User {
  id: number;
  username: string;
  role: Role;
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
  login: (user: User) => void;
  logout: () => void;
  hasRole: (roles: Role[]) => boolean;
  updateSettings: (newSettings: Partial<Settings>) => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
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
    const fetchJson = async (url: string) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          return await res.json();
        }
        return null;
      } catch (err) {
        console.error(`Error fetching ${url}:`, err);
        return null;
      }
    };

    Promise.all([
      fetchJson('/api/me'),
      fetchJson('/api/settings')
    ]).then(([userData, settingsData]) => {
      if (userData) setUser(userData);
      if (settingsData) setSettings(prev => ({ ...prev, ...settingsData }));
    }).finally(() => setLoading(false));
  }, []);

  const login = (userData: User) => setUser(userData);
  const logout = () => {
    fetch('/api/logout', { method: 'POST' }).finally(() => setUser(null));
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

  return (
    <UserContext.Provider value={{ user, settings, loading, login, logout, hasRole, updateSettings }}>
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
