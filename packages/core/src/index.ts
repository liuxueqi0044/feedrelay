import { randomUUID, createHash } from 'node:crypto';
export const tables = ['users','workspaces','sessions','authFlows','bindings','destinations','sources','sourceBindings','fetchRuns','items','itemAliases','routes','evaluations','deliveries','attempts','outbox','inbox','audit','checkouts','subscriptions','payments','refunds','grants','usagePeriods','reservations','ledger','billingEvents','rateLimits','idempotency','imports','recovery'] as const;
export type Table = typeof tables[number];
export interface Entity { id: string; createdAt: string; workspaceId?: string }
export type Scalar = string | number | boolean | null;
export type Filter = Record<string, Scalar | { lt?: Scalar; lte?: Scalar; gt?: Scalar; gte?: Scalar; in?: Scalar[]; ne?: Scalar }>;
export interface ListOptions { limit?: number; orderBy?: string; direction?: 'asc' | 'desc' }
export interface Tx {
  get<T extends Entity>(table: Table, id: string): Promise<T | undefined>;
  list<T extends Entity>(table: Table, filter?: Filter, options?: ListOptions): Promise<T[]>;
  put<T extends Entity>(table: Table, value: T): Promise<void>;
  remove(table: Table, id: string): Promise<void>;
}
export interface Store {
  transaction<T>(keys: string[], callback: (tx: Tx) => Promise<T>): Promise<T>;
  read<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export const nowISO = () => new Date().toISOString();
export const newId = () => randomUUID();
export const stableId = (...parts: string[]) => { const hex=createHash('sha256').update(JSON.stringify(parts)).digest('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; };
export const timestamp = (value: string) => new Date(value).getTime();
export const plusMs = (time: string, ms: number) => new Date(timestamp(time) + ms).toISOString();
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'AppError'; }
}
export interface Actor { userId: string; workspaceId: string; telegramId: string }
export interface User extends Entity { telegramId: string; name: string; oidcSub?: string; privateChatStarted: boolean }
export interface Workspace extends Entity { ownerId: string; name: string; state: 'active' | 'deleting' | 'deleted'; freeAnchor: string; version: number }
export interface Session extends Entity { userId: string; workspaceId: string; tokenHash: string; csrf: string; expiresAt: string }
export interface Destination extends Entity { workspaceId: string; chatId: string; title: string; kind: 'private' | 'channel'; authorizedBy: string; state: 'active' | 'blocked' | 'disabled'; version: number; verifiedAt: string; error?: string }
export interface Source extends Entity { url: string; urlHash: string; resolvedUrl?: string; title: string; state: 'initializing' | 'healthy' | 'degraded' | 'blocked'; seq: number; etag?: string; lastModified?: string; checkedAt?: string; lastSuccessAt?: string; nextPollAt: string; leaseUntil?: string; leaseVersion: number; failures: number; error?: string; recoveryEpoch?: string }
export interface SourceBinding extends Entity { workspaceId: string; sourceId: string; title: string; state: 'active' | 'disabled'; version: number }
export interface Item extends Entity { sourceId: string; seq: number; title: string; summary: string; url?: string; externalId?: string; contentHash: string; revision: number; publishedAt?: string; updatedAt: string }
export interface Rules { include: string[]; exclude: string[]; field: 'title' | 'all'; caseSensitive: boolean; template: string; summaryLength: number }
export interface Route extends Entity { workspaceId: string; sourceBindingId: string; sourceId: string; destinationId: string; name: string; state: 'initializing' | 'active' | 'paused' | 'plan_limit' | 'recovery' | 'deleted'; cursor: number; baselineSeq?: number; requestedIntervalMinutes: number; nextReleaseAt: string; rules: Rules; version: number; baselineAfter: string; pauseReason?: string }
export type DeliveryState = 'pending' | 'sending' | 'retry_wait' | 'sent' | 'unknown' | 'needs_review' | 'blocked' | 'dead' | 'expired' | 'quota_deferred';
export interface Delivery extends Entity { workspaceId: string; routeId?: string; itemId?: string; destinationId?: string; chatId: string; enqueueSeq?: number; kind: 'article' | 'test' | 'bot'; text: string; parseMode?: 'HTML'; replyMarkup?: Record<string,unknown>; state: DeliveryState; nextAttemptAt: string; eligibleAt: string; attemptCount: number; unknownRetries: number; version: number; leaseUntil?: string; attemptId?: string; messageId?: string; sentAt?: string; error?: string; reservationId?: string; ruleVersion?: number; destinationVersion?: number; routeVersion?: number }
export interface Outbox extends Entity { type: 'fetch' | 'release' | 'deliver' | 'inbox' | 'billing'; aggregateId: string; state: 'pending' | 'dispatched'; dispatchedAt?: string }
export interface Audit extends Entity { workspaceId?: string; actorId?: string; action: string; targetId: string; details?: Record<string, unknown> }
export const DEFAULT_RULES: Rules = { include: [], exclude: [], field: 'all', caseSensitive: false, template: '{title}\n\n{summary}\n\n{url}', summaryLength: 500 };
export async function requireWorkspace(tx: Tx, actor: Actor): Promise<Workspace> {
  const workspace = await tx.get<Workspace>('workspaces', actor.workspaceId);
  if (!workspace || workspace.ownerId !== actor.userId || workspace.state !== 'active') throw new AppError('workspace_forbidden','This workspace is unavailable.',403);
  return workspace;
}
export async function owned<T extends Entity>(tx: Tx, table: Table, id: string, workspaceId: string): Promise<T> {
  const row = await tx.get<T>(table,id);
  if (!row || row.workspaceId !== workspaceId) throw new AppError('not_found','This resource was not found.',404);
  return row;
}
export async function emit(tx: Tx, type: Outbox['type'], aggregateId: string, workspaceId?: string) {
  const event: Outbox = { id: newId(), createdAt: nowISO(), type, aggregateId, state: 'pending', ...(workspaceId ? {workspaceId} : {}) };
  await tx.put('outbox',event);
}
export async function audit(tx: Tx, action: string, targetId: string, actor?: Actor, details?: Record<string,unknown>) {
  await tx.put<Audit>('audit',{id:newId(),createdAt:nowISO(),action,targetId,workspaceId:actor?.workspaceId,actorId:actor?.userId,details});
}
