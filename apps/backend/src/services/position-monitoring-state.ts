/**
 * In-memory monitoring labels for positions (e.g. "⚠️ Monitoring: Funding Flipped").
 * Used when conditions are bad but time-to-funding > 10 min; cleared when we close or conditions recover.
 */
const statusBySymbol = new Map<string, string>();

export function getMonitoringStatuses(): Record<string, string> {
  const out: Record<string, string> = {};
  statusBySymbol.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export function setMonitoringStatus(symbol: string, status: string): void {
  statusBySymbol.set(symbol, status);
}

export function clearMonitoringStatus(symbol: string): void {
  statusBySymbol.delete(symbol);
}
