/**
 * WebSocket message types (placeholder for future implementation)
 */

export type WsMessageType = 'ping' | 'pong' | 'subscribe' | 'unsubscribe' | 'data';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload?: T;
  timestamp: string;
}

export interface WsConnectionState {
  connected: boolean;
  lastPing?: string;
}
