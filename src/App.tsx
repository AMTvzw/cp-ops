import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import Dashboard from './components/Dashboard';
import EventDetail from './components/EventDetail';
import Login from './components/Login';
import UserManagement from './components/UserManagement';
import AnnouncementBanner from './components/AnnouncementBanner';
import { UserProvider, useUser } from './contexts/UserContext';

const LANG_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,15}$/;

const replaceLanguagePrefix = (pathname: string, nextLang: string) => {
  const match = /^\/([a-z0-9][a-z0-9_-]{1,15})(\/.*)?$/i.exec(pathname);
  if (match) {
    return `/${nextLang}${match[2] || ''}`;
  }
  if (pathname === '/') return `/${nextLang}`;
  return `/${nextLang}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
};

function LocalizedShell() {
  const { lang = 'en' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, languageCode, languages, setLanguage } = useUser();
  const normalizedLang = String(lang || 'en').toLowerCase();

  useEffect(() => {
    if (!LANG_CODE_RE.test(normalizedLang)) {
      navigate(replaceLanguagePrefix(location.pathname, 'en'), { replace: true });
      return;
    }

    if (!user) return;

    const availableCodes = new Set(languages.map((entry) => entry.code.toLowerCase()));
    if (!availableCodes.has(normalizedLang)) {
      navigate(replaceLanguagePrefix(location.pathname, languageCode || 'en'), { replace: true });
      return;
    }

    if (normalizedLang !== String(languageCode || 'en').toLowerCase()) {
      void setLanguage(normalizedLang).catch(() => {
        navigate(replaceLanguagePrefix(location.pathname, languageCode || 'en'), { replace: true });
      });
    }
  }, [normalizedLang, user, languages, languageCode, location.pathname, navigate, setLanguage]);

  if (!user) {
    if (location.pathname === `/${normalizedLang}/login`) {
      return <Login />;
    }
    return <Navigate to={`/${normalizedLang}/login`} replace />;
  }

  if (location.pathname === `/${normalizedLang}/login`) {
    return <Navigate to={`/${normalizedLang}`} replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col overflow-x-hidden">
      <AnnouncementBanner />
      <div className="flex-1 min-w-0">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="event/:id" element={<EventDetail />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="*" element={<Navigate to={`/${normalizedLang}`} replace />} />
        </Routes>
      </div>
    </div>
  );
}

function AppContent() {
  const { user, loading, languageCode } = useUser();
  const preferredLanguage = (user?.language_code || languageCode || 'en').toLowerCase();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to={`/${preferredLanguage}`} replace />} />
      <Route path="/:lang/*" element={<LocalizedShell />} />
      <Route path="*" element={<Navigate to={`/${preferredLanguage}`} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <UserProvider>
      <Router>
        <AppContent />
      </Router>
    </UserProvider>
  );
}
