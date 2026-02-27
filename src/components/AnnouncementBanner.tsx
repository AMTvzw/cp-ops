import React, { useState, useEffect } from 'react';
import { Megaphone } from 'lucide-react';
import { motion } from 'motion/react';
import { useLocation } from 'react-router-dom';

interface Announcement {
  message: string;
  bg_color: string;
  is_active: number;
}

export default function AnnouncementBanner() {
  const location = useLocation();
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    const match = location.pathname.match(/^\/event\/(\d+)/);
    const eventId = match ? match[1] : null;

    const fetchAnnouncement = async () => {
      try {
        const endpoint = eventId
          ? `/api/events/${eventId}/announcement`
          : '/api/announcements';
        const res = await fetch(endpoint);
        if (!res.ok) return;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          setAnnouncement(data);
        }
      } catch (err) {
        console.error('Failed to fetch announcement', err);
      }
    };

    if (eventId) {
      fetchAnnouncement();

      const stream = new EventSource(`/api/events/${eventId}/announcement/stream`, { withCredentials: true });
      stream.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setAnnouncement(data);
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

    fetchAnnouncement();
    const interval = setInterval(fetchAnnouncement, 30000);
    return () => clearInterval(interval);
  }, [location.pathname]);

  if (!announcement || !announcement.is_active || !announcement.message) return null;

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      className="w-full text-white py-2 px-4 flex items-center justify-center gap-3 relative z-50"
      style={{ backgroundColor: announcement.bg_color }}
    >
      <Megaphone className="w-5 h-5 flex-shrink-0" />
      <span className="font-bold text-center text-sm md:text-base">{announcement.message}</span>
    </motion.div>
  );
}
