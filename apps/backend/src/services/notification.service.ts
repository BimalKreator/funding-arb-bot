const MAX_NOTIFICATIONS = 50;

export type NotificationType = 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';

export interface Notification {
  id: string;
  timestamp: string;
  type: NotificationType;
  title: string;
  message: string;
  details?: string | Record<string, unknown>;
}

export class NotificationService {
  private store: Notification[] = [];
  private idCounter = 0;

  add(
    type: NotificationType,
    title: string,
    message: string,
    details?: string | Record<string, unknown>
  ): void {
    const id = `n-${++this.idCounter}-${Date.now()}`;
    const notification: Notification = {
      id,
      timestamp: new Date().toISOString(),
      type,
      title,
      message,
      details,
    };
    this.store.unshift(notification);
    if (this.store.length > MAX_NOTIFICATIONS) {
      this.store = this.store.slice(0, MAX_NOTIFICATIONS);
    }
  }

  getAll(): Notification[] {
    return [...this.store];
  }
}
