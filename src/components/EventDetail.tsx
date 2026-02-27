import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { 
  Plus, Users, Activity, FileText, Settings, 
  ChevronRight, MapPin, Clock, CheckCircle2, 
  AlertCircle, Download, Send, Trash2, UserPlus, Pencil, Save, X,
  Building2, Phone, LogOut, Megaphone
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { nl } from 'date-fns/locale';
import { useUser, Role } from '../contexts/UserContext';

interface Event {
  id: number;
  name: string;
  date: string;
  end_date?: string;
  location?: string;
  organizer?: string;
  contact_info?: string;
  description: string;
}

interface Status {
  id: number;
  name: string;
  color: string;
  is_closed: number;
}

interface TeamMember {
  id: number;
  name: string;
  role: string;
}

interface Team {
  id: number;
  name: string;
  type: string;
  members: TeamMember[];
}

interface TeamType {
  id: number;
  name: string;
}

interface TeamInIntervention extends Team {
  status_id: number;
  status_name: string;
  status_color: string;
  status_is_closed: number;
  status_started_at?: string | null;
  status_duration_seconds?: number | null;
}

interface InterventionStatusDuration {
  status_name: string;
  total_seconds: number;
}

interface Intervention {
  id: number;
  intervention_number?: number;
  title: string;
  location: string;
  description?: string;
  created_at: string;
  closed_at: string | null;
  open_seconds?: number;
  status_durations?: InterventionStatusDuration[];
  teams: TeamInIntervention[];
}

interface Log {
  id: number;
  message: string;
  actor_user_id: number | null;
  actor_username: string | null;
  team_id: number | null;
  intervention_id: number | null;
  created_at: string;
}

interface LogUser {
  id: number;
  username: string;
}

interface InterventionMessage {
  id: number;
  intervention_id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  message: string;
  created_at: string;
}

interface InterventionEditState {
  location: string;
  description: string;
  addTeamIds: number[];
  removeTeamIds: number[];
  selectedAddTeamId: string;
  selectedRemoveTeamId: string;
}

interface EventAssignee {
  id: number;
  username: string;
  role: Role;
}

interface EventFormState {
  name: string;
  date: string;
  end_date: string;
  location: string;
  organizer: string;
  contact_info: string;
  description: string;
}

export default function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, logout, hasRole, settings } = useUser();
  const isViewer = user?.role === 'VIEWER';
  const [event, setEvent] = useState<Event | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'interventions' | 'team_status' | 'teams' | 'logs' | 'settings'>('interventions');
  const [interventionTab, setInterventionTab] = useState<'open' | 'closed'>('open');
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamTypes, setTeamTypes] = useState<TeamType[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [logUsers, setLogUsers] = useState<LogUser[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const [logFilters, setLogFilters] = useState({
    user_id: '',
    team_id: '',
    intervention_id: '',
  });
  const [loading, setLoading] = useState(true);
  const [eventForm, setEventForm] = useState<EventFormState>({
    name: '',
    date: '',
    end_date: '',
    location: '',
    organizer: '',
    contact_info: '',
    description: '',
  });
  const [savingEventInfo, setSavingEventInfo] = useState(false);

  // Form states
  const [showNewIntervention, setShowNewIntervention] = useState(false);
  const [newIntervention, setNewIntervention] = useState({ title: '', location: '', description: '', status_id: 0, team_ids: [] as number[] });
  const [showEventAnnouncement, setShowEventAnnouncement] = useState(false);
  const [eventAnnouncement, setEventAnnouncement] = useState({ message: '', bg_color: '#ef4444', is_active: false });
  
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeam, setNewTeam] = useState({ name: '', type: '' });

  const [newLog, setNewLog] = useState('');
  const [newLogContext, setNewLogContext] = useState({ team_id: '', intervention_id: '' });
  const [newStatus, setNewStatus] = useState({ name: '', color: '#3b82f6', is_closed: false });
  const [newTeamTypeName, setNewTeamTypeName] = useState('');
  const [editingTeamTypeId, setEditingTeamTypeId] = useState<number | null>(null);
  const [editingTeamTypeName, setEditingTeamTypeName] = useState('');
  const [editingStatusId, setEditingStatusId] = useState<number | null>(null);
  const [editingStatus, setEditingStatus] = useState({ name: '', color: '#3b82f6', is_closed: false });
  const [messagesByIntervention, setMessagesByIntervention] = useState<Record<number, InterventionMessage[]>>({});
  const [newMessageByIntervention, setNewMessageByIntervention] = useState<Record<number, string>>({});
  const [editingInterventionId, setEditingInterventionId] = useState<number | null>(null);
  const [interventionEdit, setInterventionEdit] = useState<InterventionEditState | null>(null);
  const [eventAssignableUsers, setEventAssignableUsers] = useState<EventAssignee[]>([]);
  const [eventAssignedUserIds, setEventAssignedUserIds] = useState<number[]>([]);
  const [savingEventAssignments, setSavingEventAssignments] = useState(false);

  useEffect(() => {
    fetchData();
  }, [id]);

  useEffect(() => {
    if (isViewer && activeTab !== 'team_status') {
      setActiveTab('team_status');
    }
  }, [isViewer, activeTab]);

  useEffect(() => {
    fetchLogs(true);
  }, [id, logFilters.user_id, logFilters.team_id, logFilters.intervention_id]);

  useEffect(() => {
    if (!interventions.length) {
      setMessagesByIntervention({});
      return;
    }

    Promise.all(interventions.map(inter => fetchInterventionMessages(inter.id)))
      .catch(err => console.error(err));
  }, [interventions]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const fetchJson = async (url: string) => {
        const res = await fetch(url);
        if (res.status === 401) {
          navigate('/');
          return null;
        }
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          return await res.json();
        }
        return null;
      };

      const [eventData, interData, teamData, teamTypeData, statusData, logUsersData] = await Promise.all([
        fetchJson(`/api/events/${id}`),
        fetchJson(`/api/events/${id}/interventions`),
        fetchJson(`/api/events/${id}/teams`),
        fetchJson(`/api/events/${id}/team-types`),
        fetchJson(`/api/events/${id}/statuses`),
        fetchJson(`/api/events/${id}/log-users`)
      ]);

      if (eventData) {
        setEvent(eventData);
        setEventForm({
          name: eventData.name || '',
          date: eventData.date || '',
          end_date: eventData.end_date || '',
          location: eventData.location || '',
          organizer: eventData.organizer || '',
          contact_info: eventData.contact_info || '',
          description: eventData.description || '',
        });
      }
      if (interData) setInterventions(interData);
      if (teamData) setTeams(teamData);
      if (Array.isArray(teamTypeData)) {
        setTeamTypes(teamTypeData);
        setNewTeam(prev => ({
          ...prev,
          type: teamTypeData.some(t => t.name === prev.type) ? prev.type : (teamTypeData[0]?.name || '')
        }));
      } else {
        setTeamTypes([]);
        setNewTeam(prev => ({ ...prev, type: '' }));
      }
      if (statusData) {
        setStatuses(statusData);
        if (statusData.length > 0) {
          setNewIntervention(prev => ({ ...prev, status_id: statusData[0].id }));
        }
      }

      const eventAnnouncementRes = await fetch(`/api/events/${id}/announcement`);
      if (eventAnnouncementRes.ok) {
        const contentType = eventAnnouncementRes.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await eventAnnouncementRes.json();
          setEventAnnouncement({
            message: data?.message || '',
            bg_color: data?.bg_color || '#ef4444',
            is_active: !!data?.is_active,
          });
        }
      }
      if (Array.isArray(logUsersData)) {
        setLogUsers(logUsersData);
      } else {
        setLogUsers([]);
      }

      if (hasRole(['ROOT', 'ADMIN'])) {
        const [usersRes, assignedRes] = await Promise.all([
          fetch('/api/users'),
          fetch(`/api/events/${id}/assignments`),
        ]);
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          const scopedUsers = Array.isArray(usersData)
            ? usersData.filter((u: any) => u.role === 'OPERATOR' || u.role === 'VIEWER')
            : [];
          setEventAssignableUsers(scopedUsers);
        }
        if (assignedRes.ok) {
          const assignedData = await assignedRes.json();
          const ids = Array.isArray(assignedData) ? assignedData.map((u: any) => Number(u.id)) : [];
          setEventAssignedUserIds(ids);
        }
      }

      await fetchLogs(true);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async (reset: boolean) => {
    if (!id) return;

    const nextPage = reset ? 1 : logsPage + 1;
    const params = new URLSearchParams({
      page: String(nextPage),
      limit: '20',
    });
    if (logFilters.user_id) params.set('user_id', logFilters.user_id);
    if (logFilters.team_id) params.set('team_id', logFilters.team_id);
    if (logFilters.intervention_id) params.set('intervention_id', logFilters.intervention_id);

    setLogsLoading(true);
    try {
      const res = await fetch(`/api/events/${id}/logs?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      setLogs(prev => (reset ? items : [...prev, ...items]));
      setLogsPage(nextPage);
      setLogsHasMore(Boolean(data?.hasMore));
    } catch (error) {
      console.error(error);
    } finally {
      setLogsLoading(false);
    }
  };

  const fetchInterventionMessages = async (interventionId: number) => {
    const res = await fetch(`/api/interventions/${interventionId}/messages`);
    if (!res.ok) return;
    const data = await res.json();
    const messages = Array.isArray(data) ? data : [];
    setMessagesByIntervention(prev => ({ ...prev, [interventionId]: messages }));
  };

  const formatDuration = (seconds?: number | null) => {
    if (seconds == null) return '-';
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (days > 0) return `${days}d ${hours}u ${mins}m`;
    if (hours > 0) return `${hours}u ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  const handleAddIntervention = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch(`/api/events/${id}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newIntervention)
    });
    setShowNewIntervention(false);
    setNewIntervention({ title: '', location: '', description: '', status_id: statuses[0]?.id || 0, team_ids: [] });
    fetchData();
  };

  const beginEditIntervention = (inter: Intervention) => {
    setEditingInterventionId(inter.id);
    setInterventionEdit({
      location: inter.location || '',
      description: inter.description || '',
      addTeamIds: [],
      removeTeamIds: [],
      selectedAddTeamId: '',
      selectedRemoveTeamId: '',
    });
  };

  const cancelEditIntervention = () => {
    setEditingInterventionId(null);
    setInterventionEdit(null);
  };

  const addTeamToInterventionEdit = () => {
    if (!interventionEdit?.selectedAddTeamId) return;
    const teamId = Number(interventionEdit.selectedAddTeamId);
    if (!teamId) return;
    setInterventionEdit(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        addTeamIds: prev.addTeamIds.includes(teamId) ? prev.addTeamIds : [...prev.addTeamIds, teamId],
        removeTeamIds: prev.removeTeamIds.filter(id => id !== teamId),
        selectedAddTeamId: '',
      };
    });
  };

  const removeTeamFromInterventionEdit = () => {
    if (!interventionEdit?.selectedRemoveTeamId) return;
    const teamId = Number(interventionEdit.selectedRemoveTeamId);
    if (!teamId) return;
    setInterventionEdit(prev => {
      if (!prev) return prev;
      if (prev.addTeamIds.includes(teamId)) {
        return {
          ...prev,
          addTeamIds: prev.addTeamIds.filter(id => id !== teamId),
          selectedRemoveTeamId: '',
        };
      }
      return {
        ...prev,
        removeTeamIds: prev.removeTeamIds.includes(teamId) ? prev.removeTeamIds : [...prev.removeTeamIds, teamId],
        selectedRemoveTeamId: '',
      };
    });
  };

  const saveInterventionEdit = async (interventionId: number) => {
    if (!interventionEdit) return;
    const res = await fetch(`/api/interventions/${interventionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: interventionEdit.location.trim(),
        description: interventionEdit.description.trim(),
        add_team_ids: interventionEdit.addTeamIds,
        remove_team_ids: interventionEdit.removeTeamIds,
        default_status_id: statuses[0]?.id || null,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Interventie bewerken mislukt');
      return;
    }

    cancelEditIntervention();
    fetchData();
  };

  const handleUpdateTeamStatus = async (interId: number, teamId: number, statusId: number) => {
    if (!hasRole(['ROOT', 'ADMIN', 'OPERATOR'])) return;
    await fetch(`/api/interventions/${interId}/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_id: statusId })
    });
    fetchData();
  };

  const handleAddTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeam.type) {
      alert('Maak eerst een teamsoort aan in Instellingen.');
      return;
    }

    await fetch(`/api/events/${id}/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTeam)
    });
    setShowNewTeam(false);
    setNewTeam({ name: '', type: teamTypes[0]?.name || '' });
    fetchData();
  };

  const handleAddTeamType = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newTeamTypeName.trim();
    if (!name) return;

    const res = await fetch(`/api/events/${id}/team-types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Teamsoort toevoegen mislukt');
      return;
    }

    setNewTeamTypeName('');
    fetchData();
  };

  const handleStartEditTeamType = (teamType: TeamType) => {
    setEditingTeamTypeId(teamType.id);
    setEditingTeamTypeName(teamType.name);
  };

  const handleCancelEditTeamType = () => {
    setEditingTeamTypeId(null);
    setEditingTeamTypeName('');
  };

  const handleSaveEditTeamType = async () => {
    if (!editingTeamTypeId) return;
    const name = editingTeamTypeName.trim();
    if (!name) return;

    const res = await fetch(`/api/team-types/${editingTeamTypeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Teamsoort bewerken mislukt');
      return;
    }

    handleCancelEditTeamType();
    fetchData();
  };

  const handleDeleteTeamType = async (teamTypeId: number, name: string) => {
    if (!confirm(`Weet je zeker dat je teamsoort "${name}" wilt verwijderen?`)) return;

    let res = await fetch(`/api/team-types/${teamTypeId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject' })
    });

    if (res.status === 400) {
      const errorData = await res.json().catch(() => null);
      if (errorData?.code === 'TEAM_TYPE_LINKED') {
        const candidates = teamTypes.filter(t => t.id !== teamTypeId);
        if (candidates.length === 0) {
          alert('Geen alternatieve teamsoort beschikbaar om naar te herkoppelen.');
          return;
        }

        const optionsText = candidates.map(t => `${t.id} = ${t.name}`).join('\n');
        const selectedId = prompt(
          `Deze teamsoort is in gebruik.\nKies doel-teamsoort ID om ploegen te herkoppelen:\n${optionsText}`,
          String(candidates[0].id)
        );
        const parsedId = Number(selectedId);
        if (!parsedId) return;

        res = await fetch(`/api/team-types/${teamTypeId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reassign', reassign_to_type_id: parsedId })
        });
      } else {
        alert(errorData?.error || 'Teamsoort verwijderen mislukt');
        return;
      }
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Teamsoort verwijderen mislukt');
      return;
    }

    fetchData();
  };

  const handleAddMember = async (teamId: number, name: string, role: string) => {
    await fetch(`/api/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role })
    });
    fetchData();
  };

  const handleRemoveMember = async (memberId: number) => {
    await fetch(`/api/members/${memberId}`, { method: 'DELETE' });
    fetchData();
  };

  const handleAddLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLog.trim()) return;
    await fetch(`/api/events/${id}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: newLog,
        team_id: newLogContext.team_id ? Number(newLogContext.team_id) : null,
        intervention_id: newLogContext.intervention_id ? Number(newLogContext.intervention_id) : null,
      })
    });
    setNewLog('');
    setNewLogContext({ team_id: '', intervention_id: '' });
    fetchData();
  };

  const handleAddStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch(`/api/events/${id}/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newStatus)
    });
    setNewStatus({ name: '', color: '#3b82f6', is_closed: false });
    fetchData();
  };

  const handleAddInterventionMessage = async (interventionId: number) => {
    const message = (newMessageByIntervention[interventionId] || '').trim();
    if (!message) return;

    const res = await fetch(`/api/interventions/${interventionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Bericht toevoegen mislukt');
      return;
    }

    setNewMessageByIntervention(prev => ({ ...prev, [interventionId]: '' }));
    await fetchInterventionMessages(interventionId);
    fetchLogs(true);
  };

  const handleSaveEventAssignments = async () => {
    if (!hasRole(['ROOT', 'ADMIN'])) return;
    setSavingEventAssignments(true);
    try {
      const res = await fetch(`/api/events/${id}/assignments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: eventAssignedUserIds }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error || 'Opslaan van event-toegang mislukt');
        return;
      }
      alert('Event-toegang opgeslagen');
    } finally {
      setSavingEventAssignments(false);
    }
  };

  const handleDeleteIntervention = async (interventionId: number, title: string) => {
    if (!hasRole(['ROOT', 'ADMIN'])) return;
    const action = prompt(
      `Wat wil je doen met gekoppelde ploeg-statussen voor "${title}"?\n` +
      `1 = Interventie verwijderen (koppelingen worden ook verwijderd)\n` +
      `2 = Annuleren`,
      '1'
    );
    if (action !== '1') return;

    const res = await fetch(`/api/interventions/${interventionId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Interventie verwijderen mislukt');
      return;
    }
    fetchData();
  };

  const handleDeleteStatus = async (statusId: number, name: string) => {
    if (!hasRole(['ROOT', 'ADMIN'])) return;
    if (!confirm(`Weet je zeker dat je status "${name}" wilt verwijderen?`)) return;

    let res = await fetch(`/api/statuses/${statusId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject' })
    });

    if (res.status === 400) {
      const errorData = await res.json().catch(() => null);
      if (errorData?.code === 'STATUS_LINKED') {
        const choice = prompt(
          `Deze status is gekoppeld aan interventies.\n` +
          `1 = Herkoppel naar andere status\n` +
          `2 = Ontkoppel status (leeg maken)\n` +
          `3 = Annuleren`,
          '1'
        );

        if (choice === '1') {
          const candidateStatuses = statuses.filter(s => s.id !== statusId);
          const optionsText = candidateStatuses.map(s => `${s.id} = ${s.name}`).join('\n');
          const selectedId = prompt(`Kies doelstatus ID:\n${optionsText}`, String(candidateStatuses[0]?.id || ''));
          const parsedId = Number(selectedId);
          if (!parsedId) return;

          res = await fetch(`/api/statuses/${statusId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reassign', reassign_to_status_id: parsedId })
          });
        } else if (choice === '2') {
          res = await fetch(`/api/statuses/${statusId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'set_null' })
          });
        } else {
          return;
        }
      } else {
        alert(errorData?.error || 'Status verwijderen mislukt');
        return;
      }
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Status verwijderen mislukt');
      return;
    }
    fetchData();
  };

  const handleStartEditStatus = (status: Status) => {
    setEditingStatusId(status.id);
    setEditingStatus({
      name: status.name,
      color: status.color,
      is_closed: !!status.is_closed
    });
  };

  const handleSaveStatusEdit = async () => {
    if (!editingStatusId) return;
    const res = await fetch(`/api/statuses/${editingStatusId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingStatus)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Status bewerken mislukt');
      return;
    }
    setEditingStatusId(null);
    fetchData();
  };

  const handleCancelStatusEdit = () => {
    setEditingStatusId(null);
  };

  const handleDownloadExport = async (
    exportFormat: 'json' | 'csv' | 'excel' = 'json',
    dataset: 'logs' | 'teams' | 'interventions' | 'all' = 'logs'
  ) => {
    const query = new URLSearchParams({ format: exportFormat, dataset }).toString();
    const res = await fetch(`/api/events/${id}/export?${query}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Export mislukt');
      return false;
    }

    let blob: Blob;
    if (exportFormat === 'json') {
      const data = await res.json();
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    } else {
      blob = await res.blob();
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const datePart = format(new Date(), 'yyyy-MM-dd');
    const ext = exportFormat === 'json' ? 'json' : exportFormat === 'csv' ? 'csv' : 'xls';
    a.download = `event-${event?.name}-${dataset}-${datePart}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  };

  const handleDeleteEvent = async () => {
    if (!hasRole(['ROOT', 'ADMIN'])) return;
    const choice = prompt(
      `Wat wil je doen met gekoppelde data van "${event?.name}"?\n` +
      `1 = Eerst exporteren, daarna alles verwijderen\n` +
      `2 = Alles direct verwijderen\n` +
      `3 = Annuleren`,
      '1'
    );
    if (choice === '3' || !choice) return;

    if (choice === '1') {
      const exported = await handleDownloadExport();
      if (!exported) return;
    } else if (choice !== '2') {
      return;
    }

    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Evenement verwijderen mislukt');
      return;
    }

    navigate('/');
  };

  const handleExport = async (format: 'csv' | 'excel') => {
    const choice = prompt(
      'Wat wil je exporteren?\n1 = Logboek\n2 = Ploegen\n3 = Interventies\n4 = Alles',
      '4'
    );
    const dataset =
      choice === '2' ? 'teams' :
      choice === '3' ? 'interventions' :
      choice === '4' ? 'all' :
      choice === '1' ? 'logs' : null;
    if (!dataset) return;

    await handleDownloadExport(format, dataset);
  };

  const handleSaveEventInfo = async () => {
    if (!hasRole(['ROOT', 'ADMIN'])) return;
    setSavingEventInfo(true);
    try {
      const res = await fetch(`/api/events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventForm),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error || 'Evenementgegevens opslaan mislukt');
        return;
      }
      setEvent(prev => prev ? {
        ...prev,
        name: eventForm.name,
        date: eventForm.date,
        end_date: eventForm.end_date || undefined,
        location: eventForm.location || undefined,
        organizer: eventForm.organizer || undefined,
        contact_info: eventForm.contact_info || undefined,
        description: eventForm.description,
      } : prev);
      fetchLogs(true);
    } finally {
      setSavingEventInfo(false);
    }
  };

  const handleUpdateEventAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`/api/events/${id}/announcement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventAnnouncement),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Event melding opslaan mislukt');
      return;
    }
    setShowEventAnnouncement(false);
    fetchData();
  };

  if (loading) return <div className="p-8 text-center">Laden...</div>;
  if (!event) return <div className="p-8 text-center">Evenement niet gevonden.</div>;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8">
      <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="flex-1">
          <Link to="/" className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1 mb-2">
            <ChevronRight className="rotate-180 w-4 h-4" /> Terug naar overzicht
          </Link>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">{event.name}</h1>
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-slate-500 text-sm">
            <p className="flex items-center gap-2">
              <Clock className="w-4 h-4" /> 
              {format(new Date(event.date), 'PPP', { locale: nl })}
              {event.end_date && event.end_date !== event.date && (
                <> - {format(new Date(event.end_date), 'PPP', { locale: nl })}</>
              )}
            </p>
            {event.location && (
              <p className="flex items-center gap-2">
                <MapPin className="w-4 h-4" /> {event.location}
              </p>
            )}
            {event.organizer && (
              <p className="flex items-center gap-2">
                <Building2 className="w-4 h-4" /> {event.organizer}
              </p>
            )}
            {event.contact_info && (
              <p className="flex items-center gap-2">
                <Phone className="w-4 h-4" /> {event.contact_info}
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
            <button
              onClick={() => setShowEventAnnouncement(true)}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
            >
              <Megaphone className="w-4 h-4" /> Event Melding
            </button>
          )}
          {hasRole(['ROOT', 'ADMIN']) && (
            <button 
              onClick={() => handleExport('csv')}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium"
            >
              <Download className="w-4 h-4" /> Export CSV
            </button>
          )}
          {hasRole(['ROOT', 'ADMIN']) && (
            <button 
              onClick={() => handleExport('excel')}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium"
            >
              <Download className="w-4 h-4" /> Export Excel
            </button>
          )}
          {hasRole(['ROOT', 'ADMIN']) && (
            <button
              onClick={handleDeleteEvent}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
            >
              <Trash2 className="w-4 h-4" /> Verwijder Event
            </button>
          )}
          <button 
            onClick={logout}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium text-slate-600"
          >
            <LogOut className="w-4 h-4" /> Uitloggen
          </button>
        </div>
      </header>

      <nav className="flex border-b border-slate-200 mb-8 overflow-x-auto">
        {[
          { id: 'info', label: 'Evenement Info', icon: FileText },
          { id: 'interventions', label: 'Interventies', icon: Activity },
          { id: 'team_status', label: 'Ploegstatus', icon: Users },
          { id: 'teams', label: 'Ploegen', icon: Users },
          { id: 'logs', label: 'Logboek', icon: FileText },
          { id: 'settings', label: 'Instellingen', icon: Settings, roles: ['ROOT', 'ADMIN'] },
        ]
          .filter(tab => {
            if (isViewer) return tab.id === 'team_status';
            return !tab.roles || hasRole(tab.roles as any);
          })
          .map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === tab.id 
                ? '' 
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
            style={activeTab === tab.id ? { borderColor: settings.primary_color, color: settings.primary_color } : {}}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </nav>

      <main>
        {activeTab === 'info' && !isViewer && (
          <div className="space-y-6">
            <h2 className="text-xl font-semibold">Evenement Informatie</h2>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Naam</p>
                  <p className="text-slate-800">{event.name}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Periode</p>
                  <p className="text-slate-800">
                    {format(new Date(event.date), 'PPP', { locale: nl })}
                    {event.end_date && event.end_date !== event.date && (
                      <> - {format(new Date(event.end_date), 'PPP', { locale: nl })}</>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Locatie</p>
                  <p className="text-slate-800">{event.location || '-'}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Organisator</p>
                  <p className="text-slate-800">{event.organizer || '-'}</p>
                </div>
                <div className="md:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Contact</p>
                  <p className="text-slate-800">{event.contact_info || '-'}</p>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-4">
                {hasRole(['ROOT', 'ADMIN']) ? (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-700">Gegevens Bewerken</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Naam</label>
                        <input
                          type="text"
                          value={eventForm.name}
                          onChange={(e) => setEventForm(prev => ({ ...prev, name: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Naam evenement"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Startdatum</label>
                        <input
                          type="date"
                          value={eventForm.date}
                          onChange={(e) => setEventForm(prev => ({ ...prev, date: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Einddatum</label>
                        <input
                          type="date"
                          value={eventForm.end_date}
                          onChange={(e) => setEventForm(prev => ({ ...prev, end_date: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Locatie</label>
                        <input
                          type="text"
                          value={eventForm.location}
                          onChange={(e) => setEventForm(prev => ({ ...prev, location: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Locatie"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Organisator</label>
                        <input
                          type="text"
                          value={eventForm.organizer}
                          onChange={(e) => setEventForm(prev => ({ ...prev, organizer: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Organisator"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Contactinformatie</label>
                        <input
                          type="text"
                          value={eventForm.contact_info}
                          onChange={(e) => setEventForm(prev => ({ ...prev, contact_info: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Contactinformatie"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Omschrijving</label>
                        <textarea
                          value={eventForm.description}
                          onChange={(e) => setEventForm(prev => ({ ...prev, description: e.target.value }))}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm min-h-[96px]"
                          placeholder="Omschrijving van dit evenement"
                        />
                      </div>
                    </div>
                    <button
                      onClick={handleSaveEventInfo}
                      disabled={savingEventInfo}
                      className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60"
                      style={{ backgroundColor: settings.primary_color }}
                    >
                      {savingEventInfo ? 'Opslaan...' : 'Evenement Opslaan'}
                    </button>
                  </div>
                ) : (
                  <div className="text-sm text-slate-600">
                    <span className="font-semibold text-slate-700">Omschrijving:</span>{' '}
                    {event.description || '-'}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'interventions' && !isViewer && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Interventies</h2>
              {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                <button
                  onClick={() => setShowNewIntervention(true)}
                  className="text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors text-sm font-medium"
                  style={{ backgroundColor: settings.primary_color }}
                >
                  <Plus className="w-4 h-4" /> Nieuwe Interventie
                </button>
              )}
            </div>

            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
              <button
                onClick={() => setInterventionTab('open')}
                className={`px-3 py-1.5 text-sm rounded-md ${interventionTab === 'open' ? 'text-white' : 'text-slate-600'}`}
                style={interventionTab === 'open' ? { backgroundColor: settings.primary_color } : {}}
              >
                Open ({interventions.filter(i => !i.closed_at).length})
              </button>
              <button
                onClick={() => setInterventionTab('closed')}
                className={`px-3 py-1.5 text-sm rounded-md ${interventionTab === 'closed' ? 'text-white' : 'text-slate-600'}`}
                style={interventionTab === 'closed' ? { backgroundColor: settings.primary_color } : {}}
              >
                Gesloten ({interventions.filter(i => !!i.closed_at).length})
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <AnimatePresence>
                {interventions
                  .filter(i => interventionTab === 'open' ? !i.closed_at : !!i.closed_at)
                  .map((inter) => (
                    <motion.div
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      key={inter.id}
                      className={`p-5 rounded-xl border ${inter.closed_at ? 'bg-slate-50 border-slate-200' : 'bg-white border-slate-200 shadow-sm'}`}
                    >
                      <div className="flex justify-between items-start mb-3">
                        <h3 className={`font-bold text-lg ${inter.closed_at ? 'text-slate-500 line-through' : 'text-slate-900'}`}>
                          #{inter.intervention_number ?? '-'} {inter.title}
                        </h3>
                        <div className="flex items-center gap-2">
                          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                            <button
                              onClick={() => beginEditIntervention(inter)}
                              className="text-slate-300 hover:text-blue-600 transition-colors"
                              title="Interventie bewerken"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                          )}
                          {hasRole(['ROOT', 'ADMIN']) && (
                            <button
                              onClick={() => handleDeleteIntervention(inter.id, inter.title)}
                              className="text-slate-300 hover:text-red-600 transition-colors"
                              title="Interventie verwijderen"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="space-y-2 text-sm text-slate-600 mb-4">
                        <div className="flex items-center gap-2">
                          <MapPin className="w-4 h-4" /> {inter.location || 'Geen locatie'}
                        </div>
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" /> {format(new Date(inter.created_at), 'HH:mm')}
                        </div>
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" /> Open duur: {formatDuration(inter.open_seconds)}
                        </div>
                      </div>

                      {editingInterventionId === inter.id && interventionEdit && (
                        <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                          <div>
                            <label className="block text-xs font-semibold text-slate-600 mb-1">Locatie</label>
                            <input
                              list={`location-suggestions-${inter.id}`}
                              type="text"
                              value={interventionEdit.location}
                              onChange={(e) =>
                                setInterventionEdit(prev => prev ? { ...prev, location: e.target.value } : prev)
                              }
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                              placeholder="Locatie interventie"
                            />
                            <datalist id={`location-suggestions-${inter.id}`}>
                              {[...new Set(
                                interventions
                                  .map(i => i.location)
                                  .filter((loc): loc is string => Boolean(loc && loc.trim()))
                              )].map(loc => (
                                <option key={loc} value={loc} />
                              ))}
                            </datalist>
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-600 mb-1">Omschrijving</label>
                            <input
                              type="text"
                              value={interventionEdit.description}
                              onChange={(e) =>
                                setInterventionEdit(prev => prev ? { ...prev, description: e.target.value } : prev)
                              }
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                              placeholder="Omschrijving interventie"
                            />
                          </div>

                          {!inter.closed_at && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-semibold text-slate-600 mb-1">Ploeg toevoegen</label>
                              <div className="flex gap-2">
                                <select
                                  value={interventionEdit.selectedAddTeamId}
                                  onChange={(e) =>
                                    setInterventionEdit(prev => prev ? { ...prev, selectedAddTeamId: e.target.value } : prev)
                                  }
                                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                >
                                  <option value="">Kies ploeg...</option>
                                  {teams
                                    .filter(t => {
                                      const currentlyLinked = inter.teams.some(it => it.id === t.id);
                                      const pendingAdded = interventionEdit.addTeamIds.includes(t.id);
                                      const pendingRemoved = interventionEdit.removeTeamIds.includes(t.id);
                                      return !currentlyLinked || pendingRemoved || pendingAdded;
                                    })
                                    .filter(t => {
                                      const currentlyLinked = inter.teams.some(it => it.id === t.id);
                                      const pendingRemoved = interventionEdit.removeTeamIds.includes(t.id);
                                      return !currentlyLinked || pendingRemoved;
                                    })
                                    .map(t => (
                                      <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={addTeamToInterventionEdit}
                                  className="px-3 py-2 rounded-lg border border-slate-200 text-sm hover:bg-white"
                                >
                                  Toevoegen
                                </button>
                              </div>
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-slate-600 mb-1">Ploeg verwijderen</label>
                              <div className="flex gap-2">
                                <select
                                  value={interventionEdit.selectedRemoveTeamId}
                                  onChange={(e) =>
                                    setInterventionEdit(prev => prev ? { ...prev, selectedRemoveTeamId: e.target.value } : prev)
                                  }
                                  className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                >
                                  <option value="">Kies ploeg...</option>
                                  {teams
                                    .filter(t => {
                                      const currentlyLinked = inter.teams.some(it => it.id === t.id);
                                      const pendingAdded = interventionEdit.addTeamIds.includes(t.id);
                                      const pendingRemoved = interventionEdit.removeTeamIds.includes(t.id);
                                      return (currentlyLinked && !pendingRemoved) || pendingAdded;
                                    })
                                    .map(t => (
                                      <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={removeTeamFromInterventionEdit}
                                  className="px-3 py-2 rounded-lg border border-slate-200 text-sm hover:bg-white"
                                >
                                  Verwijderen
                                </button>
                              </div>
                            </div>
                          </div>
                          )}

                          <div className="flex gap-2 justify-end">
                            <button
                              type="button"
                              onClick={cancelEditIntervention}
                              className="px-3 py-2 rounded-lg border border-slate-200 text-sm hover:bg-white"
                            >
                              Annuleren
                            </button>
                            <button
                              type="button"
                              onClick={() => saveInterventionEdit(inter.id)}
                              className="px-3 py-2 rounded-lg text-white text-sm"
                              style={{ backgroundColor: settings.primary_color }}
                            >
                              Opslaan
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="space-y-4">
                        {inter.teams.length > 0 ? inter.teams.map(team => (
                          <div key={team.id} className="pt-3 border-t border-slate-100">
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{team.name}</span>
                              <div
                                className="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
                                style={{ backgroundColor: team.status_color }}
                              >
                                {team.status_name}
                              </div>
                            </div>
                            {!inter.closed_at && (
                              <div className="text-[11px] text-slate-500 mb-2">
                                Op huidige status: {formatDuration(team.status_duration_seconds)}
                              </div>
                            )}
                            {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && !inter.closed_at && (
                              <div className="flex flex-wrap gap-1">
                                {statuses.map(s => (
                                  <button
                                    key={s.id}
                                    onClick={() => handleUpdateTeamStatus(inter.id, team.id, s.id)}
                                    className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                                      team.status_id === s.id
                                        ? 'ring-2 ring-offset-1 ring-slate-300 opacity-100'
                                        : 'opacity-40 hover:opacity-80'
                                    }`}
                                    style={{ backgroundColor: s.color, color: '#fff' }}
                                  >
                                    {s.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )) : (
                          <div className="text-xs text-slate-400 italic pt-2 border-t border-slate-100">
                            Geen ploegen gekoppeld
                          </div>
                        )}
                      </div>

                      {inter.closed_at && (inter.status_durations?.length || 0) > 0 && (
                        <div className="mt-4 pt-3 border-t border-slate-100">
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                            Duur Per Status
                          </p>
                          <div className="space-y-1">
                            {inter.status_durations?.map((d) => (
                              <div key={d.status_name} className="flex justify-between text-xs text-slate-600">
                                <span>{d.status_name}</span>
                                <span className="font-medium">{formatDuration(d.total_seconds)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mt-4 pt-3 border-t border-slate-100 space-y-2">
                        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Meldingen</p>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={newMessageByIntervention[inter.id] || ''}
                            onChange={(e) => setNewMessageByIntervention(prev => ({ ...prev, [inter.id]: e.target.value }))}
                            placeholder="Nieuw bericht..."
                            className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          />
                          <button
                            onClick={() => handleAddInterventionMessage(inter.id)}
                            className="px-3 py-2 rounded-lg text-white text-sm"
                            style={{ backgroundColor: settings.primary_color }}
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                          {(messagesByIntervention[inter.id] || []).map(msg => (
                            <div key={msg.id} className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                              <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                                <span>{msg.actor_username || 'Systeem'}</span>
                                <span>{format(new Date(msg.created_at), 'dd-MM-yyyy HH:mm:ss')}</span>
                              </div>
                              <div className="text-sm text-slate-700">{msg.message}</div>
                            </div>
                          ))}
                          {(messagesByIntervention[inter.id] || []).length === 0 && (
                            <div className="text-xs text-slate-400 italic">Nog geen meldingen.</div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {activeTab === 'teams' && !isViewer && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Ploegen</h2>
              {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                <button 
                  onClick={() => setShowNewTeam(true)}
                  className="text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors text-sm font-medium"
                  style={{ backgroundColor: settings.primary_color }}
                >
                  <Plus className="w-4 h-4" /> Nieuwe Ploeg
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {teams.map((team) => (
                <div key={team.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-slate-900">{team.name}</h3>
                      <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">{team.type}</span>
                    </div>
                    <Users className="w-5 h-5 text-slate-400" />
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="space-y-2">
                      {team.members.map(member => (
                        <div key={member.id} className="flex justify-between items-center text-sm p-2 bg-slate-50 rounded-lg group">
                          <div>
                            <span className="font-medium">{member.name}</span>
                            {member.role && <span className="text-slate-400 ml-2 text-xs">({member.role})</span>}
                          </div>
                          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                            <button 
                              onClick={() => handleRemoveMember(member.id)}
                              className="text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    
                    {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                      <div className="pt-2">
                        <button 
                          onClick={() => {
                            const name = prompt('Naam medewerker:');
                            const role = prompt('Rol:');
                            if (name) handleAddMember(team.id, name, role || '');
                          }}
                          className="w-full py-2 border border-dashed border-slate-300 rounded-lg text-slate-400 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all text-xs font-medium flex items-center justify-center gap-2"
                        >
                          <UserPlus className="w-3 h-3" /> Lid toevoegen
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'team_status' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Ploegen Overzicht & Status</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {teams.map((team) => {
                const openAssignments = interventions
                  .filter(inter => !inter.closed_at)
                  .map(inter => ({
                    intervention: inter,
                    assignment: inter.teams.find(t => t.id === team.id),
                  }))
                  .filter(item => !!item.assignment) as Array<{
                    intervention: Intervention;
                    assignment: TeamInIntervention;
                  }>;

                return (
                  <div key={team.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h3 className="font-bold text-slate-900">{team.name}</h3>
                        <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">{team.type}</span>
                      </div>
                      <span className="text-xs text-slate-500">
                        {openAssignments.length} actief
                      </span>
                    </div>

                    {openAssignments.length === 0 ? (
                      <div className="text-sm text-slate-400 italic">Geen actieve interventies.</div>
                    ) : (
                      <div className="space-y-2">
                        {openAssignments.map(({ intervention, assignment }) => (
                          <div key={`${team.id}-${intervention.id}`} className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium text-slate-800">{intervention.title}</span>
                              <span
                                className="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
                                style={{ backgroundColor: assignment.status_color }}
                              >
                                {assignment.status_name}
                              </span>
                            </div>
                            <div className="text-xs text-slate-500 mt-1">
                              Locatie: {intervention.location || 'Onbekend'}
                            </div>
                            <div className="text-xs text-slate-500 mt-1">
                              Omschrijving: {intervention.description || '-'}
                            </div>
                            <div className="text-xs text-slate-500 mt-1">
                              Op status sinds: {formatDuration(assignment.status_duration_seconds)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'logs' && !isViewer && (
          <div className="max-w-2xl mx-auto space-y-6">
            {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
              <form onSubmit={handleAddLog} className="space-y-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <select
                    value={newLogContext.intervention_id}
                    onChange={e => setNewLogContext(prev => ({ ...prev, intervention_id: e.target.value }))}
                    className="px-3 py-2 rounded-lg border border-slate-200 text-sm"
                  >
                    <option value="">Geen interventie</option>
                    {interventions.map(inter => (
                      <option key={inter.id} value={inter.id}>{inter.title}</option>
                    ))}
                  </select>
                  <select
                    value={newLogContext.team_id}
                    onChange={e => setNewLogContext(prev => ({ ...prev, team_id: e.target.value }))}
                    className="px-3 py-2 rounded-lg border border-slate-200 text-sm"
                  >
                    <option value="">Geen ploeg</option>
                    {teams.map(team => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newLog}
                    onChange={(e) => setNewLog(e.target.value)}
                    placeholder="Nieuwe opmerking..."
                    className="flex-1 px-4 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button 
                    className="text-white px-4 py-2 rounded-lg transition-colors"
                    style={{ backgroundColor: settings.primary_color }}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 p-3 bg-slate-100 rounded-xl">
              <select
                value={logFilters.user_id}
                onChange={e => setLogFilters(prev => ({ ...prev, user_id: e.target.value }))}
                className="px-3 py-2 rounded-lg border border-slate-200 text-sm"
              >
                <option value="">Alle gebruikers</option>
                {logUsers.map(u => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
              <select
                value={logFilters.team_id}
                onChange={e => setLogFilters(prev => ({ ...prev, team_id: e.target.value }))}
                className="px-3 py-2 rounded-lg border border-slate-200 text-sm"
              >
                <option value="">Alle ploegen</option>
                {teams.map(team => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
              <select
                value={logFilters.intervention_id}
                onChange={e => setLogFilters(prev => ({ ...prev, intervention_id: e.target.value }))}
                className="px-3 py-2 rounded-lg border border-slate-200 text-sm"
              >
                <option value="">Alle interventies</option>
                {interventions.map(inter => (
                  <option key={inter.id} value={inter.id}>{inter.title}</option>
                ))}
              </select>
            </div>

            <div className="space-y-4">
              {logs.map((log) => {
                const teamName = log.team_id ? teams.find(t => t.id === log.team_id)?.name : null;
                const interventionTitle = log.intervention_id
                  ? interventions.find(i => i.id === log.intervention_id)?.title
                  : null;
                return (
                  <div key={log.id} className="p-4 bg-white rounded-xl border border-slate-100 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                      <span className="font-mono text-slate-400">
                        {format(new Date(log.created_at), 'dd-MM-yyyy HH:mm:ss')}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                        {log.actor_username || 'Systeem'}
                      </span>
                      {teamName && (
                        <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                          Ploeg: {teamName}
                        </span>
                      )}
                      {interventionTitle && (
                        <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">
                          Interventie: {interventionTitle}
                        </span>
                      )}
                    </div>
                    <div className="text-slate-700">{log.message}</div>
                  </div>
                );
              })}
            </div>

            {logsLoading && (
              <div className="text-center text-sm text-slate-500 py-2">Logboek laden...</div>
            )}
            {!logsLoading && logsHasMore && (
              <div className="flex justify-center">
                <button
                  onClick={() => fetchLogs(false)}
                  className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50"
                >
                  Meer laden
                </button>
              </div>
            )}
            {!logsLoading && logs.length === 0 && (
              <div className="text-center text-sm text-slate-500 py-2">Geen logs gevonden.</div>
            )}
          </div>
        )}

        {activeTab === 'settings' && !isViewer && hasRole(['ROOT', 'ADMIN']) && (
          <div className="max-w-xl mx-auto space-y-8">
            <section>
              <h3 className="text-lg font-semibold mb-4">Event Toegang (Operator/Viewer)</h3>
              <div className="space-y-2 mb-4">
                <h4 className="text-sm font-semibold text-slate-600">Gekoppelde Gebruikers</h4>
                {eventAssignableUsers
                  .filter(u => eventAssignedUserIds.includes(u.id))
                  .map(u => (
                    <div key={`assigned-${u.id}`} className="flex items-center justify-between p-3 bg-white rounded-lg border border-slate-200">
                      <div>
                        <span className="font-medium text-slate-800">{u.username}</span>
                        <span className="ml-2 text-xs uppercase text-slate-400 font-bold">{u.role}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setEventAssignedUserIds(prev => prev.filter(id => id !== u.id))}
                        className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                      >
                        Verwijderen
                      </button>
                    </div>
                  ))}
                {eventAssignableUsers.filter(u => eventAssignedUserIds.includes(u.id)).length === 0 && (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 text-sm text-slate-500">
                    Nog geen gebruikers gekoppeld aan dit evenement.
                  </div>
                )}
              </div>

              <div className="space-y-2 mb-4">
                <h4 className="text-sm font-semibold text-slate-600">Beschikbare Operatoren/Viewers</h4>
                {eventAssignableUsers.map(u => (
                  <label key={u.id} className="flex items-center justify-between p-3 bg-white rounded-lg border border-slate-200">
                    <div>
                      <span className="font-medium text-slate-800">{u.username}</span>
                      <span className="ml-2 text-xs uppercase text-slate-400 font-bold">{u.role}</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={eventAssignedUserIds.includes(u.id)}
                      onChange={(e) => {
                        setEventAssignedUserIds(prev =>
                          e.target.checked
                            ? (prev.includes(u.id) ? prev : [...prev, u.id])
                            : prev.filter(id => id !== u.id)
                        );
                      }}
                    />
                  </label>
                ))}
                {eventAssignableUsers.length === 0 && (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 text-sm text-slate-500">
                    Geen operators/viewers beschikbaar.
                  </div>
                )}
              </div>
              <button
                onClick={handleSaveEventAssignments}
                disabled={savingEventAssignments}
                className="w-full bg-slate-900 text-white py-2 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-60"
              >
                {savingEventAssignments ? 'Opslaan...' : 'Toegang Opslaan'}
              </button>
            </section>

            <section>
              <h3 className="text-lg font-semibold mb-4">Teamsoorten Beheren</h3>
              <div className="space-y-2 mb-6">
                {teamTypes.map(t => (
                  <div key={t.id} className="flex items-center justify-between p-3 bg-white rounded-lg border border-slate-200">
                    {editingTeamTypeId === t.id ? (
                      <>
                        <input
                          type="text"
                          value={editingTeamTypeName}
                          onChange={e => setEditingTeamTypeName(e.target.value)}
                          className="flex-1 px-3 py-2 rounded border border-slate-200 text-sm"
                        />
                        <div className="flex items-center gap-2 ml-3">
                          <button
                            onClick={handleSaveEditTeamType}
                            className="text-emerald-600 hover:text-emerald-700 transition-colors"
                            title="Opslaan"
                          >
                            <Save className="w-4 h-4" />
                          </button>
                          <button
                            onClick={handleCancelEditTeamType}
                            className="text-slate-400 hover:text-slate-600 transition-colors"
                            title="Annuleren"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-slate-800">{t.name}</span>
                        <div className="flex items-center gap-2 ml-3">
                          <button
                            onClick={() => handleStartEditTeamType(t)}
                            className="text-slate-300 hover:text-blue-600 transition-colors"
                            title="Teamsoort bewerken"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteTeamType(t.id, t.name)}
                            className="text-slate-300 hover:text-red-600 transition-colors"
                            title="Teamsoort verwijderen"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {teamTypes.length === 0 && (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 text-sm text-slate-500">
                    Nog geen teamsoorten gedefinieerd.
                  </div>
                )}
              </div>

              <form onSubmit={handleAddTeamType} className="p-4 bg-slate-100 rounded-xl space-y-4">
                <h4 className="text-sm font-bold text-slate-600 uppercase">Nieuwe Teamsoort</h4>
                <input
                  type="text"
                  placeholder="Bijv. Verkeer"
                  value={newTeamTypeName}
                  onChange={e => setNewTeamTypeName(e.target.value)}
                  className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
                  required
                />
                <button className="w-full bg-slate-800 text-white py-2 rounded-lg text-sm font-medium hover:bg-slate-900 transition-colors">
                  Teamsoort Toevoegen
                </button>
              </form>
            </section>

            <section>
              <h3 className="text-lg font-semibold mb-4">Statussen Beheren</h3>
              <div className="space-y-3 mb-6">
                {statuses.map(s => (
                  <div key={s.id} className="flex items-center justify-between p-3 bg-white rounded-lg border border-slate-200">
                    {editingStatusId === s.id ? (
                      <>
                        <div className="flex items-center gap-3 flex-1">
                          <input
                            type="color"
                            value={editingStatus.color}
                            onChange={e => setEditingStatus(prev => ({ ...prev, color: e.target.value }))}
                            className="w-10 h-10 rounded border border-slate-200"
                          />
                          <input
                            type="text"
                            value={editingStatus.name}
                            onChange={e => setEditingStatus(prev => ({ ...prev, name: e.target.value }))}
                            className="flex-1 px-3 py-2 rounded border border-slate-200 text-sm"
                          />
                          <label className="text-xs text-slate-600 flex items-center gap-2 whitespace-nowrap">
                            <input
                              type="checkbox"
                              checked={editingStatus.is_closed}
                              onChange={e => setEditingStatus(prev => ({ ...prev, is_closed: e.target.checked }))}
                            />
                            Sluit interventie
                          </label>
                        </div>
                        <div className="flex items-center gap-2 ml-3">
                          <button
                            onClick={handleSaveStatusEdit}
                            className="text-emerald-600 hover:text-emerald-700 transition-colors"
                            title="Opslaan"
                          >
                            <Save className="w-4 h-4" />
                          </button>
                          <button
                            onClick={handleCancelStatusEdit}
                            className="text-slate-400 hover:text-slate-600 transition-colors"
                            title="Annuleren"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-3">
                          <div className="w-4 h-4 rounded-full" style={{ backgroundColor: s.color }} />
                          <span className="font-medium">{s.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {s.is_closed ? (
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Sluit interventie</span>
                          ) : null}
                          <button
                            onClick={() => handleStartEditStatus(s)}
                            className="text-slate-300 hover:text-blue-600 transition-colors"
                            title="Status bewerken"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteStatus(s.id, s.name)}
                            className="text-slate-300 hover:text-red-600 transition-colors"
                            title="Status verwijderen"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>

              <form onSubmit={handleAddStatus} className="p-4 bg-slate-100 rounded-xl space-y-4">
                <h4 className="text-sm font-bold text-slate-600 uppercase">Nieuwe Status</h4>
                <div className="grid grid-cols-2 gap-4">
                  <input
                    type="text"
                    placeholder="Naam"
                    value={newStatus.name}
                    onChange={e => setNewStatus(prev => ({ ...prev, name: e.target.value }))}
                    className="px-3 py-2 rounded border border-slate-200 text-sm"
                    required
                  />
                  <input
                    type="color"
                    value={newStatus.color}
                    onChange={e => setNewStatus(prev => ({ ...prev, color: e.target.value }))}
                    className="w-full h-10 rounded border border-slate-200"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={newStatus.is_closed}
                    onChange={e => setNewStatus(prev => ({ ...prev, is_closed: e.target.checked }))}
                  />
                  Markeer als 'Gesloten' status
                </label>
                <button className="w-full bg-slate-800 text-white py-2 rounded-lg text-sm font-medium hover:bg-slate-900 transition-colors">
                  Status Toevoegen
                </button>
              </form>
            </section>
          </div>
        )}
      </main>

      {/* Modals */}
      {showNewIntervention && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl"
          >
            <h2 className="text-2xl font-bold mb-6">Nieuwe Interventie</h2>
            <form onSubmit={handleAddIntervention} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Titel</label>
                <input
                  autoFocus
                  type="text"
                  required
                  value={newIntervention.title}
                  onChange={e => setNewIntervention(prev => ({ ...prev, title: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Locatie</label>
                <input
                  type="text"
                  value={newIntervention.location}
                  onChange={e => setNewIntervention(prev => ({ ...prev, location: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Omschrijving</label>
                <input
                  type="text"
                  value={newIntervention.description}
                  onChange={e => setNewIntervention(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Initiële Status (voor alle ploegen)</label>
                <select
                  value={newIntervention.status_id}
                  onChange={e => setNewIntervention(prev => ({ ...prev, status_id: Number(e.target.value) }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {statuses.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Ploegen Koppelen</label>
                <div className="grid grid-cols-2 gap-2 max-h-32 overflow-y-auto p-2 border border-slate-100 rounded-lg">
                  {teams.map(team => (
                    <label key={team.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={newIntervention.team_ids.includes(team.id)}
                        onChange={e => {
                          if (e.target.checked) {
                            setNewIntervention(prev => ({ ...prev, team_ids: [...prev.team_ids, team.id] }));
                          } else {
                            setNewIntervention(prev => ({ ...prev, team_ids: prev.team_ids.filter(id => id !== team.id) }));
                          }
                        }}
                      />
                      {team.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-3 mt-8">
                <button 
                  type="button"
                  onClick={() => setShowNewIntervention(false)}
                  className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
                >
                  Annuleren
                </button>
                <button 
                  type="submit"
                  className="flex-1 px-4 py-2 text-white rounded-lg transition-colors"
                  style={{ backgroundColor: settings.primary_color }}
                >
                  Aanmaken
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {showEventAnnouncement && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl"
          >
            <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <Megaphone className="text-red-600" /> Event Melding
            </h2>
            <form onSubmit={handleUpdateEventAnnouncement} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Bericht</label>
                <textarea
                  required
                  value={eventAnnouncement.message}
                  onChange={e => setEventAnnouncement(prev => ({ ...prev, message: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-red-500 outline-none transition-all h-28"
                  placeholder="Typ hier de event melding..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Achtergrondkleur</label>
                <div className="flex gap-2">
                  {['#ef4444', '#f97316', '#eab308', '#3b82f6', '#1e293b'].map(color => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setEventAnnouncement(prev => ({ ...prev, bg_color: color }))}
                      className={`w-10 h-10 rounded-full border-2 ${eventAnnouncement.bg_color === color ? 'border-slate-900 ring-2 ring-slate-200' : 'border-transparent'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <input
                    type="color"
                    value={eventAnnouncement.bg_color}
                    onChange={e => setEventAnnouncement(prev => ({ ...prev, bg_color: e.target.value }))}
                    className="w-10 h-10 rounded-full border-none p-0 overflow-hidden cursor-pointer"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eventAnnouncement.is_active}
                  onChange={e => setEventAnnouncement(prev => ({ ...prev, is_active: e.target.checked }))}
                  className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                Toon eventbanner aan iedereen in dit evenement
              </label>
              <div className="flex gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setShowEventAnnouncement(false)}
                  className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
                >
                  Annuleren
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                >
                  Opslaan
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}

      {showNewTeam && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl"
          >
            <h2 className="text-2xl font-bold mb-6">Nieuwe Ploeg</h2>
            <form onSubmit={handleAddTeam} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Naam</label>
                <input
                  autoFocus
                  type="text"
                  required
                  value={newTeam.name}
                  onChange={e => setNewTeam(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Bijv. Alpha 1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
                <select
                  value={newTeam.type}
                  onChange={e => setNewTeam(prev => ({ ...prev, type: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  required
                >
                  {teamTypes.length === 0 ? (
                    <option value="">Geen teamsoorten beschikbaar</option>
                  ) : (
                    teamTypes.map(type => (
                      <option key={type.id} value={type.name}>{type.name}</option>
                    ))
                  )}
                </select>
                {teamTypes.length === 0 && (
                  <p className="text-xs text-slate-500 mt-2">
                    Voeg eerst een teamsoort toe in Instellingen.
                  </p>
                )}
              </div>
              <div className="flex gap-3 mt-8">
                <button 
                  type="button"
                  onClick={() => setShowNewTeam(false)}
                  className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
                >
                  Annuleren
                </button>
                <button 
                  type="submit"
                  className="flex-1 px-4 py-2 text-white rounded-lg transition-colors"
                  style={{ backgroundColor: settings.primary_color }}
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
