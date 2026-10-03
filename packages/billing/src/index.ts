import { createHash, randomUUID } from 'node:crypto';
import { AppError, requireWorkspace, type Actor, type Entity, type Store, type Tx, type Workspace } from '@feedrelay/core';

/** Telegram Stars invoice subscriptions are exactly 30 days. Numbers below are Unix seconds. */
export const SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;
const PERIOD_MS = SUBSCRIPTION_PERIOD_SECONDS * 1_000;
export type TimestampInput = string | number | Date;
export type Plan = 'free' | 'starter';
export interface PlanLimits { maxSources: number; maxDestinations: number; minIntervalMinutes: number; deliveryLimit: number; retentionDays: number }
export const PLAN_LIMITS: Readonly<Record<Plan, Readonly<PlanLimits>>> = Object.freeze({
  free: Object.freeze({ maxSources: 3, maxDestinations: 1, minIntervalMinutes: 60, deliveryLimit: 200, retentionDays: 7 }),
  starter: Object.freeze({ maxSources: 30, maxDestinations: 3, minIntervalMinutes: 5, deliveryLimit: 5_000, retentionDays: 30 }),
});
export interface BillingOptions {
  botId: string | number;
  priceStars?: number;
  billingEnabled?: boolean;
  termsUrl?: string;
  supportContact?: string;
  clock?: () => TimestampInput;
}
export interface Checkout extends Entity {
  workspaceId: string; botId: string; ownerId: string; payerId: string; payload: string;
  currency: 'XTR'; amount: number; subscriptionPeriod: number; termsAcceptedAt: string;
  state: 'open' | 'prechecked' | 'occupied'; idempotencyKey?: string; acceptedPreCheckoutId?: string;
}
export interface Subscription extends Entity {
  workspaceId: string; botId: string; checkoutId: string; payload: string; payerId: string;
  firstChargeId?: string; latestExpiration?: string; renewalCanceled: boolean;
  canceledAt?: string; renewalState?: 'active' | 'canceled' | 'failed';
  lastTelegramUpdateId?: number; lastTelegramUpdateAt?: string;
}
export interface SubscriptionUpdateInput { payload: string; payerId: string | number; state: 'active' | 'canceled' | 'failed'; updateId?: string | number }
export type SubscriptionUpdateResult = Omit<BillingResult, 'chargeId'>;
export interface PaymentInput {
  chargeId: string; payload: string; payerId: string | number; currency: string; totalAmount: number;
  expirationDate?: TimestampInput; isRecurring?: boolean; isFirstRecurring?: boolean; paidAt: TimestampInput;
}
export interface Payment extends Entity {
  workspaceId?: string; botId: string; chargeId: string; payload: string; payerId: string;
  currency: string; totalAmount: number; expirationDate?: string; paidAt: string;
  isRecurring: boolean; isFirstRecurring: boolean; state: 'applied' | 'refunded' | 'needs_review'; reason?: string;
}
export interface RefundInput {
  chargeId: string; payload?: string; payerId?: string | number; currency?: string; totalAmount?: number; refundedAt?: TimestampInput;
}
export interface Refund extends Entity {
  workspaceId?: string; botId: string; chargeId: string; payload?: string; payerId?: string;
  currency?: string; totalAmount?: number; refundedAt: string; state: 'applied' | 'pending' | 'needs_review'; reason?: string;
}
export interface Grant extends Entity {
  workspaceId: string; botId: string; chargeId: string; checkoutId: string; plan: 'starter';
  startsAt: string; endsAt: string; state: 'active' | 'revoked'; revokedAt?: string;
}
export interface BillingEvent extends Entity {
  workspaceId?: string; botId: string; kind: 'payment' | 'refund' | 'cancellation' | 'subscription_update'; chargeId?: string;
  state: 'applied' | 'duplicate' | 'needs_review'; reason?: string; raw: unknown;
}
export interface UsagePeriod extends Entity {
  workspaceId: string; plan: Plan; startsAt: string; endsAt: string; limit: number; used: number; reserved: number;
}
export interface UsageReservation extends Entity {
  workspaceId: string; deliveryId: string; periodId: string; plan: Plan; periodEnd: string;
  state: 'held' | 'unknown' | 'committed' | 'released'; expiresAt: string;
  committedAt?: string; releasedAt?: string; unknownAt?: string;
}
export interface UsageLedger extends Entity { workspaceId: string; deliveryId: string; periodId: string; reservationId: string; committedAt: string }
export interface Entitlements extends PlanLimits {
  workspaceId: string; plan: Plan; periodId: string; periodStart: string; periodEnd: string;
  used: number; reserved: number; remaining: number; paidUntil?: string; renewalCanceled: boolean;
}
export interface BillingStatus extends Entitlements {
  billingEnabled: boolean; priceStars: number; termsUrl?: string; supportContact?: string;
  checkout?: Checkout; subscription?: Subscription;
}
export interface BillingResult { state: 'applied' | 'duplicate' | 'needs_review'; workspaceId?: string; chargeId: string; reason?: string }
export interface PreCheckoutResult { ok: boolean; errorMessage?: string }
export interface ReserveUsageResult { ok: boolean; reservationId?: string; periodId: string; reason?: 'quota_exhausted'; alreadyCommitted?: boolean; unknown?: boolean }
export interface ReleaseUsageOptions { at?: TimestampInput; preserveUnknown?: boolean }
export interface TelegramSubscriptionClient {
  editUserStarSubscription(input: { user_id: string; telegram_payment_charge_id: string; is_canceled: true }): Promise<unknown>;
}

function iso(value: TimestampInput): string {
  const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value * 1_000 : value);
  if (!Number.isFinite(date.getTime())) throw new AppError('invalid_timestamp', 'A valid receipt timestamp is required.');
  return date.toISOString();
}
const time = (value: string) => Date.parse(value);
const key = (prefix: string, ...values: string[]) => `${prefix}:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
const activeReservation = (r: UsageReservation, at: string) => r.state === 'unknown' || (r.state === 'held' && time(r.expiresAt) > time(at) && time(r.periodEnd) > time(at));

/** Caller-supplied usage transactions must hold the workspace lock, together with the delivery mutation. */
export class BillingService {
  readonly billingEnabled: boolean;
  readonly priceStars: number;
  readonly botId: string;
  private readonly options: BillingOptions;
  constructor(private readonly store: Store, options: BillingOptions) {
    this.options = options;
    this.botId = String(options.botId);
    this.priceStars = options.priceStars ?? 300;
    if (!this.botId.trim()) throw new AppError('billing_configuration', 'A bot identifier is required.');
    if (!Number.isSafeInteger(this.priceStars) || this.priceStars < 1 || this.priceStars > 10_000) throw new AppError('billing_configuration', 'The subscription price must be 1–10000 Stars.');
    let validTerms = false;
    try { validTerms = new URL(options.termsUrl ?? '').protocol === 'https:'; } catch { /* disabled until configured */ }
    this.billingEnabled = options.billingEnabled === true && validTerms && Boolean(options.supportContact?.trim());
  }
  private now(at?: TimestampInput) { return iso(at ?? this.options.clock?.() ?? new Date()); }
  private checkoutId(workspaceId: string) { return key('checkout', this.botId, workspaceId); }
  private subscriptionId(workspaceId: string) { return key('subscription', this.botId, workspaceId); }
  private paymentId(chargeId: string) { return key('payment', this.botId, chargeId); }
  private refundId(chargeId: string) { return key('refund', this.botId, chargeId); }
  private grantId(chargeId: string) { return key('grant', this.botId, chargeId); }
  private locks(workspaceId?: string) { return [`billing:${this.botId}`, ...(workspaceId ? [`workspace:${workspaceId}`] : [])]; }
  private async findCheckout(tx: Tx, payload: string) {
    if (typeof payload !== 'string' || !payload || Buffer.byteLength(payload, 'utf8') > 128) return undefined;
    const rows = await tx.list<Checkout>('checkouts', { payload, botId: this.botId });
    return rows.length === 1 ? rows[0] : undefined;
  }
  private async event(tx: Tx, kind: BillingEvent['kind'], raw: unknown, result: Omit<BillingResult, 'chargeId'> & { chargeId?: string }) {
    await tx.put<BillingEvent>('billingEvents', { id: randomUUID(), createdAt: this.now(), botId: this.botId, kind, raw, ...result });
  }
  entitlements(workspaceId: string): Promise<Entitlements>;
  entitlements(tx: Tx, workspaceId: string, at?: TimestampInput): Promise<Entitlements>;
  entitlements(tx: undefined, workspaceId: string, at?: TimestampInput): Promise<Entitlements>;
  async entitlements(txOrId: Tx | string | undefined, workspaceId?: string, at?: TimestampInput): Promise<Entitlements> {
    if (typeof txOrId === 'string') return this.store.read(tx => this.calculate(tx, txOrId, this.now(at)));
    if (!workspaceId) throw new AppError('workspace_required', 'A workspace is required.');
    return txOrId ? this.calculate(txOrId, workspaceId, this.now(at)) : this.store.read(tx => this.calculate(tx, workspaceId, this.now(at)));
  }
  private async calculate(tx: Tx, workspaceId: string, at: string): Promise<Entitlements> {
    const workspace = await tx.get<Workspace>('workspaces', workspaceId);
    if (!workspace || workspace.state !== 'active') throw new AppError('workspace_forbidden', 'This workspace is unavailable.', 403);
    const grants = (await tx.list<Grant>('grants', { workspaceId, botId: this.botId, state: 'active' })).sort((a,b) => time(a.startsAt) - time(b.startsAt));
    const current = grants.find(g => time(g.startsAt) <= time(at) && time(at) < time(g.endsAt));
    const plan: Plan = current ? 'starter' : 'free';
    let periodStart: string, periodEnd: string, periodId: string;
    let paidUntil: string | undefined;
    if (current) {
      periodStart = current.startsAt; periodEnd = current.endsAt; periodId = current.id; paidUntil = current.endsAt;
      // Contiguous grants can extend the displayed expiration; refunded gaps never do.
      for (const grant of grants) if (time(grant.startsAt) === time(paidUntil)) paidUntil = grant.endsAt;
    } else {
      const anchor = time(iso(workspace.freeAnchor));
      const index = Math.max(0, Math.floor((time(at) - anchor) / PERIOD_MS));
      periodStart = new Date(anchor + index * PERIOD_MS).toISOString();
      periodEnd = new Date(anchor + (index + 1) * PERIOD_MS).toISOString();
      periodId = key('free-period', workspaceId, periodStart);
    }
    const reservations = await tx.list<UsageReservation>('reservations', { workspaceId, periodId });
    const used = (await tx.list<UsageLedger>('ledger', { workspaceId, periodId })).length;
    const reserved = reservations.filter(r => activeReservation(r, at)).length;
    const subscription = await tx.get<Subscription>('subscriptions', this.subscriptionId(workspaceId));
    const limits = PLAN_LIMITS[plan];
    return { workspaceId, plan, ...limits, periodId, periodStart, periodEnd, used, reserved, remaining: Math.max(0, limits.deliveryLimit - used - reserved), paidUntil, renewalCanceled: subscription?.renewalCanceled ?? false };
  }
  async checkout(actor: Actor, termsAccepted: boolean, idempotencyKey?: string): Promise<Checkout> {
    if (!this.billingEnabled) throw new AppError('billing_disabled', 'Paid subscriptions are not available.', 503);
    if (termsAccepted !== true) throw new AppError('terms_required', 'Accept the subscription terms before checkout.');
    if (idempotencyKey && idempotencyKey.length > 128) throw new AppError('invalid_idempotency_key', 'The idempotency key is too long.');
    return this.store.transaction(this.locks(actor.workspaceId), async tx => {
      await requireWorkspace(tx, actor);
      const subscription = await tx.get<Subscription>('subscriptions', this.subscriptionId(actor.workspaceId));
      if (subscription) throw new AppError('subscription_exists', 'This workspace already has a subscription. Check its status or contact support.', 409);
      const existing = await tx.get<Checkout>('checkouts', this.checkoutId(actor.workspaceId));
      if (existing) {
        if (existing.payerId !== actor.telegramId) throw new AppError('checkout_payer_mismatch', 'Checkout belongs to a different Telegram account.', 409);
        return existing;
      }
      const createdAt = this.now();
      const checkout: Checkout = { id: this.checkoutId(actor.workspaceId), createdAt, workspaceId: actor.workspaceId, botId: this.botId, ownerId: actor.userId, payerId: actor.telegramId, payload: `fr:${randomUUID()}`, currency: 'XTR', amount: this.priceStars, subscriptionPeriod: SUBSCRIPTION_PERIOD_SECONDS, termsAcceptedAt: createdAt, state: 'open', ...(idempotencyKey ? { idempotencyKey } : {}) };
      await tx.put('checkouts', checkout);
      return checkout;
    });
  }
  async validatePreCheckout(payload: string, telegramPayer: string | number, currency: string, amount: number, queryId?: string): Promise<PreCheckoutResult> {
    if (!this.billingEnabled) return { ok: false, errorMessage: 'Subscriptions are currently unavailable.' };
    return this.store.transaction(this.locks(), async tx => {
      const checkout = await this.findCheckout(tx, payload);
      if (!checkout || checkout.payerId !== String(telegramPayer) || currency !== 'XTR' || amount !== checkout.amount || !Number.isSafeInteger(amount)) return { ok: false, errorMessage: 'The invoice does not match this account or price.' };
      const workspace = await tx.get<Workspace>('workspaces', checkout.workspaceId);
      if (!workspace || workspace.state !== 'active' || workspace.ownerId !== checkout.ownerId) return { ok: false, errorMessage: 'This workspace is unavailable.' };
      if (await tx.get<Subscription>('subscriptions', this.subscriptionId(checkout.workspaceId))) return { ok: false, errorMessage: 'This workspace already has a subscription.' };
      if (checkout.state === 'prechecked') return queryId && checkout.acceptedPreCheckoutId === queryId ? { ok: true } : { ok: false, errorMessage: 'A payment for this workspace is already in progress. Contact support if it did not complete.' };
      await tx.put('checkouts', { ...checkout, state: 'prechecked' as const, ...(queryId ? { acceptedPreCheckoutId: queryId } : {}) });
      return { ok: true };
    });
  }
  private refundMatches(refund: Refund, payment: Payment) {
    return (refund.payload === undefined || refund.payload === payment.payload) && (refund.payerId === undefined || refund.payerId === payment.payerId) && (refund.currency === undefined || refund.currency === payment.currency) && (refund.totalAmount === undefined || refund.totalAmount === payment.totalAmount);
  }
  async recordPayment(input: PaymentInput): Promise<BillingResult> {
    // Preserve malformed receipt evidence instead of throwing and losing the webhook.
    let paidAt: string, expirationDate: string | undefined, invalidDate = false;
    try { paidAt = iso(input.paidAt); expirationDate = input.expirationDate === undefined ? undefined : iso(input.expirationDate); }
    catch { paidAt = this.now(); invalidDate = true; }
    const normalized: Payment = { id: this.paymentId(String(input.chargeId)), createdAt: this.now(), botId: this.botId, chargeId: String(input.chargeId), payload: input.payload, payerId: String(input.payerId), currency: input.currency, totalAmount: input.totalAmount, paidAt, expirationDate, isRecurring: input.isRecurring === true, isFirstRecurring: input.isFirstRecurring === true, state: 'needs_review' };
    const mappedWorkspace = await this.store.read(async tx => (await this.findCheckout(tx, input.payload))?.workspaceId);
    return this.store.transaction(this.locks(mappedWorkspace), async tx => {
      const existing = await tx.get<Payment>('payments', normalized.id);
      if (existing) {
        const identical = ['payload','payerId','currency','totalAmount','paidAt','expirationDate','isRecurring','isFirstRecurring'].every(field => existing[field as keyof Payment] === normalized[field as keyof Payment]);
        const result: BillingResult = { state: identical ? 'duplicate' : 'needs_review', chargeId: normalized.chargeId, workspaceId: existing.workspaceId, ...(!identical ? { reason: 'charge_id_conflict' } : {}) };
        await this.event(tx, 'payment', input, result); return result;
      }
      const checkout = await this.findCheckout(tx, input.payload);
      let reason: string | undefined;
      if (typeof input.chargeId !== 'string' || !input.chargeId.trim() || !checkout) reason = 'unknown_invoice';
      else if (checkout.payerId !== normalized.payerId || normalized.currency !== 'XTR' || normalized.totalAmount !== checkout.amount || !Number.isSafeInteger(normalized.totalAmount)) reason = 'receipt_mismatch';
      else if (invalidDate || !normalized.isRecurring || !expirationDate || time(expirationDate) <= time(paidAt)) reason = 'invalid_subscription_receipt';
      const workspace = checkout ? await tx.get<Workspace>('workspaces', checkout.workspaceId) : undefined;
      // Payment facts can arrive after deletion starts. Access remains gated by
      // requireWorkspace/calculate, while cancellation still needs the charge ID.
      if (!reason && (!workspace || workspace.ownerId !== checkout?.ownerId)) reason = 'workspace_unavailable';
      const subscription = checkout ? await tx.get<Subscription>('subscriptions', this.subscriptionId(checkout.workspaceId)) : undefined;
      if (!reason && normalized.isFirstRecurring && subscription?.firstChargeId && subscription.firstChargeId !== normalized.chargeId) reason = 'duplicate_subscription';
      const refund = await tx.get<Refund>('refunds', this.refundId(normalized.chargeId));
      if (!reason && refund && !this.refundMatches(refund, normalized)) reason = 'refund_receipt_conflict';
      let startsAt: string | undefined;
      if (!reason && expirationDate && checkout) {
        startsAt = new Date(time(expirationDate) - PERIOD_MS).toISOString();
        const grants = await tx.list<Grant>('grants', { workspaceId: checkout.workspaceId, botId: this.botId });
        // A revoked receipt still proves the interval existed: another charge cannot refill it.
        if (grants.some(g => time(g.startsAt) < time(expirationDate!) && time(startsAt!) < time(g.endsAt))) reason = 'overlapping_subscription_period';
      }
      if (checkout) normalized.workspaceId = checkout.workspaceId;
      if (reason || !checkout || !startsAt || !expirationDate) {
        normalized.reason = reason ?? 'invalid_subscription_receipt';
        await tx.put('payments', normalized);
        const result: BillingResult = { state: 'needs_review', chargeId: normalized.chargeId, workspaceId: normalized.workspaceId, reason: normalized.reason };
        await this.event(tx, 'payment', input, result); return result;
      }
      normalized.state = refund ? 'refunded' : 'applied';
      await tx.put('payments', normalized);
      await tx.put<Grant>('grants', { id: this.grantId(normalized.chargeId), createdAt: this.now(), workspaceId: checkout.workspaceId, botId: this.botId, checkoutId: checkout.id, chargeId: normalized.chargeId, plan: 'starter', startsAt, endsAt: expirationDate, state: refund ? 'revoked' : 'active', ...(refund ? { revokedAt: refund.refundedAt } : {}) });
      const sub: Subscription = subscription ?? { id: this.subscriptionId(checkout.workspaceId), createdAt: this.now(), workspaceId: checkout.workspaceId, botId: this.botId, checkoutId: checkout.id, payload: checkout.payload, payerId: checkout.payerId, renewalCanceled: false, renewalState: 'active' };
      if (normalized.isFirstRecurring) sub.firstChargeId = normalized.chargeId;
      if (!sub.latestExpiration || time(expirationDate) > time(sub.latestExpiration)) sub.latestExpiration = expirationDate;
      await tx.put('subscriptions', sub);
      await tx.put('checkouts', { ...checkout, state: 'occupied' as const });
      if (refund) await tx.put('refunds', { ...refund, workspaceId: checkout.workspaceId, state: 'applied' as const, reason: undefined });
      const result: BillingResult = { state: 'applied', chargeId: normalized.chargeId, workspaceId: checkout.workspaceId };
      await this.event(tx, 'payment', input, result); return result;
    });
  }
  async recordRefund(input: RefundInput): Promise<BillingResult> {
    let refundedAt: string;
    try { refundedAt = this.now(input.refundedAt); } catch { refundedAt = this.now(); }
    const mappedWorkspace = await this.store.read(async tx => (await tx.get<Payment>('payments', this.paymentId(String(input.chargeId))))?.workspaceId ?? (input.payload ? (await this.findCheckout(tx, input.payload))?.workspaceId : undefined));
    return this.store.transaction(this.locks(mappedWorkspace), async tx => {
      const id = this.refundId(String(input.chargeId));
      const existing = await tx.get<Refund>('refunds', id);
      const payment = await tx.get<Payment>('payments', this.paymentId(String(input.chargeId)));
      const refund: Refund = { id, createdAt: this.now(), botId: this.botId, chargeId: String(input.chargeId), refundedAt, state: 'pending', ...(input.payload !== undefined ? { payload: input.payload } : {}), ...(input.payerId !== undefined ? { payerId: String(input.payerId) } : {}), ...(input.currency !== undefined ? { currency: input.currency } : {}), ...(input.totalAmount !== undefined ? { totalAmount: input.totalAmount } : {}) };
      if (existing) {
        const conflicting = ['payload','payerId','currency','totalAmount'].some(field => refund[field as keyof Refund] !== undefined && existing[field as keyof Refund] !== undefined && refund[field as keyof Refund] !== existing[field as keyof Refund]);
        const result: BillingResult = { state: conflicting ? 'needs_review' : 'duplicate', chargeId: refund.chargeId, workspaceId: existing.workspaceId, ...(conflicting ? { reason: 'refund_id_conflict' } : {}) };
        await this.event(tx, 'refund', input, result); return result;
      }
      let reason: string | undefined;
      if (typeof input.chargeId !== 'string' || !input.chargeId.trim()) reason = 'invalid_charge_id';
      else if (!payment) reason = 'payment_not_received';
      else if (!this.refundMatches(refund, payment)) reason = 'refund_receipt_mismatch';
      else if (payment.state === 'needs_review' || !payment.workspaceId) reason = 'payment_needs_review';
      refund.workspaceId = payment?.workspaceId;
      refund.state = reason ? (reason === 'payment_not_received' ? 'pending' : 'needs_review') : 'applied';
      refund.reason = reason;
      await tx.put('refunds', refund);
      if (!reason && payment) {
        await tx.put('payments', { ...payment, state: 'refunded' as const });
        const grant = await tx.get<Grant>('grants', this.grantId(refund.chargeId));
        if (grant) await tx.put('grants', { ...grant, state: 'revoked' as const, revokedAt: refund.refundedAt });
      }
      const result: BillingResult = { state: reason ? 'needs_review' : 'applied', chargeId: refund.chargeId, workspaceId: refund.workspaceId, ...(reason ? { reason } : {}) };
      await this.event(tx, 'refund', input, result); return result;
    });
  }
  async status(actor: Actor): Promise<BillingStatus> {
    return this.store.read(async tx => {
      await requireWorkspace(tx, actor);
      return { ...await this.calculate(tx, actor.workspaceId, this.now()), billingEnabled: this.billingEnabled, priceStars: this.priceStars, termsUrl: this.options.termsUrl, supportContact: this.options.supportContact, checkout: await tx.get<Checkout>('checkouts', this.checkoutId(actor.workspaceId)), subscription: await tx.get<Subscription>('subscriptions', this.subscriptionId(actor.workspaceId)) };
    });
  }
  /** Bot API subscription updates change renewal state, never an already-paid grant interval. */
  async recordSubscriptionUpdate(input: SubscriptionUpdateInput): Promise<SubscriptionUpdateResult> {
    const updateId = input.updateId === undefined ? undefined : typeof input.updateId === 'number' ? input.updateId : /^\d+$/.test(input.updateId) ? Number(input.updateId) : NaN;
    const mappedWorkspace = await this.store.read(async tx => (await this.findCheckout(tx, input.payload))?.workspaceId);
    return this.store.transaction(this.locks(mappedWorkspace), async tx => {
      const checkout = await this.findCheckout(tx, input.payload);
      const workspace = checkout ? await tx.get<Workspace>('workspaces', checkout.workspaceId) : undefined;
      let reason: string | undefined;
      if (!checkout) reason = 'unknown_invoice';
      else if (checkout.payerId !== String(input.payerId)) reason = 'subscription_payer_mismatch';
      else if (!workspace || workspace.ownerId !== checkout.ownerId) reason = 'workspace_unavailable';
      else if (!['active','canceled','failed'].includes(input.state) || (updateId !== undefined && (!Number.isSafeInteger(updateId) || updateId < 0))) reason = 'invalid_subscription_update';
      if (reason || !checkout) {
        const result: SubscriptionUpdateResult = { state: 'needs_review', workspaceId: checkout?.workspaceId, reason: reason ?? 'unknown_invoice' };
        await this.event(tx, 'subscription_update', input, result); return result;
      }
      const now = this.now();
      const subscription: Subscription = await tx.get<Subscription>('subscriptions', this.subscriptionId(checkout.workspaceId)) ?? { id: this.subscriptionId(checkout.workspaceId), createdAt: now, workspaceId: checkout.workspaceId, botId: this.botId, checkoutId: checkout.id, payload: checkout.payload, payerId: checkout.payerId, renewalCanceled: false };
      if (updateId !== undefined && subscription.lastTelegramUpdateId !== undefined) {
        const same = updateId === subscription.lastTelegramUpdateId;
        const stale = updateId < subscription.lastTelegramUpdateId;
        // A lower ID after a long gap can be stale or Telegram's randomized restart.
        // Preserve the known state and retain ambiguous ordering for review.
        const uncertainOrder = stale && time(now) - time(subscription.lastTelegramUpdateAt ?? now) >= 7 * 86_400_000;
        if (same || stale) {
          const conflict = same && input.state !== subscription.renewalState;
          const result: SubscriptionUpdateResult = { state: conflict || uncertainOrder ? 'needs_review' : 'duplicate', workspaceId: checkout.workspaceId, ...(conflict ? { reason: 'subscription_update_conflict' } : uncertainOrder ? { reason: 'subscription_update_order_uncertain' } : stale ? { reason: 'stale_subscription_update' } : {}) };
          await this.event(tx, 'subscription_update', input, result); return result;
        }
      }
      subscription.renewalState = input.state;
      if (input.state !== 'failed') subscription.renewalCanceled = input.state === 'canceled';
      if (input.state === 'canceled') subscription.canceledAt = now;
      if (input.state === 'active') subscription.canceledAt = undefined;
      subscription.lastTelegramUpdateAt = now;
      if (updateId !== undefined) subscription.lastTelegramUpdateId = updateId;
      await tx.put('subscriptions', subscription);
      await tx.put('checkouts', { ...checkout, state: 'occupied' as const });
      const result: SubscriptionUpdateResult = { state: 'applied', workspaceId: checkout.workspaceId };
      await this.event(tx, 'subscription_update', input, result); return result;
    });
  }
  async cancelRenewal(actor: Actor, telegramClient: TelegramSubscriptionClient): Promise<BillingStatus> {
    // Keep the occupancy lock across the idempotent Telegram call; only confirmed cancellation changes state.
    await this.store.transaction(this.locks(actor.workspaceId), async tx => {
      await requireWorkspace(tx, actor);
      const subscription = await tx.get<Subscription>('subscriptions', this.subscriptionId(actor.workspaceId));
      if (!subscription) throw new AppError('subscription_not_found', 'There is no subscription to cancel.', 404);
      if (subscription.renewalCanceled) return;
      if (!subscription.firstChargeId) throw new AppError('subscription_needs_review', 'The initial payment has not arrived. Contact support.', 409);
      const result = await telegramClient.editUserStarSubscription({ user_id: subscription.payerId, telegram_payment_charge_id: subscription.firstChargeId, is_canceled: true });
      if (result !== true) throw new AppError('cancellation_failed', 'Telegram did not confirm cancellation.', 502);
      await tx.put('subscriptions', { ...subscription, renewalCanceled: true, renewalState: 'canceled' as const, canceledAt: this.now() });
      await this.event(tx, 'cancellation', { userId: actor.userId }, { state: 'applied', workspaceId: actor.workspaceId, chargeId: subscription.firstChargeId });
    });
    return this.status(actor);
  }
  private async syncPeriod(tx: Tx, period: UsagePeriod, at: string) {
    const rows = await tx.list<UsageReservation>('reservations', { workspaceId: period.workspaceId, periodId: period.id });
    const ledger = await tx.list<UsageLedger>('ledger', { workspaceId: period.workspaceId, periodId: period.id });
    await tx.put('usagePeriods', { ...period, used: ledger.length, reserved: rows.filter(r => activeReservation(r, at)).length });
  }
  async reserveUsage(tx: Tx, workspaceId: string, deliveryId: string, at?: TimestampInput, expiresAt?: TimestampInput): Promise<ReserveUsageResult> {
    const now = this.now(at);
    const entitlement = await this.calculate(tx, workspaceId, now);
    const ledger = await tx.get<UsageLedger>('ledger', key('usage-ledger', workspaceId, deliveryId));
    if (ledger) return { ok: true, reservationId: ledger.reservationId, periodId: ledger.periodId, alreadyCommitted: true };
    const existing = await tx.list<UsageReservation>('reservations', { workspaceId, deliveryId });
    const held = existing.find(r => activeReservation(r, now));
    if (held) return { ok: true, reservationId: held.id, periodId: held.periodId, unknown: held.state === 'unknown' };
    for (const expired of existing.filter(r => r.state === 'held')) {
      await tx.put('reservations', { ...expired, state: 'released' as const, releasedAt: now });
      const period = await tx.get<UsagePeriod>('usagePeriods', expired.periodId);
      if (period) await this.syncPeriod(tx, period, now);
    }
    if (entitlement.remaining <= 0) return { ok: false, periodId: entitlement.periodId, reason: 'quota_exhausted' };
    const id = key('usage-reservation', workspaceId, deliveryId, entitlement.periodId);
    const expiration = expiresAt === undefined ? entitlement.periodEnd : new Date(Math.min(time(this.now(expiresAt)), time(entitlement.periodEnd))).toISOString();
    if (time(expiration) <= time(now)) throw new AppError('reservation_expired', 'The delivery reservation has expired.');
    const reservation: UsageReservation = { id, createdAt: now, workspaceId, deliveryId, periodId: entitlement.periodId, plan: entitlement.plan, periodEnd: entitlement.periodEnd, state: 'held', expiresAt: expiration };
    await tx.put('reservations', reservation);
    const period: UsagePeriod = await tx.get<UsagePeriod>('usagePeriods', entitlement.periodId) ?? { id: entitlement.periodId, createdAt: now, workspaceId, plan: entitlement.plan, startsAt: entitlement.periodStart, endsAt: entitlement.periodEnd, limit: entitlement.deliveryLimit, used: 0, reserved: 0 };
    await this.syncPeriod(tx, period, now);
    return { ok: true, reservationId: id, periodId: entitlement.periodId };
  }
  async commitUsage(tx: Tx, workspaceId: string, deliveryId: string, at?: TimestampInput): Promise<UsageReservation | undefined> {
    const now = this.now(at), ledgerId = key('usage-ledger', workspaceId, deliveryId);
    const ledger = await tx.get<UsageLedger>('ledger', ledgerId);
    if (ledger) return tx.get<UsageReservation>('reservations', ledger.reservationId);
    const rows = await tx.list<UsageReservation>('reservations', { workspaceId, deliveryId });
    // A confirmed send may arrive after the reservation expires. Charge its original period.
    const reservation = rows.filter(r => r.state === 'held' || r.state === 'unknown').sort((a,b) => time(b.createdAt) - time(a.createdAt))[0];
    if (!reservation) throw new AppError('reservation_required', 'Reserve delivery usage before committing it.', 409);
    const committed: UsageReservation = { ...reservation, state: 'committed', committedAt: now };
    await tx.put('reservations', committed);
    await tx.put<UsageLedger>('ledger', { id: ledgerId, createdAt: now, workspaceId, deliveryId, periodId: reservation.periodId, reservationId: reservation.id, committedAt: now });
    const period = await tx.get<UsagePeriod>('usagePeriods', reservation.periodId);
    if (period) await this.syncPeriod(tx, period, now);
    return committed;
  }
  async releaseUsage(tx: Tx, workspaceId: string, deliveryId: string, options: ReleaseUsageOptions = {}): Promise<UsageReservation | undefined> {
    const now = this.now(options.at);
    const rows = await tx.list<UsageReservation>('reservations', { workspaceId, deliveryId });
    const reservation = rows.filter(r => r.state === 'held' || r.state === 'unknown').sort((a,b) => time(b.createdAt) - time(a.createdAt))[0];
    if (!reservation) return rows.find(r => r.state === 'committed');
    const updated: UsageReservation = options.preserveUnknown ? { ...reservation, state: 'unknown', unknownAt: now } : { ...reservation, state: 'released', releasedAt: now };
    await tx.put('reservations', updated);
    const period = await tx.get<UsagePeriod>('usagePeriods', reservation.periodId);
    if (period) await this.syncPeriod(tx, period, now);
    return updated;
  }
}
