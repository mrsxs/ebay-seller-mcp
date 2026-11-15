// 财务（eBay Sell Finances API，只读）：资金概况、交易明细（含费用拆分）、回款。
// 交易里带买家用户名、回款里带银行卡后四位和备注名：一律不输出。
export const FIN_DAYS = [7, 14, 30, 60, 90];
export const TX_TYPES = ['SALE', 'REFUND', 'CREDIT', 'DISPUTE', 'NON_SALE_CHARGE', 'SHIPPING_LABEL', 'TRANSFER', 'ADJUSTMENT', 'WITHDRAWAL', 'LOAN_REPAYMENT', 'PURCHASE'];
/** transaction_summary 要按资金状态分别查，加起来才是这段时间的全部 */
export const TX_STATUSES = ['PAYOUT', 'FUNDS_AVAILABLE_FOR_PAYOUT', 'FUNDS_PROCESSING', 'FUNDS_ON_HOLD', 'COMPLETED', 'FAILED'];

const num = (v) => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
};
const money = (m) => (m && m.value !== undefined ? { value: num(m.value), currency: m.currency ?? null } : null);
const round = (n) => Math.round(n * 100) / 100;

export const sinceIso = (days, now = Date.now()) => new Date(now - days * 24 * 3600_000).toISOString();

export function transactionsPath({ days = 30, type, limit = 50, offset = 0, now = Date.now() }) {
  const parts = [`transactionDate:[${sinceIso(days, now)}..]`];
  if (type) parts.push(`transactionType:{${type}}`);
  return `/sell/finances/v1/transaction?${new URLSearchParams({ filter: parts.join(','), limit: String(limit), offset: String(offset) })}`;
}

/** 一笔交易：金额、借贷方向、状态、关联订单、费用拆分；不带买家信息 */
export function parseTransaction(t) {
  const fees = (t.orderLineItems ?? []).flatMap((l) => (l.marketplaceFees ?? []).map((f) => ({ type: f.feeType ?? null, amount: money(f.amount), memo: f.feeMemo ?? null })));
  const refs = (t.references ?? []).map((r) => ({ type: r.referenceType ?? null, id: r.referenceId ?? null }));
  return {
    transaction_id: t.transactionId ?? null,
    date: t.transactionDate ?? null,
    type: t.transactionType ?? null,
    booking: t.bookingEntry ?? null,
    status: t.transactionStatus ?? null,
    amount: money(t.amount),
    order_id: t.orderId ?? refs.find((r) => r.type === 'ORDER_ID')?.id ?? null,
    fee_type: t.feeType ?? null,
    total_fee: money(t.totalFeeAmount),
    fees,
    memo: t.transactionMemo ?? null,
    references: refs.filter((r) => r.type !== 'ORDER_ID'),
  };
}

/** 这一页交易的汇总：按类型和借贷方向的笔数、金额；费用按费用类型合计（净额：扣的费减去退款退回的费） */
export function summarizeTransactions(list) {
  const byType = {};
  const fees = {};
  for (const t of list) {
    const k = `${t.type}/${t.booking}`;
    const cur = byType[k] ?? { type: t.type, booking: t.booking, count: 0, amount: 0, currency: t.amount?.currency ?? null };
    cur.count += 1;
    cur.amount = round(cur.amount + (t.amount?.value ?? 0));
    byType[k] = cur;
    // 退款交易里的费用是 eBay 退回的手续费（入账），要从费用合计里减掉
    const sign = t.type === 'REFUND' ? -1 : 1;
    for (const f of t.fees) if (f.amount?.value !== null && f.amount?.value !== undefined) fees[f.type ?? '?'] = round((fees[f.type ?? '?'] ?? 0) + sign * Math.abs(f.amount.value));
    if (t.type === 'NON_SALE_CHARGE' && t.fee_type && t.amount?.value !== null) fees[t.fee_type] = round((fees[t.fee_type] ?? 0) + (t.booking === 'CREDIT' ? -1 : 1) * t.amount.value);
  }
  return { transactions: list.length, by_type: Object.values(byType), fees_by_type: fees };
}

/**
 * 几个资金状态的 transaction_summary 加起来：这段时间各类交易的笔数，入账（credit）和扣款（debit）分开合计，net = 入账 − 扣款。
 * credits 是 eBay 的「入账」类：销售之外也包括卖家补偿等其他入账，不完全等于销售额（销售明细看 ebay_transactions type=SALE）。
 */
export function mergeTransactionSummaries(list) {
  const out = {};
  const add = (key, count, amount, booking) => {
    if (count === undefined && !amount) return;
    const cur = out[key] ?? { count: 0, credit: 0, debit: 0, net: 0, currency: amount?.currency ?? null };
    cur.count += Number(count ?? 0);
    if (amount?.value !== undefined) {
      const v = Math.abs(Number(amount.value));
      if (booking === 'DEBIT') cur.debit = round(cur.debit + v);
      else cur.credit = round(cur.credit + v);
      cur.net = round(cur.credit - cur.debit);
    }
    cur.currency ??= amount?.currency ?? null;
    out[key] = cur;
  };
  for (const s of list) {
    add('credits', s.creditCount, s.creditAmount, s.creditBookingEntry ?? 'CREDIT');
    add('refunds', s.refundCount, s.refundAmount, s.refundBookingEntry ?? 'DEBIT');
    add('non_sale_charges', s.nonSaleChargeCount, s.nonSaleChargeAmount, s.nonSaleChargeBookingEntry ?? 'DEBIT');
    add('shipping_labels', s.shippingLabelCount, s.shippingLabelAmount, s.shippingLabelBookingEntry ?? 'DEBIT');
    add('disputes', s.disputeCount, s.disputeAmount, s.disputeBookingEntry ?? 'DEBIT');
    add('transfers', s.transferCount, s.transferAmount, s.transferBookingEntry);
    add('adjustments', s.adjustmentCount, s.adjustmentAmount, s.adjustmentBookingEntry);
    add('on_hold', s.onHoldCount, s.onHoldAmount, s.onHoldBookingEntry ?? 'CREDIT');
  }
  return out;
}

export function parseFunds(j) {
  return { total: money(j.totalFunds), available: money(j.availableFunds), processing: money(j.processingFunds), on_hold: money(j.fundsOnHold) };
}

export function payoutsPath({ days = 30, limit = 50, offset = 0, now = Date.now() }) {
  return `/sell/finances/v1/payout?${new URLSearchParams({ filter: `payoutDate:[${sinceIso(days, now)}..]`, limit: String(limit), offset: String(offset) })}`;
}

/** 回款：不带银行卡后四位、卡备注名、银行参考号 */
export function parsePayout(p) {
  return {
    payout_id: p.payoutId ?? null,
    date: p.payoutDate ?? null,
    status: p.payoutStatus ?? null,
    status_description: p.payoutStatusDescription ?? null,
    amount: money(p.amount),
    converted: p.amount?.convertedToCurrency ? { value: num(p.amount.convertedToValue), currency: p.amount.convertedToCurrency, rate: num(p.amount.exchangeRate) } : null,
    transactions: num(p.transactionCount),
    fee: money(p.totalFee),
    instrument_type: p.payoutInstrument?.instrumentType ?? null,
  };
}
