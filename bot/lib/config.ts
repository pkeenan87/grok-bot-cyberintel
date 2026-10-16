export function getBriefConfig(env: NodeJS.ProcessEnv = process.env) {
  let timezone: string | null = env.BRIEF_TIMEZONE?.trim() || null;
  if (timezone) {
    try { new Intl.DateTimeFormat(undefined, { timeZone: timezone }); }
    catch { timezone = null; }
  }
  const hour = Number(env.BRIEF_LOCAL_HOUR ?? 9);
  return {
    timezone,
    localHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9,
    webhookUrl: env.BRIEF_WEBHOOK_URL?.trim() || null,
    webhookFormat: env.BRIEF_WEBHOOK_FORMAT === "json" ? "json" as const : "slack" as const,
  };
}
