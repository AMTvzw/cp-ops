import React, { useState } from 'react';
import { useUser } from '../contexts/UserContext';
import { Shield, Lock, User as UserIcon, AlertCircle } from 'lucide-react';
import { motion } from 'motion/react';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, settings } = useUser();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (res.ok) {
        const data = await res.json();
        login(data);
      } else {
        setError('Ongeldige gebruikersnaam of wachtwoord');
      }
    } catch (err) {
      setError('Er is een fout opgetreden bij het inloggen');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-slate-200 p-8"
      >
        <div className="flex flex-col items-center mb-8">
          {settings.logo_url ? (
            <img src={settings.logo_url} alt="Logo" className="w-24 h-24 object-contain mb-4" referrerPolicy="no-referrer" />
          ) : (
            <div 
              className="w-16 h-16 rounded-2xl flex items-center justify-center text-white mb-4 shadow-lg"
              style={{ backgroundColor: settings.primary_color }}
            >
              <Shield className="w-8 h-8" />
            </div>
          )}
          <h1 className="text-3xl font-extrabold text-slate-900">{settings.app_name} Login</h1>
          <p className="text-slate-500 mt-2">Voer uw gegevens in om door te gaan</p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-600 text-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Gebruikersnaam</label>
            <div className="relative">
              <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                required
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full pl-12 pr-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                style={{ '--tw-ring-color': settings.primary_color } as any}
                placeholder="Gebruikersnaam"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Wachtwoord</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full pl-12 pr-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                style={{ '--tw-ring-color': settings.primary_color } as any}
                placeholder="••••••••"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full text-white py-4 rounded-xl font-bold transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed mt-4"
            style={{ backgroundColor: settings.primary_color }}
          >
            {loading ? 'Laden...' : 'Inloggen'}
          </button>
        </form>

        <div className="mt-8 pt-8 border-t border-slate-100 text-center text-xs text-slate-400">
          &copy; {new Date().getFullYear()} {settings.app_name} Operationeel Systeem
        </div>
      </motion.div>
    </div>
  );
}
