export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function request<T>(path: string, options: { method?: string; body?: unknown; csrf?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", signal: options.signal,
    headers: { ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!response.ok) {
    const error = data as { message?: string; code?: string } | null;
    throw new ApiError(error?.message ?? `The request could not be completed (${response.status}).`, error?.code ?? "REQUEST_FAILED", response.status);
  }
  return data as T;
}
export type Config = { mode: "demo" | "production"; botUsername: string; billingEnabled: boolean; starterStars: number; supportEmail: string };
export type Session = { user: { id: string; name: string; telegramId: string }; workspace: { id: string; name: string; state: string }; csrf: string };
export type Source = { id: string; title: string; url: string; state: string; error?: string; checkedAt?: string; createdAt: string };
export type Destination = { id: string; title: string; chatId: string; kind: string; state: string; error?: string };
export type Rules = { include: string[]; exclude: string[]; field: "title" | "all"; caseSensitive: boolean; template: string; summaryLength: number };
export type Route = { id: string; name: string; sourceBindingId: string; destinationId: string; state: string; requestedIntervalMinutes: number; rules: Rules; sourceTitle: string; destinationTitle: string; pauseReason?: string };
export type Delivery = { id: string; title: string; chatTitle: string; state: string; text: string; error?: string; attemptCount: number; createdAt: string; sentAt?: string; messageId?: string };
export type FeedItem = { id: string; title: string; summary: string; url: string; publishedAt?: string };
export type Usage = { used: number; reserved: number; limit: number };
export type Overview = { sources: number; destinations: number; routes: number; sent: number; pending: number; failed: number; usage: Usage; plan: string; activity: { id: string; title: string; status: string; createdAt: string }[] };
export type Billing = { plan: string; usage: Usage; entitlements: { sourceLimit: number; destinationLimit: number; minIntervalMinutes: number; deliveryLimit: number }; starterStars: number; billingEnabled: boolean; paidThrough?: string; renewState?: string; payments: { id: string; chargeId: string; amountStars: number; state: string; createdAt: string }[] };
export type Settings = { workspace: { id: string; name: string; state: string }; supportEmail: string };
export function date(value?: string) { return value ? new Date(value).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Not yet"; }
export function relative(value?: string) {
  if (!value) return "Not checked yet";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
