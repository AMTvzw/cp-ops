import React, { useState, useEffect } from 'react';
import { useUser, Role } from '../contexts/UserContext';
import { UserPlus, Trash2, Shield, User as UserIcon, AlertCircle, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';

interface UserData {
  id: number;
  username: string;
  role: Role;
}

export default function UserManagement() {
  const { user: currentUser, hasRole, settings, updateSettings } = useUser();
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'OPERATOR' as Role });
  const [error, setError] = useState('');
  const [fetchError, setFetchError] = useState('');
  
  const [branding, setBranding] = useState({
    app_name: settings.app_name,
    primary_color: settings.primary_color,
    logo_url: settings.logo_url
  });

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    setBranding({
      app_name: settings.app_name,
      primary_color: settings.primary_color,
      logo_url: settings.logo_url
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

  if (!hasRole(['ROOT', 'ADMIN'])) return <div className="p-8 text-center">Geen toegang.</div>;

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8">
      <header className="mb-8">
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1 mb-2">
          <ChevronRight className="rotate-180 w-4 h-4" /> Terug naar dashboard
        </Link>
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-slate-900">Beheer</h1>
          <button 
            onClick={() => setShowAdd(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            <UserPlus className="w-4 h-4" /> Gebruiker Toevoegen
          </button>
        </div>
      </header>

      <section className="mb-12 bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-600" /> Branding & Instellingen
        </h2>
        <form onSubmit={handleSaveBranding} className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Primaire Kleur</label>
            <div className="flex gap-2">
              <input
                type="color"
                value={branding.primary_color}
                onChange={e => setBranding(prev => ({ ...prev, primary_color: e.target.value }))}
                className="h-10 w-20 rounded border border-slate-200 p-1 cursor-pointer"
              />
              <input
                type="text"
                value={branding.primary_color}
                onChange={e => setBranding(prev => ({ ...prev, primary_color: e.target.value }))}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
              />
            </div>
          </div>
          <div className="md:col-span-3 flex justify-end">
            <button 
              type="submit"
              className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-slate-800 transition-all"
            >
              Instellingen Opslaan
            </button>
          </div>
        </form>
      </section>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-200 bg-slate-50">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <UserIcon className="w-5 h-5 text-slate-500" /> Gebruikers
          </h2>
        </div>
        {fetchError && (
          <div className="mx-6 mt-6 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-100">
            {fetchError}
          </div>
        )}
        {loading && (
          <div className="p-6 text-slate-500 text-sm">Gebruikers laden...</div>
        )}
        <table className="w-full text-left">
          <thead className="bg-slate-50 border-b border-slate-200">
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
                  {u.id !== currentUser?.id && !(currentUser?.role === 'ADMIN' && u.role === 'ROOT') && (
                    <button 
                      onClick={() => handleDeleteUser(u.id)}
                      className="text-slate-400 hover:text-red-600 transition-colors p-2"
                      title="Verwijderen"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl"
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
              <div className="flex gap-3 mt-8">
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
    </div>
  );
}
