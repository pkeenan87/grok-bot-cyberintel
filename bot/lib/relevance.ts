import type { FeedConfig, FeedItem } from "./feeds.js";

export const LEGAL_TERMS = [
  "law firm", "law firms", "llp", "attorney", "attorneys", "solicitor", "solicitors",
  "barrister", "barristers", "court", "courts", "judiciary", "judicial", "bar association",
  "legal services", "e-discovery", "ediscovery", "legal tech", "legal-tech", "legal software",
  "lawyer", "lawyers", "legal aid", "law society",
];
export const CYBER_TERMS = [
  "ransomware", "breach", "breaches", "cyberattack", "cyberattacks", "cyber attack",
  "cyber-attack", "hack", "hacked", "hacking", "extortion", "data leak", "data theft",
  "phishing", "bec", "business email compromise", "compromise", "compromised",
  "cybersecurity", "cyber security", "malware", "unauthorized access", "unauthorised access",
  "denial of service", "ddos",
];

/** Word boundaries avoid accidental matches such as 'court' in 'courteous'. */
export function scoreItem(item: FeedItem, kind: FeedConfig["kind"]): { relevant: boolean; matched: string[] } {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const terms = kind === "legal" ? CYBER_TERMS : LEGAL_TERMS;
  const matched = terms.filter((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  return { relevant: matched.length > 0, matched };
}
