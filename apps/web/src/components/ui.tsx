import Link from "next/link";
import type { ReactNode } from "react";

export type IconName = "rss" | "arrow" | "telegram" | "grid" | "source" | "destination" | "route" | "log" | "billing" | "settings" | "plus" | "close" | "check" | "chevron" | "external" | "refresh" | "search" | "filter" | "pause" | "play" | "download" | "upload" | "clock" | "more" | "logout" | "menu" | "alert";
const paths: Record<IconName, ReactNode> = {
  rss: <><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="5" cy="19" r="1"/></>,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
  telegram: <><path d="m3 11 18-7-4 17-6-6-4 3 1-6 9-5-6 8"/></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
  source: <><path d="M4 5h16v14H4zM8 9h8M8 13h5"/></>,
  destination: <><path d="M4 4h16v13H9l-5 3V4zM8 9h8M8 13h5"/></>,
  route: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v8a2 2 0 0 0 2 2h10M7 6h10a2 2 0 0 1 2 2v3m-3-3 3 3 3-3"/></>,
  log: <><path d="M7 4h12v16H5V6l2-2zM9 8h6M9 12h6M9 16h4"/></>,
  billing: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/></>,
  settings: <><path d="m10 3-1 3-3 1-3 3 2 2-1 3 3 3 3-1 2 2 3-1 1-3 3-1 1-3-2-2 1-3-3-3-3 1-2-1z"/><circle cx="12" cy="12" r="3"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M18 6 6 18"/>, check: <path d="m5 12 4 4L19 6"/>,
  chevron: <path d="m9 5 7 7-7 7"/>, external: <><path d="M14 4h6v6m0-6-9 9M10 4H4v16h16v-6"/></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2 7M20 4v7h-7"/></>, search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z"/>, pause: <><path d="M8 5v14M16 5v14"/></>, play: <path d="m8 4 12 8-12 8z"/>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>, upload: <><path d="M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  logout: <><path d="M10 4H4v16h6m4-13 5 5-5 5M8 12h11"/></>, menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  alert: <><path d="m12 3 10 18H2zM12 9v4M12 17v.01"/></>,
};
export function Icon({ name, size = 20, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className="brand" aria-label="FeedRelay home"><span className="brand-mark"><Icon name="rss" size={21}/></span>{!compact && <span>Feed<span className="brand-light">Relay</span></span>}</Link>;
}
export function Status({ value }: { value: string }) {
  const good = ["active", "sent", "connected", "verified", "ready", "ok", "paid", "enabled", "completed", "healthy"].includes(value);
  const bad = ["failed", "error", "blocked", "uncertain", "invalid", "removed", "disabled"].includes(value);
  return <span className={`status ${good ? "good" : bad ? "bad" : "neutral"}`}><span/>{value.replaceAll("_", " ")}</span>;
}
export function Empty({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={27}/></span><h3>{title}</h3><p>{text}</p>{action}</div>;
}
