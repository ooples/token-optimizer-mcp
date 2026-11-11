export function verify(timestamp: number, now: number): boolean {
  return Math.abs(now - timestamp) < 30_000;
}
