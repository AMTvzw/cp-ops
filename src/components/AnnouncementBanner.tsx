import React, { useState, useEffect } from 'react';
import { Megaphone } from 'lucide-react';
import { motion } from 'motion/react';
import { useLocation } from 'react-router-dom';
import { useUser } from '../contexts/UserContext';

interface Announcement {
  message: string;
  bg_color: string;
  is_active: number;
}

export default function AnnouncementBanner() {
  const location = useLocation();
  const { hasRole } = useUser();
  const [eventAnnouncement, setEventAnnouncement] = useState<Announcement | null>(null);
  const [globalAnnouncement, setGlobalAnnouncement] = useState<Announcement | null>(null);
  const canSeeGlobalAnnouncement = hasRole(['ROOT', 'ADMIN', 'OPERATOR']);

  useEffect(() => {
    const match = location.pathname.match(/^\/event\/(\d+)/);
    const eventId = match ? match[1] : null;

    if (eventId) {
      const fetchAnnouncement = async () => {
        try {
          const res = await fetch(`/api/events/${eventId}/announcement`);
          if (!res.ok) return;
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const data = await res.json();
            setEventAnnouncement(data);
          }
        } catch (err) {
          console.error('Failed to fetch announcement', err);
        }
      };

      fetchAnnouncement();

      const stream = new EventSource(`/api/events/${eventId}/announcement/stream`, { withCredentials: true });
      stream.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setEventAnnouncement(data);
        } catch (err) {
          console.error('Failed to parse event announcement stream payload', err);
        }
      };
      stream.onerror = () => {
        // Let EventSource auto-reconnect on transient network/server errors.
      };

      return () => {
        stream.close();
      };
    }

    setEventAnnouncement(null);
    return () => {};
  }, [location.pathname]);

  useEffect(() => {
    if (!canSeeGlobalAnnouncement) {
      setGlobalAnnouncement(null);
      return;
    }

    const fetchGlobalAnnouncement = async () => {
      try {
        const res = await fetch('/api/announcements');
        if (!res.ok) return;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          setGlobalAnnouncement(data);
        }
      } catch (err) {
        console.error('Failed to fetch global announcement', err);
      }
    };

    fetchGlobalAnnouncement();
    const interval = setInterval(fetchGlobalAnnouncement, 30000);
    return () => clearInterval(interval);
  }, [canSeeGlobalAnnouncement]);

  const hasGlobal = Boolean(globalAnnouncement && globalAnnouncement.is_active && globalAnnouncement.message);
  const hasEvent = Boolean(eventAnnouncement && eventAnnouncement.is_active && eventAnnouncement.message);

  if (!hasGlobal && !hasEvent) return null;

  return (
    <div>
      {hasGlobal && globalAnnouncement && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          className="w-full text-white py-2 px-4 flex items-center justify-center gap-3 relative z-50"
          style={{ backgroundColor: globalAnnouncement.bg_color }}
        >
          <Megaphone className="w-5 h-5 flex-shrink-0" />
          <span className="font-bold text-center text-sm md:text-base">{globalAnnouncement.message}</span>
        </motion.div>
      )}
      {hasEvent && eventAnnouncement && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          className="w-full text-white py-2 px-4 flex items-center justify-center gap-3 relative z-50"
          style={{ backgroundColor: eventAnnouncement.bg_color }}
        >
          <Megaphone className="w-5 h-5 flex-shrink-0" />
          <span className="font-bold text-center text-sm md:text-base">{eventAnnouncement.message}</span>
        </motion.div>
      )}
    </div>
  );
}
