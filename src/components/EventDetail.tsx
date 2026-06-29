import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { 
  Plus, Users, Activity, FileText, Settings, 
  ChevronRight, MapPin, Clock, CheckCircle2, 
  AlertCircle, Download, Send, Trash2, UserPlus, Pencil, Save, X,
  Building2, Phone, LogOut, Megaphone
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { enUS, nl } from 'date-fns/locale';
import { useUser, Role } from '../contexts/UserContext';
import { fetchJsonSafe } from '../utils/http';
import LanguageSelector from './LanguageSelector';

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
  is_start: number;
  is_busy: number;
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
  is_deployed: number;
  aid_post_id?: number | null;
  aid_post_name?: string | null;
  current_status_id?: number | null;
  current_status_name?: string | null;
  current_status_color?: string | null;
  current_status_updated_at?: string | null;
  current_status_updated_at_ms?: number | null;
  current_status_duration_seconds?: number | null;
  current_status_duration_calculated_at?: string | null;
  current_status_is_start?: number | null;
  current_status_is_closed?: number | null;
  current_status_is_busy?: number | null;
  members: TeamMember[];
}

interface TeamType {
  id: number;
  name: string;
}

interface AidPost {
  id: number;
  name: string;
  location?: string;
  description?: string;
}

interface TeamInIntervention extends Team {
  status_id: number;
  status_name: string;
  status_color: string;
  status_is_closed: number;
  status_started_at?: string | null;
  status_started_at_ms?: number | null;
  status_duration_seconds?: number | null;
  status_duration_calculated_at?: string | null;
}

interface InterventionStatusDuration {
  status_name: string;
  total_seconds: number;
}

interface InterventionTeamHistory {
  id: number;
  team_id: number;
  team_name: string;
  team_type?: string | null;
  status_id: number | null;
  status_name: string | null;
  status_color?: string | null;
  started_at: string;
  ended_at?: string | null;
  started_at_ms?: number | null;
  ended_at_ms?: number | null;
  duration_seconds?: number | null;
  duration_calculated_at?: string | null;
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
  open_seconds_calculated_at?: string;
  status_durations?: InterventionStatusDuration[];
  team_history?: InterventionTeamHistory[];
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
  title: string;
  location: string;
  description: string;
  addTeamStatusId: number;
  addTeamIds: number[];
  selectedAddTeamId: string;
}

interface EventAssignee {
  id: number;
  username: string;
  role: Role;
  aid_post_id?: number | null;
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

type EventTab = 'info' | 'interventions' | 'team_status' | 'teams' | 'logs' | 'settings';

type EventTabConfig = {
  id: EventTab;
  label: string;
  icon: LucideIcon;
  roles?: Role[];
};

const EVENT_TABS: EventTabConfig[] = [
  { id: 'info', label: 'Evenementinfo', icon: FileText },
  { id: 'interventions', label: 'Interventies', icon: Activity },
  { id: 'team_status', label: 'Ploegstatus', icon: Users },
  { id: 'teams', label: 'Ploegen', icon: Users },
  { id: 'logs', label: 'Logboek', icon: FileText },
  { id: 'settings', label: 'Instellingen', icon: Settings, roles: ['ROOT', 'ADMIN'] },
];

const isEventAssignee = (value: unknown): value is EventAssignee => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EventAssignee>;
  return (
    typeof candidate.id === 'number'
    && typeof candidate.username === 'string'
    && (candidate.role === 'ROOT' || candidate.role === 'ADMIN' || candidate.role === 'OPERATOR' || candidate.role === 'VIEWER')
    && (
      typeof candidate.aid_post_id === 'undefined'
      || candidate.aid_post_id === null
      || typeof candidate.aid_post_id === 'number'
    )
  );
};

export default function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, logout, hasRole, settings, languageCode, t } = useUser();
  const isViewer = user?.role === 'VIEWER';
  const requestedTab = searchParams.get('tab') as EventTab | null;
  const initialTab: EventTab = requestedTab && EVENT_TABS.some(tab => tab.id === requestedTab)
    ? requestedTab
    : 'interventions';
  const [event, setEvent] = useState<Event | null>(null);
  const [activeTab, setActiveTabState] = useState<EventTab>(initialTab);
  const [settingsSubTab, setSettingsSubTab] = useState<'access' | 'team_types' | 'statuses'>('access');
  const [interventionTab, setInterventionTab] = useState<'open' | 'closed'>('open');
  const [interventionView, setInterventionView] = useState<'cards' | 'list'>('cards');
  const [expandedTeamStatusKey, setExpandedTeamStatusKey] = useState<string | null>(null);
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamTypes, setTeamTypes] = useState<TeamType[]>([]);
  const [aidPosts, setAidPosts] = useState<AidPost[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [logUsers, setLogUsers] = useState<LogUser[]>([]);
  const [durationNow, setDurationNow] = useState(Date.now());
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
  const [eventFormDirty, setEventFormDirty] = useState(false);
  const [savingEventInfo, setSavingEventInfo] = useState(false);

  // Form states
  const [showNewIntervention, setShowNewIntervention] = useState(false);
  const [newIntervention, setNewIntervention] = useState({ title: '', location: '', description: '', status_id: 0, team_ids: [] as number[] });
  const [showEventAnnouncement, setShowEventAnnouncement] = useState(false);
  const [eventAnnouncement, setEventAnnouncement] = useState({ message: '', bg_color: '#ef4444', is_active: false });
  const [eventAnnouncementDirty, setEventAnnouncementDirty] = useState(false);
  
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeam, setNewTeam] = useState({ name: '', type: '', aid_post_id: '' });
  const [showNewAidPost, setShowNewAidPost] = useState(false);
  const [newAidPost, setNewAidPost] = useState({ name: '', location: '', description: '' });
  const [editingAidPostId, setEditingAidPostId] = useState<number | null>(null);
  const [editingAidPostForm, setEditingAidPostForm] = useState({ name: '', location: '', description: '' });

  const [newLog, setNewLog] = useState('');
  const [newLogContext, setNewLogContext] = useState({ team_id: '', intervention_id: '' });
  const [newStatus, setNewStatus] = useState({ name: '', color: '#3b82f6', is_closed: false, is_start: false, is_busy: false });
  const [newTeamTypeName, setNewTeamTypeName] = useState('');
  const [editingTeamTypeId, setEditingTeamTypeId] = useState<number | null>(null);
  const [editingTeamTypeName, setEditingTeamTypeName] = useState('');
  const [editingStatusId, setEditingStatusId] = useState<number | null>(null);
  const [editingStatus, setEditingStatus] = useState({ name: '', color: '#3b82f6', is_closed: false, is_start: false, is_busy: false });
  const [messagesByIntervention, setMessagesByIntervention] = useState<Record<number, InterventionMessage[]>>({});
  const [newMessageByIntervention, setNewMessageByIntervention] = useState<Record<number, string>>({});
  const [editingInterventionId, setEditingInterventionId] = useState<number | null>(null);
  const [interventionEdit, setInterventionEdit] = useState<InterventionEditState | null>(null);
  const [editingTeamNameId, setEditingTeamNameId] = useState<number | null>(null);
  const [teamNameDrafts, setTeamNameDrafts] = useState<Record<number, string>>({});
  const [teamTypeDrafts, setTeamTypeDrafts] = useState<Record<number, string>>({});
  const [teamAidPostDrafts, setTeamAidPostDrafts] = useState<Record<number, string>>({});
  const [teamDeployedDrafts, setTeamDeployedDrafts] = useState<Record<number, boolean>>({});
  const [eventAssignableUsers, setEventAssignableUsers] = useState<EventAssignee[]>([]);
  const [eventAssignedUserIds, setEventAssignedUserIds] = useState<number[]>([]);
  const [eventAssignedAidPostIds, setEventAssignedAidPostIds] = useState<Record<number, string>>({});
  const [savingEventAssignments, setSavingEventAssignments] = useState(false);
  const [teamStatusDrafts, setTeamStatusDrafts] = useState<Record<number, string>>({});
  const [statusAidPostDrafts, setStatusAidPostDrafts] = useState<Record<string, string>>({});
  const [teamStatusSaveState, setTeamStatusSaveState] = useState<Record<number, 'saving' | 'saved' | 'error'>>({});
  const [interventionTeamStatusSaveState, setInterventionTeamStatusSaveState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});

  const setActiveTab = (nextTab: EventTab) => {
    setActiveTabState(nextTab);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', nextTab);
    setSearchParams(nextParams, { replace: true });
  };

  const updateEventForm = (patch: Partial<EventFormState>) => {
    setEventFormDirty(true);
    setEventForm(prev => ({ ...prev, ...patch }));
  };

  const updateEventAnnouncement = (patch: Partial<typeof eventAnnouncement>) => {
    setEventAnnouncementDirty(true);
    setEventAnnouncement(prev => ({ ...prev, ...patch }));
  };

  useEffect(() => {
    void fetchData();
  }, [id]);

  useEffect(() => {
    const nextTab = searchParams.get('tab') as EventTab | null;
    if (nextTab && EVENT_TABS.some(tab => tab.id === nextTab) && nextTab !== activeTab) {
      setActiveTabState(nextTab);
    }
  }, [searchParams, activeTab]);

  useEffect(() => {
    if (isViewer && activeTab !== 'team_status') {
      setActiveTab('team_status');
    }
  }, [isViewer, activeTab]);

  useEffect(() => {
    if (activeTab !== 'team_status' && activeTab !== 'interventions') return;
    const interval = window.setInterval(() => {
      void fetchData({ background: true });
    }, 15000);
    return () => window.clearInterval(interval);
  }, [activeTab, id, eventFormDirty, eventAnnouncementDirty]);

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

  useEffect(() => {
    setTeamNameDrafts(prev => {
      const next: Record<number, string> = {};
      for (const team of teams) next[team.id] = editingTeamNameId === team.id ? (prev[team.id] ?? team.name) : team.name;
      return next;
    });
    setTeamTypeDrafts(prev => {
      const next: Record<number, string> = {};
      for (const team of teams) next[team.id] = editingTeamNameId === team.id ? (prev[team.id] ?? team.type) : team.type;
      return next;
    });
    setTeamAidPostDrafts(prev => {
      const next: Record<number, string> = {};
      for (const team of teams) {
        const serverValue = team.aid_post_id ? String(team.aid_post_id) : '';
        next[team.id] = editingTeamNameId === team.id ? (prev[team.id] ?? serverValue) : serverValue;
      }
      return next;
    });
    setTeamDeployedDrafts(prev => {
      const next: Record<number, boolean> = {};
      for (const team of teams) next[team.id] = prev[team.id] ?? (Number(team.is_deployed) === 1);
      return next;
    });
    setTeamStatusDrafts(prev => {
      const next: Record<number, string> = {};
      for (const team of teams) {
        const serverValue = team.current_status_id ? String(team.current_status_id) : '';
        next[team.id] = teamStatusSaveState[team.id] === 'saving' ? (prev[team.id] ?? serverValue) : serverValue;
      }
      return next;
    });
  }, [teams, editingTeamNameId, teamStatusSaveState]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setDurationNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const fetchData = async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) setLoading(true);
    try {
      const [eventResult, interResult, teamResult, teamTypeResult, aidPostResult, statusResult, logUsersResult] = await Promise.all([
        fetchJsonSafe<Event>(`/api/events/${id}`),
        fetchJsonSafe<Intervention[]>(`/api/events/${id}/interventions`),
        fetchJsonSafe<Team[]>(`/api/events/${id}/teams`),
        fetchJsonSafe<TeamType[]>(`/api/events/${id}/team-types`),
        fetchJsonSafe<AidPost[]>(`/api/events/${id}/aid-posts`),
        fetchJsonSafe<Status[]>(`/api/events/${id}/statuses`),
        fetchJsonSafe<LogUser[]>(`/api/events/${id}/log-users`)
      ]);

      const hasUnauthorized = [
        eventResult,
        interResult,
        teamResult,
        teamTypeResult,
        aidPostResult,
        statusResult,
        logUsersResult,
      ].some(({ response }) => response.status === 401);
      if (hasUnauthorized) {
        navigate(`/${languageCode}`);
        return;
      }

      const eventData = eventResult.response.ok ? eventResult.data : null;
      const interData = interResult.response.ok ? interResult.data : null;
      const teamData = teamResult.response.ok ? teamResult.data : null;
      const teamTypeData = teamTypeResult.response.ok ? teamTypeResult.data : null;
      const aidPostData = aidPostResult.response.ok ? aidPostResult.data : null;
      const statusData = statusResult.response.ok ? statusResult.data : null;
      const logUsersData = logUsersResult.response.ok ? logUsersResult.data : null;

      if (eventData) {
        setEvent(eventData);
        if (!eventFormDirty) {
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
      if (Array.isArray(aidPostData)) {
        setAidPosts(aidPostData);
        setNewTeam(prev => ({
          ...prev,
          aid_post_id: aidPostData.some(p => String(p.id) === prev.aid_post_id) ? prev.aid_post_id : '',
        }));
      } else {
        setAidPosts([]);
        setNewTeam(prev => ({ ...prev, aid_post_id: '' }));
      }
      if (Array.isArray(statusData)) {
        setStatuses(statusData);
        if (statusData.length > 0) {
          const busy = statusData.find((s) => Number(s.is_busy) === 1);
          setNewIntervention(prev => {
            if (prev.status_id && statusData.some(s => Number(s.id) === Number(prev.status_id))) {
              return prev;
            }
            return { ...prev, status_id: busy?.id || statusData[0].id };
          });
        }
      }

      const eventAnnouncementResult = await fetchJsonSafe<{
        message?: string;
        bg_color?: string;
        is_active?: unknown;
      }>(`/api/events/${id}/announcement`);
      if (eventAnnouncementResult.response.ok && eventAnnouncementResult.data) {
        const data = eventAnnouncementResult.data;
        if (!eventAnnouncementDirty) {
          setEventAnnouncement({
            message: data.message || '',
            bg_color: data.bg_color || '#ef4444',
            is_active: !!data.is_active,
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
            ? usersData.filter(isEventAssignee).filter((u) => u.role === 'OPERATOR' || u.role === 'VIEWER')
            : [];
          setEventAssignableUsers(scopedUsers);
        }
        if (assignedRes.ok) {
          const assignedData = await assignedRes.json();
          if (Array.isArray(assignedData)) {
            const scoped = assignedData.filter(isEventAssignee);
            setEventAssignedUserIds(scoped.map((u) => Number(u.id)));
            const nextAidPostByUser: Record<number, string> = {};
            for (const row of scoped) {
              nextAidPostByUser[row.id] = row.aid_post_id ? String(row.aid_post_id) : '';
            }
            setEventAssignedAidPostIds(nextAidPostByUser);
          } else {
            setEventAssignedUserIds([]);
            setEventAssignedAidPostIds({});
          }
        }
      }

      await fetchLogs(true);
    } catch (err) {
      console.error(err);
    } finally {
      if (!background) setLoading(false);
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

  const getConfiguredTimezone = () => settings.timezone || 'Europe/Brussels';

  const parseTimestamp = (value: string | Date) => {
    if (value instanceof Date) return value;
    const trimmed = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)) {
      return new Date(`${trimmed.replace(' ', 'T')}Z`);
    }
    return new Date(trimmed);
  };

  const formatTime = (value: string | Date) =>
    new Intl.DateTimeFormat(languageCode === 'nl' ? 'nl-BE' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: getConfiguredTimezone(),
    }).format(parseTimestamp(value));

  const formatDateTime = (value: string | Date) =>
    new Intl.DateTimeFormat(languageCode === 'nl' ? 'nl-BE' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: getConfiguredTimezone(),
    }).format(parseTimestamp(value));

  const formatTimestampWithoutTimezone = (value?: string | Date | null, epochMs?: number | null) => {
    if (epochMs != null && Number.isFinite(Number(epochMs))) {
      return format(new Date(Number(epochMs)), 'yyyy-MM-dd HH:mm:ss');
    }
    if (!value) return '-';
    if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
    return String(value)
      .trim()
      .replace('T', ' ')
      .replace(/Z$/, '')
      .replace(/\.\d+$/, '');
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

  const getLiveStatusDuration = (
    statusStartedAt?: string | null,
    fallbackSeconds?: number | null,
    isClosed?: boolean,
    calculatedAt?: string | null
  ) => {
    if (isClosed) return fallbackSeconds ?? null;
    if (fallbackSeconds != null) {
      const calculatedAtMs = calculatedAt ? parseTimestamp(calculatedAt).getTime() : durationNow;
      const elapsedSinceCalculation = Math.max(0, Math.floor((durationNow - calculatedAtMs) / 1000));
      return fallbackSeconds + elapsedSinceCalculation;
    }
    if (statusStartedAt) {
      return Math.max(0, Math.floor((durationNow - parseTimestamp(statusStartedAt).getTime()) / 1000));
    }
    return null;
  };

  const getLiveOpenDuration = (intervention: Intervention) => {
    const baseSeconds = intervention.open_seconds ?? null;
    if (baseSeconds == null) return null;
    if (intervention.closed_at) return baseSeconds;
    const calculatedAt = intervention.open_seconds_calculated_at
      ? parseTimestamp(intervention.open_seconds_calculated_at).getTime()
      : durationNow;
    const elapsedSinceCalculation = Math.max(0, Math.floor((durationNow - calculatedAt) / 1000));
    return baseSeconds + elapsedSinceCalculation;
  };

  const getDefaultInterventionStatusId = () => {
    const busy = statuses.find(s => Number(s.is_busy) === 1);
    if (busy) return busy.id;
    return statuses[0]?.id || 0;
  };

  const getStartStatusId = () => {
    const start = statuses.find(s => Number(s.is_start) === 1);
    if (start) return start.id;
    return statuses[0]?.id || 0;
  };

  const emptyInterventionForm = () => ({
    title: '',
    location: '',
    description: '',
    status_id: getDefaultInterventionStatusId(),
    team_ids: [] as number[],
  });

  const openNewInterventionModal = () => {
    setNewIntervention(emptyInterventionForm());
    setShowNewIntervention(true);
  };

  const cancelNewInterventionModal = () => {
    setNewIntervention(emptyInterventionForm());
    setShowNewIntervention(false);
  };

  const isStatusStartOrClosed = (statusId?: number | null) => {
    if (!statusId) return false;
    const status = statuses.find(s => s.id === Number(statusId));
    return Boolean(status && (Number(status.is_start) === 1 || Number(status.is_closed) === 1));
  };

  const canTeamBeAddedToIntervention = (teamId: number, interventionId: number) => {
    const team = teams.find(t => Number(t.id) === Number(teamId));
    if (!team || Number(team.is_deployed) !== 1) return false;

    const activeOtherInterventions = interventions.filter(i => !i.closed_at && i.id !== interventionId);
    const teamStatuses = activeOtherInterventions
      .flatMap(i => i.teams)
      .filter(t => Number(t.id) === Number(teamId))
      .map(t => t.status_id);

    if (teamStatuses.length === 0) return true;
    return teamStatuses.every(statusId => isStatusStartOrClosed(statusId));
  };

  const getTeamStatusEditorKey = (interventionId: number, teamId: number) => `${interventionId}-${teamId}`;

  const handleAddIntervention = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`/api/events/${id}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newIntervention)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Interventie aanmaken mislukt');
      return;
    }
    setShowNewIntervention(false);
    setNewIntervention(emptyInterventionForm());
    void fetchData({ background: true });
  };

  const beginEditIntervention = (inter: Intervention) => {
    setEditingInterventionId(inter.id);
    setInterventionEdit({
      title: inter.title || '',
      location: inter.location || '',
      description: inter.description || '',
      addTeamStatusId: getDefaultInterventionStatusId(),
      addTeamIds: [],
      selectedAddTeamId: '',
    });
  };

  const cancelEditIntervention = () => {
    setEditingInterventionId(null);
    setInterventionEdit(null);
  };

  const saveInterventionEdit = async (interventionId: number) => {
    if (!interventionEdit) return;
    if (!interventionEdit.title.trim()) {
      alert('Titel is verplicht');
      return;
    }
    const res = await fetch(`/api/interventions/${interventionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: interventionEdit.title.trim(),
        location: interventionEdit.location.trim(),
        description: interventionEdit.description.trim(),
        add_team_ids: interventionEdit.addTeamIds,
        default_status_id: interventionEdit.addTeamStatusId || getDefaultInterventionStatusId() || null,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Interventie bewerken mislukt');
      return;
    }

    cancelEditIntervention();
    void fetchData({ background: true });
  };

  const handleUpdateTeamStatus = async (interId: number, teamId: number, statusId: number) => {
    if (!hasRole(['ROOT', 'ADMIN', 'OPERATOR'])) return;
    const statusKey = getTeamStatusEditorKey(interId, teamId);
    const destinationAidPostId = statusAidPostDrafts[statusKey];
    const previousInterventions = interventions;
    setInterventionTeamStatusSaveState(prev => ({ ...prev, [statusKey]: 'saving' }));
    const res = await fetch(`/api/interventions/${interId}/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status_id: statusId,
        aid_post_id: destinationAidPostId ? Number(destinationAidPostId) : null,
      })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setInterventions(previousInterventions);
      setInterventionTeamStatusSaveState(prev => ({ ...prev, [statusKey]: 'error' }));
      alert(data?.error || 'Status wijzigen mislukt');
      return;
    }

    const selectedStatus = statuses.find(s => Number(s.id) === Number(statusId));
    if (selectedStatus) {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      setInterventions(prev =>
        prev.map(inter => {
          if (Number(inter.id) !== Number(interId)) return inter;

          const updatedTeams = inter.teams.map(team => {
            if (Number(team.id) !== Number(teamId)) return team;
            return {
              ...team,
              status_id: selectedStatus.id,
              status_name: selectedStatus.name,
              status_color: selectedStatus.color,
              status_is_closed: selectedStatus.is_closed,
              status_started_at: nowIso,
              status_started_at_ms: nowMs,
              status_duration_seconds: 0,
              status_duration_calculated_at: nowIso,
            };
          });

          const allClosed = updatedTeams.length > 0 && updatedTeams.every(t => Number(t.status_is_closed) === 1);
          const nextClosedAt = allClosed ? (inter.closed_at || nowIso) : null;

          return {
            ...inter,
            teams: updatedTeams,
            closed_at: nextClosedAt,
          };
        })
      );
    }

    setInterventionTeamStatusSaveState(prev => ({ ...prev, [statusKey]: 'saved' }));
    window.setTimeout(() => {
      setInterventionTeamStatusSaveState(prev => {
        if (prev[statusKey] !== 'saved') return prev;
        const next = { ...prev };
        delete next[statusKey];
        return next;
      });
    }, 1800);
    setStatusAidPostDrafts(prev => ({ ...prev, [statusKey]: '' }));
    void fetchData({ background: true });
  };

  const handleUnlinkTeamFromIntervention = async (interId: number, teamId: number, label = 'ontkoppelen') => {
    if (!hasRole(['ROOT', 'ADMIN', 'OPERATOR'])) return;
    const isOvtz = label.toUpperCase() === 'OVTZ';
    const res = await fetch(`/api/interventions/${interId}/teams/${teamId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status_id: getStartStatusId() || null,
        action: isOvtz ? 'ovtz' : 'unlink',
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || `Ploeg ${label} mislukt`);
      return;
    }
    setExpandedTeamStatusKey(null);
    void fetchData({ background: true });
    fetchLogs(true);
  };

  const handleUpdateStandaloneTeamStatus = async (teamId: number, statusId: number) => {
    if (!hasRole(['ROOT', 'ADMIN', 'OPERATOR'])) return;
    setTeamStatusSaveState(prev => ({ ...prev, [teamId]: 'saving' }));
    const res = await fetch(`/api/teams/${teamId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_id: statusId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setTeamStatusSaveState(prev => ({ ...prev, [teamId]: 'error' }));
      alert(data?.error || 'Ploegstatus wijzigen mislukt');
      return;
    }
    setTeamStatusDrafts(prev => ({ ...prev, [teamId]: String(statusId) }));
    setTeamStatusSaveState(prev => ({ ...prev, [teamId]: 'saved' }));
    window.setTimeout(() => {
      setTeamStatusSaveState(prev => {
        if (prev[teamId] !== 'saved') return prev;
        const next = { ...prev };
        delete next[teamId];
        return next;
      });
    }, 1800);
    void fetchData({ background: true });
    fetchLogs(true);
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
      body: JSON.stringify({
        ...newTeam,
        aid_post_id: newTeam.aid_post_id ? Number(newTeam.aid_post_id) : null,
      })
    });
    setShowNewTeam(false);
    setNewTeam({ name: '', type: teamTypes[0]?.name || '', aid_post_id: '' });
    void fetchData({ background: true });
  };

  const handleAddAidPost = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newAidPost.name.trim();
    if (!name) {
      alert('Naam hulppost is verplicht.');
      return;
    }

    const res = await fetch(`/api/events/${id}/aid-posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        location: newAidPost.location.trim(),
        description: newAidPost.description.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Hulppost aanmaken mislukt');
      return;
    }

    setShowNewAidPost(false);
    setNewAidPost({ name: '', location: '', description: '' });
    void fetchData({ background: true });
  };

  const handleStartEditAidPost = (aidPost: AidPost) => {
    setEditingAidPostId(aidPost.id);
    setEditingAidPostForm({
      name: aidPost.name || '',
      location: aidPost.location || '',
      description: aidPost.description || '',
    });
  };

  const handleSaveAidPost = async () => {
    if (!editingAidPostId) return;
    const name = editingAidPostForm.name.trim();
    if (!name) {
      alert('Naam hulppost is verplicht.');
      return;
    }

    const res = await fetch(`/api/aid-posts/${editingAidPostId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        location: editingAidPostForm.location.trim(),
        description: editingAidPostForm.description.trim(),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Hulppost opslaan mislukt');
      return;
    }

    setEditingAidPostId(null);
    setEditingAidPostForm({ name: '', location: '', description: '' });
    void fetchData({ background: true });
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
    void fetchData({ background: true });
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
    void fetchData({ background: true });
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

    void fetchData({ background: true });
  };

  const handleAddMember = async (teamId: number, name: string, role: string) => {
    await fetch(`/api/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role })
    });
    void fetchData({ background: true });
  };

  const handleSaveTeamName = async (teamId: number) => {
    const name = (teamNameDrafts[teamId] || '').trim();
    const type = (teamTypeDrafts[teamId] || '').trim();
    const aidPostId = teamAidPostDrafts[teamId] ? Number(teamAidPostDrafts[teamId]) : null;
    if (!name) {
      alert('Ploegnaam mag niet leeg zijn.');
      return;
    }
    if (!type) {
      alert('Ploegcategorie mag niet leeg zijn.');
      return;
    }

    const res = await fetch(`/api/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, aid_post_id: aidPostId }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Ploeg bijwerken mislukt');
      return;
    }
    setEditingTeamNameId(null);
    void fetchData({ background: true });
  };

  const handleToggleTeamDeployed = async (teamId: number, isDeployed: boolean) => {
    const res = await fetch(`/api/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_deployed: isDeployed }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Ploeg bijwerken mislukt');
      void fetchData({ background: true });
      return;
    }
    void fetchData({ background: true });
  };

  const handleRemoveMember = async (memberId: number) => {
    await fetch(`/api/members/${memberId}`, { method: 'DELETE' });
    void fetchData({ background: true });
  };

  const handleDeleteTeam = async (teamId: number, teamName: string) => {
    if (!hasRole(['ROOT', 'ADMIN'])) return;
    if (!confirm(`Weet je zeker dat je ploeg "${teamName}" wilt verwijderen?`)) return;

    const res = await fetch(`/api/teams/${teamId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Ploeg verwijderen mislukt');
      return;
    }
    void fetchData({ background: true });
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
    void fetchData({ background: true });
  };

  const handleAddStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch(`/api/events/${id}/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newStatus)
    });
    setNewStatus({ name: '', color: '#3b82f6', is_closed: false, is_start: false, is_busy: false });
    void fetchData({ background: true });
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

    for (const u of eventAssignableUsers) {
      if (u.role !== 'VIEWER') continue;
      if (!eventAssignedUserIds.includes(u.id)) continue;
      if (!eventAssignedAidPostIds[u.id]) {
        alert(`Viewer "${u.username}" moet aan een hulppost gekoppeld zijn.`);
        return;
      }
    }

    setSavingEventAssignments(true);
    try {
      const assignments = eventAssignedUserIds.map((userId) => ({
        user_id: userId,
        aid_post_id: eventAssignedAidPostIds[userId] ? Number(eventAssignedAidPostIds[userId]) : null,
      }));
      const res = await fetch(`/api/events/${id}/assignments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments }),
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
    void fetchData({ background: true });
  };

  const handleCloseEmptyIntervention = async (interventionId: number, title: string) => {
    if (!hasRole(['ROOT', 'ADMIN', 'OPERATOR'])) return;
    if (!confirm(`Interventie "${title}" sluiten? Dit kan alleen als er geen actieve ploeg meer gekoppeld is.`)) return;

    const res = await fetch(`/api/interventions/${interventionId}/close-empty`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || 'Interventie sluiten mislukt');
      return;
    }
    void fetchData({ background: true });
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
    void fetchData({ background: true });
  };

  const handleStartEditStatus = (status: Status) => {
    setEditingStatusId(status.id);
    setEditingStatus({
      name: status.name,
      color: status.color,
      is_closed: !!status.is_closed,
      is_start: !!status.is_start,
      is_busy: !!status.is_busy,
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
    void fetchData({ background: true });
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

    navigate(`/${languageCode}`);
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
      setEventFormDirty(false);
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
    setEventAnnouncementDirty(false);
    setShowEventAnnouncement(false);
    void fetchData({ background: true });
  };

  const dateLocale = languageCode === 'nl' ? nl : enUS;

  if (loading) return <div className="p-8 text-center">{t('common.loading')}</div>;
  if (!event) return <div className="p-8 text-center">{t('event.notFound')}</div>;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 overflow-x-hidden">
      <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="flex-1">
          <Link to={`/${languageCode}`} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1 mb-2">
            <ChevronRight className="rotate-180 w-4 h-4" /> {t('common.backToOverview')}
          </Link>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">{event.name}</h1>
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-slate-500 text-sm">
            <p className="flex items-center gap-2">
              <Clock className="w-4 h-4" /> 
              {format(new Date(event.date), 'PPP', { locale: dateLocale })}
              {event.end_date && event.end_date !== event.date && (
                <> - {format(new Date(event.end_date), 'PPP', { locale: dateLocale })}</>
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
        <div className="flex flex-wrap gap-2 w-full md:w-auto">
          <LanguageSelector />
          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
            <button
              onClick={() => setShowEventAnnouncement(true)}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium w-full sm:w-auto"
            >
              <Megaphone className="w-4 h-4" /> {t('event.announcement')}
            </button>
          )}
          {hasRole(['ROOT', 'ADMIN']) && (
            <button 
              onClick={() => handleExport('csv')}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium w-full sm:w-auto"
            >
              <Download className="w-4 h-4" /> {t('event.exportCsv')}
            </button>
          )}
          {hasRole(['ROOT', 'ADMIN']) && (
            <button 
              onClick={() => handleExport('excel')}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium w-full sm:w-auto"
            >
              <Download className="w-4 h-4" /> {t('event.exportExcel')}
            </button>
          )}
          {hasRole(['ROOT', 'ADMIN']) && (
            <button
              onClick={handleDeleteEvent}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium w-full sm:w-auto"
            >
              <Trash2 className="w-4 h-4" /> {t('event.deleteEvent')}
            </button>
          )}
          <button 
            onClick={logout}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium text-slate-600 w-full sm:w-auto"
          >
            <LogOut className="w-4 h-4" /> {t('common.logout')}
          </button>
        </div>
      </header>

      <nav className="flex border-b border-slate-200 mb-8 overflow-x-auto">
        {EVENT_TABS
          .filter(tab => {
            if (isViewer) return tab.id === 'team_status';
            return !tab.roles || hasRole(tab.roles);
          })
          .map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
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
                    {format(new Date(event.date), 'PPP', { locale: dateLocale })}
                    {event.end_date && event.end_date !== event.date && (
                      <> - {format(new Date(event.end_date), 'PPP', { locale: dateLocale })}</>
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
                <div className="text-sm text-slate-600 mb-4">
                  <span className="font-semibold text-slate-700">Omschrijving:</span>
                  <p className="mt-1 whitespace-pre-wrap break-words text-slate-800">
                    {(event.description || '').trim() || '-'}
                  </p>
                </div>
                {hasRole(['ROOT', 'ADMIN']) ? (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-700">Gegevens Bewerken</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Naam</label>
                        <input
                          type="text"
                          value={eventForm.name}
                          onChange={(e) => updateEventForm({ name: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Naam evenement"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Startdatum</label>
                        <input
                          type="date"
                          value={eventForm.date}
                          onChange={(e) => updateEventForm({ date: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Einddatum</label>
                        <input
                          type="date"
                          value={eventForm.end_date}
                          onChange={(e) => updateEventForm({ end_date: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Locatie</label>
                        <input
                          type="text"
                          value={eventForm.location}
                          onChange={(e) => updateEventForm({ location: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Locatie"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Organisator</label>
                        <input
                          type="text"
                          value={eventForm.organizer}
                          onChange={(e) => updateEventForm({ organizer: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Organisator"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Contactinformatie</label>
                        <input
                          type="text"
                          value={eventForm.contact_info}
                          onChange={(e) => updateEventForm({ contact_info: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="Contactinformatie"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Omschrijving</label>
                        <textarea
                          value={eventForm.description}
                          onChange={(e) => updateEventForm({ description: e.target.value })}
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
                ) : null}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'interventions' && !isViewer && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <h2 className="text-xl font-semibold">Interventies</h2>
              {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                <button
                  onClick={openNewInterventionModal}
                  className="text-white px-4 py-2 rounded-lg flex items-center justify-center gap-2 transition-colors text-sm font-medium w-full sm:w-auto"
                  style={{ backgroundColor: settings.primary_color }}
                >
                  <Plus className="w-4 h-4" /> Nieuwe interventie
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
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

              <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
                <button
                  onClick={() => setInterventionView('cards')}
                  className={`px-3 py-1.5 text-sm rounded-md ${interventionView === 'cards' ? 'text-white' : 'text-slate-600'}`}
                  style={interventionView === 'cards' ? { backgroundColor: settings.primary_color } : {}}
                >
                  Kaarten
                </button>
                <button
                  onClick={() => setInterventionView('list')}
                  className={`px-3 py-1.5 text-sm rounded-md ${interventionView === 'list' ? 'text-white' : 'text-slate-600'}`}
                  style={interventionView === 'list' ? { backgroundColor: settings.primary_color } : {}}
                >
                  Lijst
                </button>
              </div>
            </div>

            <div className={`grid gap-4 ${interventionView === 'cards' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
              <AnimatePresence>
                {interventions
                  .filter(i => interventionTab === 'open' ? !i.closed_at : !!i.closed_at)
                  .map((inter) => (
                    <motion.div
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      key={inter.id}
                      className={`rounded-xl border ${interventionView === 'list' ? 'p-4' : 'p-5'} ${inter.closed_at ? 'bg-slate-50 border-slate-200' : 'bg-white border-slate-200 shadow-sm'}`}
                    >
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2 mb-3">
                        <h3 className={`font-bold text-lg ${inter.closed_at ? 'text-slate-500 line-through' : 'text-slate-900'}`}>
                          #{inter.intervention_number ?? '-'} {inter.title}
                        </h3>
                        <div className="flex items-center gap-2">
                          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && !inter.closed_at && inter.teams.length === 0 && (
                            <button
                              onClick={() => handleCloseEmptyIntervention(inter.id, inter.title)}
                              className="text-slate-300 hover:text-emerald-600 transition-colors"
                              title="Interventie sluiten zonder ploegkoppeling"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                            </button>
                          )}
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
                        {(inter.description || '').trim() && (
                          <div className="flex items-start gap-2">
                            <FileText className="w-4 h-4 mt-0.5" />
                            <span className="whitespace-pre-wrap break-words">{inter.description}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" /> {formatTime(inter.created_at)}
                        </div>
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" /> Open duur: {formatDuration(getLiveOpenDuration(inter))}
                        </div>
                      </div>

                      {editingInterventionId === inter.id && interventionEdit && (
                        <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                          <div>
                            <label className="block text-xs font-semibold text-slate-600 mb-1">Titel</label>
                            <input
                              type="text"
                              required
                              value={interventionEdit.title}
                              onChange={(e) =>
                                setInterventionEdit(prev => prev ? { ...prev, title: e.target.value } : prev)
                              }
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                              placeholder="Titel interventie"
                            />
                          </div>
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
                            <div className="grid grid-cols-1 gap-3">
                              <div>
                                <label className="block text-xs font-semibold text-slate-600 mb-1">
                                  Initiële status voor nieuwe ploegen
                                </label>
                                <select
                                  value={interventionEdit.addTeamStatusId}
                                  onChange={(e) =>
                                    setInterventionEdit(prev => prev ? { ...prev, addTeamStatusId: Number(e.target.value) } : prev)
                                  }
                                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                >
                                  {statuses.map(s => (
                                    <option key={s.id} value={s.id}>
                                      {s.name}
                                      {s.is_busy ? ' (bezig)' : s.is_start ? ' (begin)' : s.is_closed ? ' (eind)' : ''}
                                    </option>
                                  ))}
                                </select>
                                {interventionEdit.addTeamIds.length > 0 && (
                                  <p className="mt-1 text-xs text-slate-500">
                                    Deze status wordt toegepast bij opslaan op de ploegen die hieronder klaarstaan.
                                  </p>
                                )}
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-slate-600 mb-1">Ploeg toevoegen</label>
                                <select
                                  value={interventionEdit.selectedAddTeamId}
                                  onChange={(e) => {
                                    const teamId = Number(e.target.value);
                                    setInterventionEdit(prev => {
                                      if (!prev) return prev;
                                      if (!teamId) return { ...prev, selectedAddTeamId: '' };
                                      return {
                                        ...prev,
                                        addTeamIds: prev.addTeamIds.includes(teamId)
                                          ? prev.addTeamIds
                                          : [...prev.addTeamIds, teamId],
                                        selectedAddTeamId: '',
                                      };
                                    });
                                  }}
                                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                                >
                                  <option value="">Kies ploeg om klaar te zetten...</option>
                                  {teams
                                    .filter(t => {
                                      const currentlyLinked = inter.teams.some(it => it.id === t.id);
                                      const pendingAdded = interventionEdit.addTeamIds.includes(t.id);
                                      const isDeployed = Number(t.is_deployed) === 1;
                                      return (!currentlyLinked && !pendingAdded)
                                        && canTeamBeAddedToIntervention(t.id, inter.id)
                                        && isDeployed;
                                    })
                                    .map(t => (
                                      <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                                {interventionEdit.addTeamIds.length > 0 && (
                                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                                    <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700 mb-2">
                                      Klaar om te koppelen bij opslaan
                                    </p>
                                    <div className="space-y-2">
                                    {interventionEdit.addTeamIds.map(teamId => {
                                      const pendingTeam = teams.find(t => t.id === teamId);
                                      if (!pendingTeam) return null;
                                      return (
                                        <div
                                          key={teamId}
                                          className="flex items-center justify-between gap-3 rounded-md bg-white border border-emerald-100 px-3 py-2 text-sm text-emerald-900"
                                        >
                                          <span className="font-medium">{pendingTeam.name}</span>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setInterventionEdit(prev => prev
                                                ? { ...prev, addTeamIds: prev.addTeamIds.filter(id => id !== teamId) }
                                                : prev
                                              )
                                            }
                                            className="text-emerald-500 hover:text-emerald-700"
                                            title="Nog niet opgeslagen ploeg verwijderen"
                                          >
                                            <X className="w-4 h-4" />
                                          </button>
                                        </div>
                                      );
                                    })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="flex flex-col-reverse sm:flex-row gap-2 justify-end">
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
                              {interventionEdit.addTeamIds.length > 0 ? 'Opslaan en koppelen' : 'Opslaan'}
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="space-y-4">
                        {(() => {
                          const visibleTeams = inter.teams;

                          if (visibleTeams.length === 0) {
                            return (
                              <div className="text-xs text-slate-400 italic pt-2 border-t border-slate-100">
                                Geen zichtbare ploegen gekoppeld
                              </div>
                            );
                          }

                          return visibleTeams.map(team => {
                            const statusKey = getTeamStatusEditorKey(inter.id, team.id);
                            const isExpanded = expandedTeamStatusKey === statusKey;
                            const teamTimeline = (inter.team_history || [])
                              .filter(entry => Number(entry.team_id) === Number(team.id));

                            return (
                              <div key={team.id} className="pt-3 border-t border-slate-100">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedTeamStatusKey(prev => prev === statusKey ? null : statusKey)
                                  }
                                  className="w-full flex justify-between items-center mb-2 text-left"
                                >
                                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{team.name}</span>
                                  <div
                                    className="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
                                    style={{ backgroundColor: team.status_color }}
                                  >
                                    {team.status_name}
                                  </div>
                                </button>
                                {!inter.closed_at && (
                                  <div className="text-[11px] text-slate-500 mb-2 space-y-0.5">
                                    <div>Start status: {formatTimestampWithoutTimezone(team.status_started_at, team.status_started_at_ms)}</div>
                                    <div>
                                      Duur huidige status: {formatDuration(
                                        getLiveStatusDuration(
                                          team.status_started_at,
                                          team.status_duration_seconds,
                                          Boolean(inter.closed_at),
                                          team.status_duration_calculated_at
                                        )
                                      )}
                                    </div>
                                  </div>
                                )}
                                <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
                                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                                    Tijdlijn
                                  </p>
                                  <div className="space-y-2 max-h-40 overflow-y-auto">
                                    {teamTimeline.map(entry => {
                                      const seconds = entry.duration_seconds != null
                                        ? getLiveStatusDuration(
                                            entry.started_at,
                                            entry.duration_seconds,
                                            Boolean(entry.ended_at),
                                            entry.duration_calculated_at
                                          )
                                        : getLiveStatusDuration(entry.started_at, null, Boolean(entry.ended_at));
                                      return (
                                        <div key={entry.id} className="text-xs text-slate-700 rounded bg-white border border-slate-100 p-2">
                                          <div className="flex flex-wrap items-center gap-2 mb-1">
                                            <span
                                              className="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
                                              style={{ backgroundColor: entry.status_color || '#64748b' }}
                                            >
                                              {entry.status_name || 'Geen status'}
                                            </span>
                                            <span className="text-[10px] text-slate-400">
                                              {formatDuration(seconds)}
                                            </span>
                                          </div>
                                          <div className="text-[11px] text-slate-500">
                                            {formatTimestampWithoutTimezone(entry.started_at, entry.started_at_ms)}
                                            {' tot '}
                                            {entry.ended_at ? formatTimestampWithoutTimezone(entry.ended_at, entry.ended_at_ms) : 'heden'}
                                          </div>
                                        </div>
                                      );
                                    })}
                                    {teamTimeline.length === 0 && (
                                      <div className="text-xs text-slate-400 italic">Nog geen statusgeschiedenis.</div>
                                    )}
                                  </div>
                                </div>
                                {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && !inter.closed_at && (
                                  <>
                                    {!isExpanded && (
                                      <button
                                        type="button"
                                        onClick={() => setExpandedTeamStatusKey(statusKey)}
                                        className="text-xs px-2 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                                      >
                                        Wijzig status
                                      </button>
                                    )}
                                    {isExpanded && (
                                      <div className="space-y-2">
                                        <div>
                                          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                            Nieuwe status
                                          </label>
                                          <select
                                            value={team.status_id || ''}
                                            disabled={interventionTeamStatusSaveState[statusKey] === 'saving'}
                                            onChange={(e) => {
                                              const nextStatusId = Number(e.target.value);
                                              if (nextStatusId && nextStatusId !== Number(team.status_id)) {
                                                void handleUpdateTeamStatus(inter.id, team.id, nextStatusId);
                                              }
                                            }}
                                            className="w-full px-2 py-1.5 rounded border border-slate-200 text-xs bg-white"
                                          >
                                            {statuses.map(s => (
                                              <option key={s.id} value={s.id}>
                                                {s.name}
                                                {s.is_start ? ' (ontkoppelt)' : s.is_closed ? ' (sluitend)' : ''}
                                              </option>
                                            ))}
                                          </select>
                                          {interventionTeamStatusSaveState[statusKey] === 'saving' && (
                                            <p className="mt-1 text-xs text-slate-500">Status opslaan...</p>
                                          )}
                                          {interventionTeamStatusSaveState[statusKey] === 'saved' && (
                                            <p className="mt-1 text-xs text-emerald-600">Status opgeslagen</p>
                                          )}
                                          {interventionTeamStatusSaveState[statusKey] === 'error' && (
                                            <p className="mt-1 text-xs text-red-600">Status opslaan mislukt</p>
                                          )}
                                          <button
                                            type="button"
                                            disabled={interventionTeamStatusSaveState[statusKey] === 'saving' || !team.status_id}
                                            onClick={() => {
                                              if (team.status_id) void handleUpdateTeamStatus(inter.id, team.id, Number(team.status_id));
                                            }}
                                            className="mt-2 w-full px-2 py-1.5 rounded border border-slate-200 text-xs text-slate-600 hover:bg-white disabled:opacity-50"
                                          >
                                            Herstart huidige status
                                          </button>
                                        </div>
                                        <div>
                                          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                            Bestemmingshulppost bij afvoer
                                          </label>
                                          <select
                                            value={statusAidPostDrafts[statusKey] || ''}
                                            onChange={(e) =>
                                              setStatusAidPostDrafts(prev => ({ ...prev, [statusKey]: e.target.value }))
                                            }
                                            className="w-full px-2 py-1.5 rounded border border-slate-200 text-xs"
                                          >
                                            <option value="">Geen wijziging</option>
                                            {aidPosts.map(post => (
                                              <option key={post.id} value={post.id}>{post.name}</option>
                                            ))}
                                          </select>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <button
                                            type="button"
                                            onClick={() => handleUnlinkTeamFromIntervention(inter.id, team.id)}
                                            className="text-xs px-2 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                                          >
                                            Ontkoppelen
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleUnlinkTeamFromIntervention(inter.id, team.id, 'OVTZ')}
                                            className="text-xs px-2 py-1 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                                            title="Ontkoppelen en radiografisch beschikbaar zetten"
                                          >
                                            OVTZ
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setExpandedTeamStatusKey(null)}
                                            className="text-xs text-slate-500 hover:text-slate-700"
                                          >
                                            Sluiten
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            );
                          });
                        })()}
                      </div>

                      {inter.closed_at && (inter.status_durations?.length || 0) > 0 && (
                        <div className="mt-4 pt-3 border-t border-slate-100">
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                            Duur per status
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

                      {inter.closed_at && (inter.team_history?.length || 0) > 0 && (
                        <div className="mt-4 pt-3 border-t border-slate-100">
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                            Ploeggeschiedenis
                          </p>
                          <div className="space-y-2 max-h-56 overflow-y-auto">
                            {inter.team_history?.map((entry) => (
                              <div key={entry.id} className="rounded-lg bg-white border border-slate-100 p-2 text-xs text-slate-600">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-slate-800">{entry.team_name}</span>
                                  <span
                                    className="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
                                    style={{ backgroundColor: entry.status_color || '#64748b' }}
                                  >
                                    {entry.status_name || 'Geen status'}
                                  </span>
                                </div>
                                <div className="mt-1">
                                  {formatDateTime(entry.started_at)}
                                  {' tot '}
                                  {entry.ended_at ? formatDateTime(entry.ended_at) : 'heden'}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mt-4 pt-3 border-t border-slate-100 space-y-2">
                        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Meldingen</p>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void handleAddInterventionMessage(inter.id);
                          }}
                          className="flex flex-col sm:flex-row gap-2"
                        >
                          <input
                            type="text"
                            value={newMessageByIntervention[inter.id] || ''}
                            onChange={(e) => setNewMessageByIntervention(prev => ({ ...prev, [inter.id]: e.target.value }))}
                            placeholder="Nieuw bericht..."
                            className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          />
                          <button
                            type="submit"
                            className="px-3 py-2 rounded-lg text-white text-sm w-full sm:w-auto flex items-center justify-center"
                            style={{ backgroundColor: settings.primary_color }}
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        </form>
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                          {(messagesByIntervention[inter.id] || []).map(msg => (
                            <div key={msg.id} className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                              <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                                <span>{msg.actor_username || 'Systeem'}</span>
                                <span>{formatDateTime(msg.created_at)}</span>
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
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <h2 className="text-xl font-semibold">Ploegen</h2>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                  <button
                    onClick={() => setShowNewAidPost(true)}
                    className="px-4 py-2 rounded-lg flex items-center justify-center gap-2 transition-colors text-sm font-medium w-full sm:w-auto border border-slate-300 text-slate-700 hover:bg-slate-50"
                  >
                    <Building2 className="w-4 h-4" /> Nieuwe Hulppost
                  </button>
                )}
                {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                  <button
                    onClick={() => setShowNewTeam(true)}
                    className="text-white px-4 py-2 rounded-lg flex items-center justify-center gap-2 transition-colors text-sm font-medium w-full sm:w-auto"
                    style={{ backgroundColor: settings.primary_color }}
                  >
                    <Plus className="w-4 h-4" /> Nieuwe Ploeg
                  </button>
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-900">Hulpposten</h3>
              </div>
              {aidPosts.length === 0 && (
                <p className="text-sm text-slate-500">Nog geen hulpposten voor dit evenement.</p>
              )}
              {aidPosts.map((aidPost) => (
                <div key={aidPost.id} className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                  {editingAidPostId === aidPost.id ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={editingAidPostForm.name}
                        onChange={(e) => setEditingAidPostForm(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="Naam hulppost"
                        className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
                      />
                      <input
                        type="text"
                        value={editingAidPostForm.location}
                        onChange={(e) => setEditingAidPostForm(prev => ({ ...prev, location: e.target.value }))}
                        placeholder="Locatie"
                        className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
                      />
                      <textarea
                        value={editingAidPostForm.description}
                        onChange={(e) => setEditingAidPostForm(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="Omschrijving"
                        className="w-full px-3 py-2 rounded border border-slate-200 text-sm h-20"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleSaveAidPost}
                          className="px-3 py-1.5 rounded text-white text-xs"
                          style={{ backgroundColor: settings.primary_color }}
                        >
                          Opslaan
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingAidPostId(null);
                            setEditingAidPostForm({ name: '', location: '', description: '' });
                          }}
                          className="px-3 py-1.5 rounded border border-slate-300 text-xs text-slate-600"
                        >
                          Annuleren
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-900">{aidPost.name}</p>
                        <p className="text-xs text-slate-500">{aidPost.location || '-'}</p>
                        <p className="text-xs text-slate-500">{aidPost.description || '-'}</p>
                      </div>
                      {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                        <button
                          type="button"
                          onClick={() => handleStartEditAidPost(aidPost)}
                          className="text-slate-400 hover:text-blue-600 transition-colors"
                          title="Hulppost bewerken"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {teams.map((team) => (
                <div key={team.id} className={`bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden ${Number(team.is_deployed) !== 1 ? 'opacity-70' : ''}`}>
                  <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-slate-900">{team.name}</h3>
                      <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">{team.type}</span>
                      <p className="text-xs text-slate-500 mt-1">Hulppost: {team.aid_post_name || 'Geen hulppost'}</p>
                      {Number(team.is_deployed) !== 1 && (
                        <span className="ml-2 text-[10px] uppercase font-bold text-red-600 tracking-widest">Niet ingezet</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                        <button
                          type="button"
                          onClick={() => setEditingTeamNameId(team.id)}
                          className="text-slate-300 hover:text-blue-600 transition-colors"
                          title="Ploegnaam bewerken"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      {hasRole(['ROOT', 'ADMIN']) && (
                        <button
                          type="button"
                          onClick={() => handleDeleteTeam(team.id, team.name)}
                          className="text-slate-300 hover:text-red-600 transition-colors"
                          title="Ploeg verwijderen"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                      <Users className="w-5 h-5 text-slate-400" />
                    </div>
                  </div>
                  <div className="p-4 space-y-3">
                    {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                      <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-2">
                        <label className="flex items-center gap-2 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={!(teamDeployedDrafts[team.id] ?? (Number(team.is_deployed) === 1))}
                            onChange={async (e) => {
                              const nextDeployed = !e.target.checked;
                              setTeamDeployedDrafts(prev => ({ ...prev, [team.id]: nextDeployed }));
                              await handleToggleTeamDeployed(team.id, nextDeployed);
                            }}
                          />
                          Niet ingezet
                        </label>
                        {editingTeamNameId === team.id && (
                          <div className="space-y-2">
                            <label className="block text-xs font-semibold text-slate-600">Naam ploeg</label>
                            <input
                              type="text"
                              value={teamNameDrafts[team.id] ?? team.name}
                              onChange={(e) => setTeamNameDrafts(prev => ({ ...prev, [team.id]: e.target.value }))}
                              className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
                            />
                            <label className="block text-xs font-semibold text-slate-600">Categorie</label>
                            <select
                              value={teamTypeDrafts[team.id] ?? team.type}
                              onChange={(e) => setTeamTypeDrafts(prev => ({ ...prev, [team.id]: e.target.value }))}
                              className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
                            >
                              {teamTypes.map(type => (
                                <option key={type.id} value={type.name}>{type.name}</option>
                              ))}
                            </select>
                            <label className="block text-xs font-semibold text-slate-600">Hulppost</label>
                            <select
                              value={teamAidPostDrafts[team.id] ?? (team.aid_post_id ? String(team.aid_post_id) : '')}
                              onChange={(e) => setTeamAidPostDrafts(prev => ({ ...prev, [team.id]: e.target.value }))}
                              className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
                            >
                              <option value="">Geen hulppost</option>
                              {aidPosts.map(post => (
                                <option key={post.id} value={post.id}>{post.name}</option>
                              ))}
                            </select>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleSaveTeamName(team.id)}
                                className="flex-1 py-2 rounded-lg text-white text-xs font-medium"
                                style={{ backgroundColor: settings.primary_color }}
                              >
                                Naam opslaan
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setTeamNameDrafts(prev => ({ ...prev, [team.id]: team.name }));
                                  setTeamTypeDrafts(prev => ({ ...prev, [team.id]: team.type }));
                                  setTeamAidPostDrafts(prev => ({ ...prev, [team.id]: team.aid_post_id ? String(team.aid_post_id) : '' }));
                                  setEditingTeamNameId(null);
                                }}
                                className="px-3 py-2 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-white"
                              >
                                Annuleren
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="space-y-2">
                      {team.members.map(member => (
                        <div key={member.id} className="flex justify-between items-center text-sm p-2 bg-slate-50 rounded-lg group gap-2">
                          <div>
                            <span className="font-medium break-words">{member.name}</span>
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
              {teams.filter(team => Number(team.is_deployed) === 1).map((team) => {
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
                      <div className="space-y-3">
                        <div className="text-sm text-slate-500">
                          Geen actieve interventies.
                        </div>
                        <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                              Radiostatus
                            </span>
                            <span
                              className="px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase"
                              style={{ backgroundColor: team.current_status_color || '#64748b' }}
                            >
                              {team.current_status_name || 'Geen status'}
                            </span>
                          </div>
                          {team.current_status_updated_at && (
                            <div className="text-xs text-slate-500 mb-2 space-y-0.5">
                              <div>Start status: {formatTimestampWithoutTimezone(team.current_status_updated_at, team.current_status_updated_at_ms)}</div>
                              <div>
                                Duur huidige status: {formatDuration(
                                  getLiveStatusDuration(
                                    team.current_status_updated_at,
                                    team.current_status_duration_seconds,
                                    false,
                                    team.current_status_duration_calculated_at
                                  )
                                )}
                              </div>
                            </div>
                          )}
                          {hasRole(['ROOT', 'ADMIN', 'OPERATOR']) && (
                            <div className="space-y-2 min-w-0">
                              <select
                                value={teamStatusDrafts[team.id] || ''}
                                onChange={(e) => {
                                  const nextValue = e.target.value;
                                  setTeamStatusDrafts(prev => ({ ...prev, [team.id]: nextValue }));
                                  const nextStatusId = Number(nextValue);
                                  if (nextStatusId) void handleUpdateStandaloneTeamStatus(team.id, nextStatusId);
                                }}
                                disabled={teamStatusSaveState[team.id] === 'saving'}
                                className="w-full min-w-0 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                              >
                                <option value="">Kies status...</option>
                                {statuses.map(status => (
                                  <option key={status.id} value={status.id}>
                                    {status.name}
                                    {status.is_start ? ' (radiografisch beschikbaar)' : ''}
                                  </option>
                                ))}
                              </select>
                              {teamStatusSaveState[team.id] === 'saving' && (
                                <p className="text-xs text-slate-500">Opslaan...</p>
                              )}
                              {teamStatusSaveState[team.id] === 'saved' && (
                                <p className="text-xs text-emerald-600">Status opgeslagen</p>
                              )}
                              {teamStatusSaveState[team.id] === 'error' && (
                                <p className="text-xs text-red-600">Status opslaan mislukt</p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
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
                            <div className="text-xs text-slate-500 mt-1 space-y-0.5">
                              <div>Start status: {formatTimestampWithoutTimezone(assignment.status_started_at, assignment.status_started_at_ms)}</div>
                              <div>
                                Duur huidige status: {formatDuration(
                                  getLiveStatusDuration(
                                    assignment.status_started_at,
                                    assignment.status_duration_seconds,
                                    Boolean(intervention.closed_at),
                                    assignment.status_duration_calculated_at
                                  )
                                )}
                              </div>
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
                      <option key={inter.id} value={inter.id}>
                        #{inter.intervention_number ?? '-'} {inter.title}
                      </option>
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
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={newLog}
                    onChange={(e) => setNewLog(e.target.value)}
                    placeholder="Nieuwe opmerking..."
                    className="flex-1 px-4 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button 
                    className="text-white px-4 py-2 rounded-lg transition-colors w-full sm:w-auto flex items-center justify-center"
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
                  <option key={inter.id} value={inter.id}>
                    #{inter.intervention_number ?? '-'} {inter.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-4">
              {logs.map((log) => {
                const teamName = log.team_id ? teams.find(t => t.id === log.team_id)?.name : null;
                const logIntervention = log.intervention_id
                  ? interventions.find(i => i.id === log.intervention_id)
                  : null;
                const interventionTitle = logIntervention
                  ? `#${logIntervention.intervention_number ?? '-'} ${logIntervention.title}`
                  : null;
                return (
                  <div key={log.id} className="p-4 bg-white rounded-xl border border-slate-100 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                      <span className="font-mono text-slate-400">
                        {formatDateTime(log.created_at)}
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
          <div className="max-w-4xl mx-auto space-y-6">
            <nav className="bg-white rounded-2xl border border-slate-200 p-2 flex flex-col sm:flex-row gap-2">
              <button
                onClick={() => setSettingsSubTab('access')}
                className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  settingsSubTab === 'access' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Event Toegang
              </button>
              <button
                onClick={() => setSettingsSubTab('team_types')}
                className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  settingsSubTab === 'team_types' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Teamsoorten
              </button>
              <button
                onClick={() => setSettingsSubTab('statuses')}
                className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  settingsSubTab === 'statuses' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Statussen
              </button>
            </nav>

            {settingsSubTab === 'access' && (
              <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 md:p-6">
                <h3 className="text-lg font-semibold mb-4">Event Toegang (Operator/Viewer)</h3>
                <details open className="border border-slate-200 rounded-xl overflow-hidden mb-4">
                  <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Gekoppelde gebruikers</summary>
                  <div className="p-4 space-y-2">
                    {eventAssignableUsers
                      .filter(u => eventAssignedUserIds.includes(u.id))
                      .map(u => (
                        <div key={`assigned-${u.id}`} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 bg-white rounded-lg border border-slate-200">
                          <div>
                            <span className="font-medium text-slate-800">{u.username}</span>
                            <span className="ml-2 text-xs uppercase text-slate-400 font-bold">{u.role}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              value={eventAssignedAidPostIds[u.id] || ''}
                              onChange={(e) => setEventAssignedAidPostIds(prev => ({ ...prev, [u.id]: e.target.value }))}
                              className="px-2 py-1.5 rounded border border-slate-200 text-xs"
                            >
                              <option value="">{u.role === 'VIEWER' ? 'Kies hulppost *' : 'Geen hulppost'}</option>
                              {aidPosts.map(post => (
                                <option key={post.id} value={post.id}>{post.name}</option>
                              ))}
                            </select>
                            {u.role === 'VIEWER' && !eventAssignedAidPostIds[u.id] && (
                              <span className="text-[10px] font-semibold text-red-600">Verplicht</span>
                            )}
                          </div>
                          <div>
                            <button
                              type="button"
                              onClick={() => {
                                setEventAssignedUserIds(prev => prev.filter(id => id !== u.id));
                                setEventAssignedAidPostIds(prev => ({ ...prev, [u.id]: '' }));
                              }}
                              className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                            >
                              Verwijderen
                            </button>
                          </div>
                        </div>
                      ))}
                    {eventAssignableUsers.filter(u => eventAssignedUserIds.includes(u.id)).length === 0 && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 text-sm text-slate-500">
                        Nog geen gebruikers gekoppeld aan dit evenement.
                      </div>
                    )}
                  </div>
                </details>

                <details open className="border border-slate-200 rounded-xl overflow-hidden">
                  <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Beschikbare operatoren/viewers</summary>
                  <div className="p-4 space-y-2">
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
                            setEventAssignedUserIds(prev => {
                              if (e.target.checked) {
                                if (prev.includes(u.id)) return prev;
                                if (u.role === 'VIEWER') {
                                  setEventAssignedAidPostIds(current => ({
                                    ...current,
                                    [u.id]: current[u.id] || (aidPosts[0] ? String(aidPosts[0].id) : ''),
                                  }));
                                }
                                return [...prev, u.id];
                              }
                              setEventAssignedAidPostIds(current => ({ ...current, [u.id]: '' }));
                              return prev.filter(id => id !== u.id);
                            });
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
                </details>

                <div className="mt-4">
                  <button
                    onClick={handleSaveEventAssignments}
                    disabled={savingEventAssignments}
                    className="w-full bg-slate-900 text-white py-2 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-60"
                  >
                    {savingEventAssignments ? 'Opslaan...' : 'Toegang opslaan'}
                  </button>
                </div>
              </section>
            )}

            {settingsSubTab === 'team_types' && (
              <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 md:p-6">
                <h3 className="text-lg font-semibold mb-4">Teamsoorten beheren</h3>
                <details open className="border border-slate-200 rounded-xl overflow-hidden mb-4">
                  <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Bestaande teamsoorten</summary>
                  <div className="p-4 space-y-2">
                    {teamTypes.map(t => (
                      <div key={t.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 bg-white rounded-lg border border-slate-200">
                        {editingTeamTypeId === t.id ? (
                          <>
                            <input
                              type="text"
                              value={editingTeamTypeName}
                              onChange={e => setEditingTeamTypeName(e.target.value)}
                              className="flex-1 px-3 py-2 rounded border border-slate-200 text-sm"
                            />
                            <div className="flex items-center gap-2">
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
                            <div className="flex items-center gap-2">
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
                </details>

                <details open className="border border-slate-200 rounded-xl overflow-hidden">
                  <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Nieuwe teamsoort</summary>
                  <div className="p-4">
                    <form onSubmit={handleAddTeamType} className="p-4 bg-slate-100 rounded-xl space-y-4">
                      <h4 className="text-sm font-bold text-slate-600 uppercase">Nieuwe teamsoort</h4>
                      <input
                        type="text"
                        placeholder="Bijv. Verkeer"
                        value={newTeamTypeName}
                        onChange={e => setNewTeamTypeName(e.target.value)}
                        className="w-full px-3 py-2 rounded border border-slate-200 text-sm"
                        required
                      />
                      <button className="w-full bg-slate-800 text-white py-2 rounded-lg text-sm font-medium hover:bg-slate-900 transition-colors">
                        Teamsoort toevoegen
                      </button>
                    </form>
                  </div>
                </details>
              </section>
            )}

            {settingsSubTab === 'statuses' && (
              <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 md:p-6">
                <h3 className="text-lg font-semibold mb-4">Statussen beheren</h3>
                <details open className="border border-slate-200 rounded-xl overflow-hidden mb-4">
                  <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Bestaande statussen</summary>
                  <div className="p-4 space-y-3">
                    {statuses.map(s => (
                      <div key={s.id} className="flex flex-col gap-3 p-3 bg-white rounded-lg border border-slate-200">
                        {editingStatusId === s.id ? (
                          <>
                            <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
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
                              <label className="text-xs text-slate-600 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={editingStatus.is_closed}
                                  onChange={e => setEditingStatus(prev => ({ ...prev, is_closed: e.target.checked }))}
                                />
                                Sluit interventie
                              </label>
                              <label className="text-xs text-slate-600 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={editingStatus.is_start}
                                  onChange={e =>
                                    setEditingStatus(prev => ({
                                      ...prev,
                                      is_start: e.target.checked,
                                      is_busy: e.target.checked ? false : prev.is_busy,
                                    }))
                                  }
                                />
                                Beginstatus
                              </label>
                              <label className="text-xs text-slate-600 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={editingStatus.is_busy}
                                  onChange={e =>
                                    setEditingStatus(prev => ({
                                      ...prev,
                                      is_busy: e.target.checked,
                                      is_start: e.target.checked ? false : prev.is_start,
                                    }))
                                  }
                                />
                                Bezigstatus
                              </label>
                            </div>
                            <div className="flex items-center gap-2 sm:self-end">
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
                            <div className="flex items-center gap-3 flex-wrap">
                              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: s.color }} />
                              <span className="font-medium">{s.name}</span>
                              {s.is_start ? (
                                <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Begin</span>
                              ) : null}
                              {s.is_busy ? (
                                <span className="text-[10px] font-bold text-amber-600 uppercase tracking-widest">Bezig</span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-3 flex-wrap">
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
                </details>

                <details open className="border border-slate-200 rounded-xl overflow-hidden">
                  <summary className="cursor-pointer px-4 py-3 bg-slate-50 font-semibold text-slate-800">Nieuwe status</summary>
                  <div className="p-4">
                    <form onSubmit={handleAddStatus} className="p-4 bg-slate-100 rounded-xl space-y-4">
                      <h4 className="text-sm font-bold text-slate-600 uppercase">Nieuwe status</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                      <label className="flex items-center gap-2 text-sm text-slate-600">
                        <input
                          type="checkbox"
                          checked={newStatus.is_start}
                          onChange={e =>
                            setNewStatus(prev => ({
                              ...prev,
                              is_start: e.target.checked,
                              is_busy: e.target.checked ? false : prev.is_busy,
                            }))
                          }
                        />
                        Markeer als 'Begin' status
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-600">
                        <input
                          type="checkbox"
                          checked={newStatus.is_busy}
                          onChange={e =>
                            setNewStatus(prev => ({
                              ...prev,
                              is_busy: e.target.checked,
                              is_start: e.target.checked ? false : prev.is_start,
                            }))
                          }
                        />
                        Markeer als 'Bezig' status
                      </label>
                      <button className="w-full bg-slate-800 text-white py-2 rounded-lg text-sm font-medium hover:bg-slate-900 transition-colors">
                        Status toevoegen
                      </button>
                    </form>
                  </div>
                </details>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Modals */}
      {showNewIntervention && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <h2 className="text-2xl font-bold mb-6">Nieuwe interventie</h2>
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
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.is_busy ? ' (bezig)' : s.is_start ? ' (begin)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Ploegen koppelen</label>
                <div className="grid grid-cols-2 gap-2 max-h-32 overflow-y-auto p-2 border border-slate-100 rounded-lg">
                  {teams.filter(team => Number(team.is_deployed) === 1).map(team => (
                    <label key={team.id} className={`flex items-center gap-2 text-xs ${!canTeamBeAddedToIntervention(team.id, 0) ? 'opacity-50' : ''}`}>
                      <input
                        type="checkbox"
                        disabled={!canTeamBeAddedToIntervention(team.id, 0)}
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
                      {!canTeamBeAddedToIntervention(team.id, 0) ? ' (niet in begin/gesloten status)' : ''}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 mt-8">
                <button 
                  type="button"
                  onClick={cancelNewInterventionModal}
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
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <Megaphone className="text-red-600" /> Eventmelding
            </h2>
            <form onSubmit={handleUpdateEventAnnouncement} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Bericht</label>
                <textarea
                  required
                  value={eventAnnouncement.message}
                  onChange={e => updateEventAnnouncement({ message: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-red-500 outline-none transition-all h-28"
                  placeholder="Typ hier de event melding..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Achtergrondkleur</label>
                <div className="flex gap-2 flex-wrap">
                  {['#ef4444', '#f97316', '#eab308', '#3b82f6', '#1e293b'].map(color => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => updateEventAnnouncement({ bg_color: color })}
                      className={`w-10 h-10 rounded-full border-2 ${eventAnnouncement.bg_color === color ? 'border-slate-900 ring-2 ring-slate-200' : 'border-transparent'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <input
                    type="color"
                    value={eventAnnouncement.bg_color}
                    onChange={e => updateEventAnnouncement({ bg_color: e.target.value })}
                    className="w-10 h-10 rounded-full border-none p-0 overflow-hidden cursor-pointer"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eventAnnouncement.is_active}
                  onChange={e => updateEventAnnouncement({ is_active: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                Toon eventbanner aan iedereen in dit evenement
              </label>
              <div className="flex flex-col sm:flex-row gap-3 mt-8">
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

      {showNewAidPost && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
          >
            <h2 className="text-2xl font-bold mb-6">Nieuwe Hulppost</h2>
            <form onSubmit={handleAddAidPost} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Naam</label>
                <input
                  autoFocus
                  type="text"
                  required
                  value={newAidPost.name}
                  onChange={e => setNewAidPost(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Bijv. Hulppost Noord"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Locatie</label>
                <input
                  type="text"
                  value={newAidPost.location}
                  onChange={e => setNewAidPost(prev => ({ ...prev, location: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Bijv. Ingang A"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Omschrijving</label>
                <textarea
                  value={newAidPost.description}
                  onChange={e => setNewAidPost(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none h-24"
                  placeholder="Extra info over deze hulppost"
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setShowNewAidPost(false)}
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

      {showNewTeam && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
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
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Hulppost</label>
                <select
                  value={newTeam.aid_post_id}
                  onChange={e => setNewTeam(prev => ({ ...prev, aid_post_id: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="">Geen hulppost</option>
                  {aidPosts.map(post => (
                    <option key={post.id} value={post.id}>{post.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 mt-8">
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
