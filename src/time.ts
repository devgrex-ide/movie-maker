export function ageOn(dob: string, on: Date): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (!match) return -1;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let age = on.getUTCFullYear() - year;
  const nowMd = (on.getUTCMonth() + 1) * 100 + on.getUTCDate();
  const birthMd = month * 100 + day;
  if (nowMd < birthMd) age -= 1;
  return age;
}

export function isoNow(date: Date): string {
  return date.toISOString();
}

export function formatClock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const total = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${sign}${minutes}:${String(seconds).padStart(2, "0")}`;
}
