export function localParts(now: Date, tz: string): { date: string; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday")),
  };
}

export function isLocalWeekday(now: Date, tz: string): boolean {
  const { weekday } = localParts(now, tz);
  return weekday >= 1 && weekday <= 5;
}

export function shouldFire(now: Date, tz: string, hour: number, catchUpHours = 2): boolean {
  const local = localParts(now, tz);
  return local.weekday >= 1 && local.weekday <= 5 && local.hour >= hour && local.hour <= hour + catchUpHours;
}

export function computeWindow(now: Date, lastSuccessIso: string | null): { since: string; until: string } {
  const hour = 60 * 60 * 1000;
  const last = lastSuccessIso === null ? NaN : Date.parse(lastSuccessIso);
  const since = Number.isFinite(last) ? last : now.getTime() - 72 * hour;
  return {
    since: new Date(Math.min(now.getTime(), Math.max(since, now.getTime() - 96 * hour))).toISOString(),
    until: now.toISOString(),
  };
}
