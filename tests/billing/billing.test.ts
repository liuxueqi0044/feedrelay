import { describe, expect, it, vi } from 'vitest';
import { BillingService, PLAN_LIMITS, SUBSCRIPTION_PERIOD_SECONDS, type BillingOptions, type PaymentInput, type UsageReservation } from '../../packages/billing/src/index.js';
import type { Actor, Entity, Filter, ListOptions, Store, Table, Tx, Workspace } from '../../packages/core/src/index.js';

class MemoryStore implements Store {
  private rows = new Map<Table, Map<string, Entity>>();
  private pending: Promise<unknown> = Promise.resolve();
  private tx(): Tx {
    return {
      get: async <T extends Entity>(table: Table, id: string) => structuredClone(this.rows.get(table)?.get(id)) as T | undefined,
      list: async <T extends Entity>(table: Table, filter: Filter = {}, options: ListOptions = {}) => {
        let rows = [...(this.rows.get(table)?.values() ?? [])].filter(row => Object.entries(filter).every(([name, value]) => {
          const actual = (row as unknown as Record<string, unknown>)[name];
          if (value && typeof value === 'object') return Object.entries(value).every(([operation, expected]) => operation === 'in' ? (expected as unknown[]).includes(actual) : operation === 'ne' ? actual !== expected : operation === 'lt' ? (actual as string) < (expected as string) : operation === 'lte' ? (actual as string) <= (expected as string) : operation === 'gt' ? (actual as string) > (expected as string) : (actual as string) >= (expected as string));
          return actual === value;
        }));
        if (options.orderBy) rows.sort((a,b) => String((a as unknown as Record<string, unknown>)[options.orderBy!]).localeCompare(String((b as unknown as Record<string, unknown>)[options.orderBy!])) * (options.direction === 'desc' ? -1 : 1));
        if (options.limit !== undefined) rows = rows.slice(0, options.limit);
        return structuredClone(rows) as T[];
      },
      put: async <T extends Entity>(table: Table, value: T) => { if (!this.rows.has(table)) this.rows.set(table, new Map()); this.rows.get(table)!.set(value.id, structuredClone(value)); },
      remove: async (table, id) => { this.rows.get(table)?.delete(id); },
    };
  }
  transaction<T>(_keys: string[], callback: (tx: Tx) => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => { const backup = structuredClone(this.rows); try { return await callback(this.tx()); } catch (error) { this.rows = backup; throw error; } });
    this.pending = result.catch(() => undefined); return result;
  }
  read<T>(callback: (tx: Tx) => Promise<T>) { return this.pending.then(() => callback(this.tx())); }
  async close() {}
}
const START = '2026-01-01T00:00:00.000Z';
const ms = (days: number) => days * 86_400_000;
const after = (days: number) => new Date(Date.parse(START) + ms(days)).toISOString();
const seconds = (date: string) => Date.parse(date) / 1_000;
const actor: Actor = { userId: 'u1', workspaceId: 'w1', telegramId: '12345' };
async function fixture(options: Partial<BillingOptions> = {}) {
  const store = new MemoryStore();
  let now = START;
  const workspace: Workspace = { id: actor.workspaceId, createdAt: START, name: 'Test', ownerId: actor.userId, state: 'active', freeAnchor: START, version: 1 };
  await store.transaction([], tx => tx.put('workspaces', workspace));
  const billing = new BillingService(store, { botId: 'bot1', billingEnabled: true, priceStars: 100, termsUrl: 'https://example.com/terms', supportContact: '@feedrelay_support', clock: () => now, ...options });
  return { store, billing, setNow: (value: string) => { now = value; }, run: <T>(fn: (tx: Tx) => Promise<T>) => store.transaction(['workspace:w1'], fn) };
}
async function receipt(f: Awaited<ReturnType<typeof fixture>>, chargeId = 'charge1', start = 0, first = true): Promise<PaymentInput> {
  const checkout = await f.billing.checkout(actor, true);
  return { chargeId, payload: checkout.payload, payerId: actor.telegramId, currency: 'XTR', totalAmount: 100, paidAt: seconds(after(start)), expirationDate: seconds(after(start + 30)), isRecurring: true, isFirstRecurring: first };
}

describe('Stars receipts and entitlement intervals', () => {
  it('keeps billing disabled unless explicitly enabled with terms and support', async () => {
    for (const options of [{ billingEnabled: false }, { termsUrl: undefined }, { supportContact: '' }, { termsUrl: 'http://example.com/terms' }]) {
      const f = await fixture(options);
      expect(f.billing.billingEnabled).toBe(false);
      await expect(f.billing.checkout(actor, true)).rejects.toMatchObject({ code: 'billing_disabled' });
    }
  });
  it('uses one persisted opaque invoice and gates terms, payer, amount and repeated precheckout', async () => {
    const f = await fixture();
    await expect(f.billing.checkout(actor, false)).rejects.toMatchObject({ code: 'terms_required' });
    const invoices = await Promise.all([f.billing.checkout(actor, true, 'one'), f.billing.checkout(actor, true, 'two')]);
    expect(invoices[0]?.payload).toBe(invoices[1]?.payload);
    const checkout = invoices[0]!;
    expect(checkout.subscriptionPeriod).toBe(SUBSCRIPTION_PERIOD_SECONDS);
    expect(checkout.payload).not.toContain(actor.workspaceId);
    expect(await f.billing.validatePreCheckout(checkout.payload, 'wrong', 'XTR', 100)).toMatchObject({ ok: false });
    expect(await f.billing.validatePreCheckout(checkout.payload, actor.telegramId, 'USD', 100)).toMatchObject({ ok: false });
    expect(await f.billing.validatePreCheckout(checkout.payload, actor.telegramId, 'XTR', 99)).toMatchObject({ ok: false });
    expect(await f.billing.validatePreCheckout(checkout.payload, actor.telegramId, 'XTR', 100, 'q1')).toEqual({ ok: true });
    expect(await f.billing.validatePreCheckout(checkout.payload, actor.telegramId, 'XTR', 100, 'q1')).toEqual({ ok: true });
    expect(await f.billing.validatePreCheckout(checkout.payload, actor.telegramId, 'XTR', 100, 'q2')).toMatchObject({ ok: false });
  });
  it('grants from receipt expiration, accepts delayed events, and deduplicates charge IDs', async () => {
    const f = await fixture(); const payment = await receipt(f);
    f.setNow(after(20));
    expect(await f.billing.recordPayment(payment)).toMatchObject({ state: 'applied' });
    expect(await f.billing.recordPayment(payment)).toMatchObject({ state: 'duplicate' });
    expect(await f.billing.entitlements('w1')).toMatchObject({ plan: 'starter', periodStart: START, periodEnd: after(30), ...PLAN_LIMITS.starter });
    expect(await f.billing.recordPayment({ ...payment, totalAmount: 101 })).toMatchObject({ state: 'needs_review', reason: 'charge_id_conflict' });
    f.setNow(after(30));
    expect(await f.billing.entitlements('w1')).toMatchObject({ plan: 'free', periodStart: after(30), periodEnd: after(60) });
    await expect(f.billing.checkout(actor, true)).rejects.toMatchObject({ code: 'subscription_exists' });
  });
  it('accepts multiple recurring charges on one payload and out-of-order first payment', async () => {
    const f = await fixture(); const first = await receipt(f); const checkoutPayload = first.payload;
    const renewal: PaymentInput = { ...first, chargeId: 'renewal', paidAt: seconds(after(30)), expirationDate: seconds(after(60)), isFirstRecurring: false };
    expect(await f.billing.recordPayment(renewal)).toMatchObject({ state: 'applied' });
    expect(await f.billing.recordPayment(first)).toMatchObject({ state: 'applied' });
    f.setNow(after(31));
    expect(await f.billing.entitlements('w1')).toMatchObject({ plan: 'starter', periodStart: after(30), periodEnd: after(60) });
    const status = await f.billing.status(actor);
    expect(status.subscription).toMatchObject({ payload: checkoutPayload, firstChargeId: 'charge1' });
    expect(await f.store.read(tx => tx.list('checkouts'))).toHaveLength(1);
  });
  it('keeps an early recurring charge anchored to its receipt interval', async () => {
    const f = await fixture(); const first = await receipt(f); await f.billing.recordPayment(first);
    expect(await f.billing.recordPayment({ ...first, chargeId: 'early-renewal', paidAt: seconds(after(29.5)), expirationDate: seconds(after(60)), isFirstRecurring: false })).toMatchObject({ state: 'applied' });
    f.setNow(after(31));
    expect(await f.billing.entitlements('w1')).toMatchObject({ plan: 'starter', periodStart: after(30), periodEnd: after(60) });
  });
  it('quarantines unknown, mismatched, malformed and overlapping receipts without granting access', async () => {
    const f = await fixture(); const first = await receipt(f);
    const invalid = [
      { ...first, chargeId: 'unknown', payload: 'alien' },
      { ...first, chargeId: 'payer', payerId: 'other' },
      { ...first, chargeId: 'amount', totalAmount: 999 },
      { ...first, chargeId: 'date', expirationDate: 'bad' },
      { ...first, chargeId: 'recurring', isRecurring: false },
    ];
    for (const payment of invalid) expect(await f.billing.recordPayment(payment)).toMatchObject({ state: 'needs_review' });
    expect((await f.billing.entitlements('w1')).plan).toBe('free');
    expect(await f.billing.recordPayment(first)).toMatchObject({ state: 'applied' });
    expect(await f.billing.recordPayment({ ...first, chargeId: 'overlap', isFirstRecurring: false })).toMatchObject({ state: 'needs_review', reason: 'overlapping_subscription_period' });
    expect(await f.billing.recordPayment({ ...first, chargeId: 'second-subscription', paidAt: seconds(after(30)), expirationDate: seconds(after(60)) })).toMatchObject({ state: 'needs_review', reason: 'duplicate_subscription' });
    expect(await f.store.read(tx => tx.list('billingEvents', { state: 'needs_review' }))).toHaveLength(7);
    expect(await f.store.read(tx => tx.list('grants'))).toHaveLength(1);
  });
  it('persists refund-before-payment and never activates its later receipt', async () => {
    const f = await fixture(); const payment = await receipt(f);
    expect(await f.billing.recordRefund({ chargeId: payment.chargeId, payload: payment.payload, payerId: payment.payerId, currency: 'XTR', totalAmount: 100 })).toMatchObject({ state: 'needs_review', reason: 'payment_not_received' });
    expect(await f.billing.recordPayment(payment)).toMatchObject({ state: 'applied' });
    expect((await f.billing.entitlements('w1')).plan).toBe('free');
    expect(await f.store.read(tx => tx.list('payments'))).toMatchObject([{ state: 'refunded' }]);
    expect(await f.store.read(tx => tx.list('grants'))).toMatchObject([{ state: 'revoked' }]);
    expect(await f.billing.recordRefund({ chargeId: payment.chargeId })).toMatchObject({ state: 'duplicate' });
  });
  it('removes only the refunded interval and detects a gap before a later paid interval', async () => {
    const f = await fixture(); const first = await receipt(f);
    await f.billing.recordPayment(first);
    await f.billing.recordPayment({ ...first, chargeId: 'month2', paidAt: seconds(after(30)), expirationDate: seconds(after(60)), isFirstRecurring: false });
    await f.billing.recordPayment({ ...first, chargeId: 'month3', paidAt: seconds(after(60)), expirationDate: seconds(after(90)), isFirstRecurring: false });
    expect((await f.billing.entitlements('w1')).paidUntil).toBe(after(90));
    await f.billing.recordRefund({ chargeId: 'month2' });
    expect((await f.billing.entitlements('w1')).paidUntil).toBe(after(30));
    f.setNow(after(45)); expect((await f.billing.entitlements('w1')).plan).toBe('free');
    f.setNow(after(75)); expect((await f.billing.entitlements('w1')).plan).toBe('starter');
  });
  it('does not accept a mismatched refund and preserves the valid payment', async () => {
    const f = await fixture(); const payment = await receipt(f); await f.billing.recordPayment(payment);
    expect(await f.billing.recordRefund({ chargeId: payment.chargeId, payerId: 'different' })).toMatchObject({ state: 'needs_review', reason: 'refund_receipt_mismatch' });
    expect((await f.billing.entitlements('w1')).plan).toBe('starter');
  });
  it('cancels renewal only after Telegram confirms and retains paid access', async () => {
    const f = await fixture(); await f.billing.recordPayment(await receipt(f));
    const editUserStarSubscription = vi.fn().mockResolvedValue(false);
    await expect(f.billing.cancelRenewal(actor, { editUserStarSubscription })).rejects.toMatchObject({ code: 'cancellation_failed' });
    expect((await f.billing.status(actor)).renewalCanceled).toBe(false);
    editUserStarSubscription.mockResolvedValue(true);
    expect(await f.billing.cancelRenewal(actor, { editUserStarSubscription })).toMatchObject({ plan: 'starter', renewalCanceled: true, paidUntil: after(30) });
    expect(editUserStarSubscription).toHaveBeenLastCalledWith({ user_id: actor.telegramId, telegram_payment_charge_id: 'charge1', is_canceled: true });
    await f.billing.cancelRenewal(actor, { editUserStarSubscription });
    expect(editUserStarSubscription).toHaveBeenCalledTimes(2);
  });
  it('records Telegram-side cancellation, failed renewal and reactivation without revoking a paid period', async () => {
    const f = await fixture(); const payment = await receipt(f); await f.billing.recordPayment(payment);
    expect(await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'canceled', updateId: '100' })).toMatchObject({ state: 'applied' });
    expect(await f.billing.status(actor)).toMatchObject({ plan: 'starter', renewalCanceled: true, subscription: { renewalState: 'canceled' } });
    expect(await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'canceled', updateId: 100 })).toMatchObject({ state: 'duplicate' });
    expect(await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'active', updateId: 99 })).toMatchObject({ state: 'duplicate', reason: 'stale_subscription_update' });
    expect(await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'active', updateId: 101 })).toMatchObject({ state: 'applied' });
    expect(await f.billing.status(actor)).toMatchObject({ plan: 'starter', renewalCanceled: false });
    await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'failed', updateId: 102 });
    expect(await f.billing.status(actor)).toMatchObject({ plan: 'starter', subscription: { renewalState: 'failed' } });
    f.setNow(after(30)); expect((await f.billing.entitlements('w1')).plan).toBe('free');
  });
  it('preserves a cancellation that arrives before its first payment and quarantines unknown subscription updates', async () => {
    const f = await fixture(); const payment = await receipt(f);
    await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'canceled', updateId: 1 });
    expect(await f.billing.recordPayment(payment)).toMatchObject({ state: 'applied' });
    expect(await f.billing.status(actor)).toMatchObject({ plan: 'starter', renewalCanceled: true, subscription: { firstChargeId: payment.chargeId } });
    expect(await f.billing.recordSubscriptionUpdate({ payload: 'alien', payerId: payment.payerId, state: 'active' })).toMatchObject({ state: 'needs_review', reason: 'unknown_invoice' });
    expect(await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: 'alien', state: 'active' })).toMatchObject({ state: 'needs_review', reason: 'subscription_payer_mismatch' });
  });
  it('keeps subscription state when a lower update ID has ambiguous ordering after a long gap', async () => {
    const f = await fixture(); const payment = await receipt(f); await f.billing.recordPayment(payment);
    await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'canceled', updateId: '100' });
    f.setNow(after(9));
    expect(await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'active', updateId: '2' })).toMatchObject({ state: 'needs_review', reason: 'subscription_update_order_uncertain' });
    expect((await f.billing.status(actor)).renewalCanceled).toBe(true);
  });
  it.each(['deleting', 'deleted'] as const)('journals payment and cancellation facts for a %s workspace while denying access', async state => {
    const f = await fixture(); const first = await receipt(f);
    // A renewal may precede the initial receipt, so deletion lacks its cancellation charge ID.
    await f.billing.recordPayment({ ...first, chargeId: 'renewal-before-first', paidAt: seconds(after(30)), expirationDate: seconds(after(60)), isFirstRecurring: false });
    await f.store.transaction(['workspace:w1'], async tx => {
      const workspace = (await tx.get<Workspace>('workspaces', 'w1'))!;
      await tx.put('workspaces', { ...workspace, state });
    });
    expect(await f.billing.recordPayment(first)).toMatchObject({ state: 'applied', workspaceId: 'w1' });
    expect(await f.billing.recordSubscriptionUpdate({ payload: first.payload, payerId: first.payerId, state: 'canceled', updateId: '500' })).toMatchObject({ state: 'applied', workspaceId: 'w1' });
    expect(await f.store.read(tx => tx.list('subscriptions', { workspaceId: 'w1' }))).toMatchObject([{ firstChargeId: first.chargeId, renewalCanceled: true }]);
    expect(await f.store.read(tx => tx.list('payments', { chargeId: first.chargeId }))).toMatchObject([{ state: 'applied' }]);
    await expect(f.billing.entitlements('w1')).rejects.toMatchObject({ code: 'workspace_forbidden' });
    await expect(f.billing.status(actor)).rejects.toMatchObject({ code: 'workspace_forbidden' });
    await expect(f.billing.checkout(actor, true)).rejects.toMatchObject({ code: 'workspace_forbidden' });
    expect(await f.billing.recordRefund({ chargeId: first.chargeId })).toMatchObject({ state: 'applied' });
    expect(await f.store.read(tx => tx.list('grants', { chargeId: first.chargeId }))).toMatchObject([{ state: 'revoked' }]);
  });
  it('rejects receipt and subscription mapping after workspace ownership changes', async () => {
    const f = await fixture(); const payment = await receipt(f);
    await f.store.transaction(['workspace:w1'], async tx => {
      const workspace = (await tx.get<Workspace>('workspaces', 'w1'))!;
      await tx.put('workspaces', { ...workspace, ownerId: 'different-owner', state: 'deleting' });
    });
    expect(await f.billing.recordPayment(payment)).toMatchObject({ state: 'needs_review', reason: 'workspace_unavailable' });
    expect(await f.billing.recordSubscriptionUpdate({ payload: payment.payload, payerId: payment.payerId, state: 'canceled', updateId: '501' })).toMatchObject({ state: 'needs_review', reason: 'workspace_unavailable' });
    expect(await f.store.read(tx => tx.list('subscriptions'))).toHaveLength(0);
    expect(await f.store.read(tx => tx.list('grants'))).toHaveLength(0);
  });
});

describe('delivery reservations and downgrade quota', () => {
  it('holds quota per logical delivery, commits once, and cannot release committed usage', async () => {
    const f = await fixture();
    const first = await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'delivery1'));
    expect(await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'delivery1'))).toMatchObject({ ok: true, reservationId: first.reservationId });
    expect(await f.billing.entitlements('w1')).toMatchObject({ used: 0, reserved: 1, remaining: 199 });
    await f.run(tx => f.billing.commitUsage(tx, 'w1', 'delivery1'));
    await f.run(tx => f.billing.commitUsage(tx, 'w1', 'delivery1'));
    await f.run(tx => f.billing.releaseUsage(tx, 'w1', 'delivery1'));
    expect(await f.billing.entitlements('w1')).toMatchObject({ used: 1, reserved: 0, remaining: 199 });
    f.setNow(after(31));
    expect(await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'delivery1'))).toMatchObject({ alreadyCommitted: true, periodId: first.periodId });
    expect(await f.billing.entitlements('w1')).toMatchObject({ used: 0, reserved: 0, remaining: 200 });
  });
  it('enforces Free quota across concurrent attempts and recovers definitively released quota', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 201 }, (_,i) => f.run(tx => f.billing.reserveUsage(tx, 'w1', `d${i}`))));
    expect(results.filter(result => result.ok)).toHaveLength(200);
    expect(results[200]).toMatchObject({ ok: false, reason: 'quota_exhausted' });
    await f.run(tx => f.billing.releaseUsage(tx, 'w1', 'd0'));
    expect(await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'd200'))).toMatchObject({ ok: true });
    expect((await f.billing.entitlements('w1')).remaining).toBe(0);
  });
  it('expires unattempted holds but preserves unknown outcomes until explicit resolution', async () => {
    const f = await fixture();
    await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'expired', START, after(1)));
    const uncertain = await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'unknown', START, after(1)));
    await f.run(tx => f.billing.releaseUsage(tx, 'w1', 'unknown', { preserveUnknown: true }));
    f.setNow(after(2));
    expect(await f.billing.entitlements('w1')).toMatchObject({ reserved: 1, remaining: 199 });
    expect(await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'unknown'))).toMatchObject({ reservationId: uncertain.reservationId, unknown: true });
    await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'expired'));
    expect(await f.billing.entitlements('w1')).toMatchObject({ reserved: 2 });
    f.setNow(after(31));
    expect(await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'unknown'))).toMatchObject({ reservationId: uncertain.reservationId, periodId: uncertain.periodId, unknown: true });
    await f.run(tx => f.billing.commitUsage(tx, 'w1', 'unknown'));
    expect(await f.billing.entitlements('w1')).toMatchObject({ used: 0, reserved: 0 });
    const rows = await f.store.read(tx => tx.list<UsageReservation>('reservations', { deliveryId: 'unknown' }));
    expect(rows).toMatchObject([{ state: 'committed', periodId: uncertain.periodId }]);
  });
  it('keeps the original free anchor and used quota through an upgrade, refund and relogin', async () => {
    const f = await fixture();
    f.setNow(after(3)); await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'before-upgrade')); await f.run(tx => f.billing.commitUsage(tx, 'w1', 'before-upgrade'));
    const payment = await receipt(f, 'upgrade', 3); await f.billing.recordPayment(payment);
    await f.run(tx => f.billing.reserveUsage(tx, 'w1', 'paid-delivery')); await f.run(tx => f.billing.commitUsage(tx, 'w1', 'paid-delivery'));
    expect(await f.billing.entitlements('w1')).toMatchObject({ plan: 'starter', used: 1 });
    f.setNow(after(10)); await f.billing.recordRefund({ chargeId: 'upgrade' });
    expect(await f.billing.status({ ...actor })).toMatchObject({ plan: 'free', periodStart: START, periodEnd: after(30), used: 1, remaining: 199 });
    expect((await f.store.read(tx => tx.get<Workspace>('workspaces', 'w1')))?.freeAnchor).toBe(START);
  });
  it('requires reservations before charging and validates expired reservation deadlines', async () => {
    const f = await fixture();
    await expect(f.run(tx => f.billing.commitUsage(tx, 'w1', 'unreserved'))).rejects.toMatchObject({ code: 'reservation_required' });
    await expect(f.run(tx => f.billing.reserveUsage(tx, 'w1', 'expired', after(1), START))).rejects.toMatchObject({ code: 'reservation_expired' });
  });
});
