import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Calendar, ChevronRight, Activity, Users, LogOut, Settings, Megaphone, MapPin, Building2 } from 'lucide-react';
import { motion } from 'motion/react';
import { format } from 'date-fns';
import { nl } from 'date-fns/locale';
import { useUser } from '../contexts/UserContext';

interface Event {
  id: number;
  name: string;
  date: string;
  end_date?: string;
  location?: string;
  organizer?: string;
  description: string;
}

export default function Dashboard() {
  const { user, logout, hasRole, settings } = useUser();
  const [events, setEvents] = useState<Event[]>([]);
  const [showNewEvent, setShowNewEvent] = useState(false);
  const [newEvent, setNewEvent] = useState({ 
    name: '', 
    date: new Date().toISOString().split('T')[0], 
    end_date: '', 
    location: '',
    organizer: '',
    contact_info: '',
    description: '' 
  });
  
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [announcement, setAnnouncement] = useState({ message: '', bg_color: '#ef4444', is_active: false });

  useEffect(() => {
    fetchEvents();
    fetchAnnouncement();
  }, []);

  const fetchEvents = async () => {
    try {
      const res = await fetch('/api/events');
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          setEvents(data);
        }
      }
    } catch (err) {
      console.error('Error fetching events:', err);
    }
  };

  const fetchAnnouncement = async () => {
    try {
      const res = await fetch('/api/announcements');
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          setAnnouncement({ ...data, is_active: !!data.is_active });
        }
      }
    } catch (err) {
      console.error('Error fetching announcement:', err);
    }
  };

  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newEvent)
    });
    if (res.ok) {
      setShowNewEvent(false);
      setNewEvent({ 
        name: '', 
        date: new Date().toISOString().split('T')[0], 
        end_date: '', 
        location: '',
        organizer: '',
        contact_info: '',
        description: '' 
      });
      fetchEvents();
    } else {
      alert('Fout bij het opslaan van het evenement. Controleer de velden.');
    }
  };

  const handleUpdateAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(announcement)
    });
    setShowAnnouncement(false);
  };

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-4">
        <div className="flex items-center gap-4">
          {settings.logo_url && (
            <img src={settings.logo_url} alt="Logo" className="w-16 h-16 object-contain rounded-lg" referrerPolicy="no-referrer" />
          )}
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight text-slate-900">{settings.app_name}</h1>
            <p className="text-slate-500 mt-1">Welkom, <span className="font-bold text-slate-700">{user?.username}</span> ({user?.role})</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
            <button 
              onClick={() => setShowAnnouncement(true)}
              className="bg-red-600 text-white px-4 py-2 rounded-xl font-bold flex items-center gap-2 hover:bg-red-700 transition-all shadow-lg shadow-red-100"
            >
              <Megaphone className="w-4 h-4" /> Melding
            </button>
          )}
          {hasRole(['ROOT', 'ADMIN']) && (
            <Link 
              to="/users"
              className="bg-slate-800 text-white px-4 py-2 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-900 transition-all shadow-lg shadow-slate-200"
            >
              <Settings className="w-4 h-4" /> Beheer
            </Link>
          )}
          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
            <button 
              onClick={() => setShowNewEvent(true)}
              className="text-white px-4 py-2 rounded-xl font-bold flex items-center gap-2 transition-all shadow-lg"
              style={{ backgroundColor: settings.primary_color }}
            >
              <Plus className="w-4 h-4" /> Nieuw Event
            </button>
          )}
          <button 
            onClick={logout}
            className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-50 transition-all"
          >
            <LogOut className="w-4 h-4" /> Uitloggen
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {events.map((event) => (
          <Link key={event.id} to={`/event/${event.id}`}>
            <motion.div 
              whileHover={{ y: -4 }}
              className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all group"
            >
              <div className="flex justify-between items-start mb-4">
                <div 
                  className="p-3 rounded-xl transition-colors"
                  style={{ backgroundColor: `${settings.primary_color}10`, color: settings.primary_color }}
                >
                  <Calendar className="w-6 h-6" />
                </div>
                <ChevronRight className="text-slate-300 group-hover:text-slate-500 transition-colors" />
              </div>
              <h2 className="text-xl font-bold text-slate-900 mb-1">{event.name}</h2>
              <p className="text-sm text-slate-500 mb-2">
                {format(new Date(event.date), 'PPP', { locale: nl })}
                {event.end_date && event.end_date !== event.date && (
                  <> - {format(new Date(event.end_date), 'PPP', { locale: nl })}</>
                )}
              </p>
              
              <div className="space-y-1 mb-4">
                {event.location && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <MapPin className="w-3 h-3" /> {event.location}
                  </div>
                )}
                {event.organizer && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Building2 className="w-3 h-3" /> {event.organizer}
                  </div>
                )}
              </div>
              
              <div className="flex gap-4 mt-6 pt-6 border-t border-slate-50">
                <div className="flex items-center gap-1 text-xs font-bold text-slate-400 uppercase tracking-wider">
                  <Activity className="w-3 h-3" /> Interventies
                </div>
                <div className="flex items-center gap-1 text-xs font-bold text-slate-400 uppercase tracking-wider">
                  <Users className="w-3 h-3" /> Ploegen
                </div>
              </div>
            </motion.div>
          </Link>
        ))}
        
        {events.length === 0 && (
          <div className="col-span-full py-20 text-center border-2 border-dashed border-slate-200 rounded-3xl">
            <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-400 font-medium">Nog geen evenementen aangemaakt.</p>
            {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
              <button 
                onClick={() => setShowNewEvent(true)}
                className="mt-4 font-bold hover:underline"
                style={{ color: settings.primary_color }}
              >
                Maak je eerste event aan
              </button>
            )}
          </div>
        )}
      </div>

      {/* New Event Modal */}
      {showNewEvent && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-3xl p-8 w-full max-w-2xl shadow-2xl overflow-y-auto max-h-[90vh]"
          >
            <h2 className="text-2xl font-bold mb-6">Nieuw Evenement</h2>
            <form onSubmit={handleCreateEvent} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Naam</label>
                  <input
                    autoFocus
                    type="text"
                    required
                    value={newEvent.name}
                    onChange={e => setNewEvent(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                    style={{ '--tw-ring-color': settings.primary_color } as any}
                    placeholder="Bijv. Festival 2026"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Startdatum</label>
                  <input
                    type="date"
                    required
                    value={newEvent.date}
                    onChange={e => setNewEvent(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                    style={{ '--tw-ring-color': settings.primary_color } as any}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Einddatum (optioneel)</label>
                  <input
                    type="date"
                    value={newEvent.end_date}
                    onChange={e => setNewEvent(prev => ({ ...prev, end_date: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                    style={{ '--tw-ring-color': settings.primary_color } as any}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Locatie</label>
                  <input
                    type="text"
                    value={newEvent.location}
                    onChange={e => setNewEvent(prev => ({ ...prev, location: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                    style={{ '--tw-ring-color': settings.primary_color } as any}
                    placeholder="Locatie van het event"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Organisator</label>
                  <input
                    type="text"
                    value={newEvent.organizer}
                    onChange={e => setNewEvent(prev => ({ ...prev, organizer: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                    style={{ '--tw-ring-color': settings.primary_color } as any}
                    placeholder="Naam organisator"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Contact Informatie</label>
                  <input
                    type="text"
                    value={newEvent.contact_info}
                    onChange={e => setNewEvent(prev => ({ ...prev, contact_info: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all"
                    style={{ '--tw-ring-color': settings.primary_color } as any}
                    placeholder="Telefoonnummer / Email"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Omschrijving</label>
                  <textarea
                    value={newEvent.description}
                    onChange={e => setNewEvent(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 outline-none transition-all h-24"
                    style={{ '--tw-ring-color': settings.primary_color } as any}
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-8">
                <button 
                  type="button"
                  onClick={() => setShowNewEvent(false)}
                  className="flex-1 px-4 py-3 border border-slate-200 rounded-xl text-slate-600 font-bold hover:bg-slate-50 transition-all"
                >
                  Annuleren
                </button>
                <button 
                  type="submit"
                  className="flex-1 px-4 py-3 text-white rounded-xl font-bold transition-all shadow-lg"
                  style={{ backgroundColor: settings.primary_color }}
                >
                  Aanmaken
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {/* Announcement Modal */}
      {showAnnouncement && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl"
          >
            <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <Megaphone className="text-red-600" /> Globale Melding
            </h2>
            <form onSubmit={handleUpdateAnnouncement} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Bericht</label>
                <textarea
                  required
                  value={announcement.message}
                  onChange={e => setAnnouncement(prev => ({ ...prev, message: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-red-500 outline-none transition-all h-32"
                  placeholder="Typ hier de belangrijke melding..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Achtergrondkleur</label>
                <div className="flex gap-2">
                  {['#ef4444', '#f97316', '#eab308', '#3b82f6', '#1e293b'].map(color => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setAnnouncement(prev => ({ ...prev, bg_color: color }))}
                      className={`w-10 h-10 rounded-full border-2 ${announcement.bg_color === color ? 'border-slate-900 ring-2 ring-slate-200' : 'border-transparent'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <input 
                    type="color" 
                    value={announcement.bg_color}
                    onChange={e => setAnnouncement(prev => ({ ...prev, bg_color: e.target.value }))}
                    className="w-10 h-10 rounded-full border-none p-0 overflow-hidden cursor-pointer"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={announcement.is_active}
                  onChange={e => setAnnouncement(prev => ({ ...prev, is_active: e.target.checked }))}
                  className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                Toon banner aan iedereen
              </label>
              <div className="flex gap-3 mt-8">
                <button 
                  type="button"
                  onClick={() => setShowAnnouncement(false)}
                  className="flex-1 px-4 py-3 border border-slate-200 rounded-xl text-slate-600 font-bold hover:bg-slate-50 transition-all"
                >
                  Annuleren
                </button>
                <button 
                  type="submit"
                  className="flex-1 px-4 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-100"
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
