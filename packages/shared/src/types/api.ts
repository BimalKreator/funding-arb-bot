/**
 * API request/response types
 */

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  version: string;
}

export interface ApiError {
  code: string;
  message: string;
}
