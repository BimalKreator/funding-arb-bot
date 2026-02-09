import { useEffect, useState, useCallback, useRef } from 'react';
import { Bell } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../api';

const POLL_MS = 5000;
const TOAST_DURATION_MS = 4000;

export type NotificationType = 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';

export interface NotificationItem {
  id: string;
  timestamp: string;
  type: NotificationType;
  title: string;
  message: string;
  details?: string | Record<string, unknown>;
}

function typeColor(type: NotificationType): string {
  switch (type) {
    case 'SUCCESS':
      return 'text-[#22c55e] border-[#22c55e]/50 bg-[#22c55e]/10';
    case 'WARNING':
      return 'text-[#eab308] border-[#eab308]/50 bg-[#eab308]/10';
    case 'ERROR':
      return 'text-[#ef4444] border-[#ef4444]/50 bg-[#ef4444]/10';
    default:
      return 'text-zinc-400 border-white/20 bg-white/5';
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function detailsString(details: string | Record<string, unknown> | undefined): string {
  if (details == null) return '';
  if (typeof details === 'string') return details;
  return JSON.stringify(details, null, 2);
}

export function NotificationCenter() {
  const [list, setList] = useState<NotificationItem[]>([]);
  const [lastSeenId, setLastSeenId] = useState<string | null>(null);
  const [lastReadId, setLastReadId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<NotificationItem | null>(null);
  const [selectedDetails, setSelectedDetails] = useState<NotificationItem | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/notifications`);
      if (!res.ok) return;
      const json: NotificationItem[] = await res.json();
      setList(json);
      const newest = json[0];
      if (newest && newest.id !== lastSeenId) {
        setToast(newest);
        setLastSeenId(newest.id);
      }
    } catch (_) {
      // ignore
    }
  }, [lastSeenId]);

  useEffect(() => {
    fetchNotifications();
    const id = setInterval(fetchNotifications, POLL_MS);
    return () => clearInterval(id);
  }, [fetchNotifications]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const hasUnread = list.length > 0 && list[0]?.id !== lastReadId;

  const handleBellClick = () => {
    setOpen((o) => !o);
    if (!open && list[0]) setLastReadId(list[0].id);
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={handleBellClick}
        className="relative rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {hasUnread && (
          <span
            className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-500"
            aria-hidden
          />
        )}
      </button>

      {toast && (
        <div
          className={`fixed right-4 top-16 z-50 max-w-sm rounded-lg border px-4 py-3 shadow-xl ${typeColor(toast.type)}`}
          role="alert"
        >
          <div className="font-semibold">{toast.title}</div>
          <div className="mt-1 text-sm opacity-90">{toast.message}</div>
        </div>
      )}

      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-80 overflow-hidden rounded-xl border border-white/10 bg-black/90 shadow-xl backdrop-blur-sm">
          <div className="border-b border-white/10 px-3 py-2 text-sm font-medium text-white">
            Notifications
          </div>
          <div className="max-h-80 overflow-y-auto">
            {list.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">No notifications</div>
            ) : (
              list.map((n) => (
                <button
                  type="button"
                  key={n.id}
                  onClick={() => setSelectedDetails(selectedDetails?.id === n.id ? null : n)}
                  className={`w-full border-b border-white/5 px-3 py-2.5 text-left transition-colors hover:bg-white/10 ${selectedDetails?.id === n.id ? 'bg-white/10' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={`text-xs font-medium ${typeColor(n.type).split(' ')[0]}`}>
                      {n.title}
                    </span>
                    <span className="text-xs text-zinc-500">{formatTime(n.timestamp)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-sm text-zinc-300">{n.message}</div>
                  {selectedDetails?.id === n.id && n.details != null && (
                    <pre className="mt-2 max-h-32 overflow-auto rounded bg-white/5 p-2 text-xs text-zinc-400">
                      {detailsString(n.details)}
                    </pre>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
