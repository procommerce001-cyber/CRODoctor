import { API_BASE, apiHeaders } from '@/lib/api';

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

interface LineItemResult {
  title: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  touched: boolean;
  credited: number;
  reason: string;
  executionIds: string[];
  untrackedInjectDetected: boolean;
}

interface QAOrder {
  orderId: string;
  orderNumber: number;
  totalPrice: number;
  currency: string;
  createdAt: string;
  lineItems: LineItemResult[];
}

interface QAResponse {
  _qa: boolean;
  isTestBatch: boolean;
  testBatchReason: string | null;
  untrackedProducts: string[];
  summary: {
    ordersChecked: number;
    totalChecked: number;
    totalCredited: number;
    totalUncredited: number;
    pctCredited: number;
    ordersWithTouch: number;
    ordersWithoutTouch: number;
  };
  orders: QAOrder[];
}

export default async function InternalQAPage() {
  if (!SHOP) {
    return <div style={s.error}>NEXT_PUBLIC_SHOP is not configured.</div>;
  }

  let data: QAResponse | null = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(`${API_BASE}/debug/order-qa?shop=${SHOP}`, {
      headers: apiHeaders(),
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      fetchError = body.error ?? `HTTP ${res.status}`;
    } else {
      data = await res.json() as QAResponse;
    }
  } catch (err) {
    fetchError = String(err);
  }

  if (fetchError) {
    return (
      <div style={s.page}>
        <Banner type="error">[QA] Failed to load: {fetchError}</Banner>
        <p style={s.hint}>Is the API running with NODE_ENV !== production?</p>
      </div>
    );
  }

  if (!data) return null;

  const { summary, orders, isTestBatch, testBatchReason, untrackedProducts } = data;
  const cur = orders[0]?.currency ?? 'EUR';

  return (
    <div style={s.page}>
      <div style={s.topBadge}>INTERNAL QA — NOT FOR MERCHANTS</div>
      <h2 style={s.heading}>Order QA Verification</h2>
      <p style={s.sub}>Newest {summary.ordersChecked} synced orders · {SHOP}</p>

      {isTestBatch && (
        <Banner type="warn">
          TEST BATCH DETECTED — {testBatchReason}. Do not use these figures as proof of customer value.
        </Banner>
      )}

      {untrackedProducts.length > 0 && (
        <Banner type="warn">
          Untracked product modification: {untrackedProducts.join(', ')}. Body was changed outside the ContentExecution flow.
        </Banner>
      )}

      <p style={s.basisNote}>
        Totals are line-item subtotals (unit price × qty). Tax, shipping, and line-item discounts are excluded.
        The order total shown in each row header is Shopify&apos;s full order total and will not match.
      </p>

      <div style={s.summaryGrid}>
        <Stat label="Total checked" value={`${cur} ${summary.totalChecked.toFixed(2)}`} />
        <Stat label="Credited (touched)" value={`${cur} ${summary.totalCredited.toFixed(2)}`} accent="#16a34a" />
        <Stat label="Uncredited" value={`${cur} ${summary.totalUncredited.toFixed(2)}`} accent="#dc2626" />
        <Stat label="% credited" value={`${summary.pctCredited}%`} />
        <Stat label="Orders w/ touch" value={`${summary.ordersWithTouch} / ${summary.ordersChecked}`} />
        <Stat label="Orders untouched only" value={`${summary.ordersWithoutTouch} / ${summary.ordersChecked}`} />
      </div>

      {orders.map(order => (
        <div key={order.orderId} style={s.orderCard}>
          <div style={s.orderHeader}>
            <span style={s.orderNum}>#{order.orderNumber}</span>
            <span style={s.orderMeta}>
              {new Date(order.createdAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
            </span>
            <span style={s.orderTotal}>{order.currency} {order.totalPrice.toFixed(2)}</span>
          </div>
          <table style={s.table}>
            <thead>
              <tr>
                {['Product', 'Qty', 'Unit', 'Line total', 'Touched', 'Credited', 'Reason'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {order.lineItems.map((li, i) => (
                <tr
                  key={i}
                  style={{
                    background: li.untrackedInjectDetected
                      ? '#fef9c3'
                      : li.touched
                        ? '#f0fdf4'
                        : '#fafafa',
                  }}
                >
                  <td style={s.td}>
                    {li.title}
                    {li.untrackedInjectDetected && (
                      <span style={s.warnBadge}>untracked inject</span>
                    )}
                  </td>
                  <td style={s.tdCenter}>{li.quantity}</td>
                  <td style={s.tdRight}>{li.unitPrice.toFixed(2)}</td>
                  <td style={s.tdRight}>{li.lineTotal.toFixed(2)}</td>
                  <td style={{ ...s.tdCenter, color: li.touched ? '#16a34a' : '#9ca3af', fontWeight: 600 }}>
                    {li.touched ? 'YES' : 'NO'}
                  </td>
                  <td style={{ ...s.tdRight, color: li.credited > 0 ? '#16a34a' : '#9ca3af', fontWeight: 600 }}>
                    {li.credited.toFixed(2)}
                  </td>
                  <td style={{ ...s.td, fontSize: 11, color: '#6b7280' }}>{li.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <p style={s.footer}>
        This page is only reachable when NODE_ENV !== production.
        It reads from <code>/debug/order-qa</code> and does not write to or alter any merchant-facing metric.
      </p>
    </div>
  );
}

function Banner({ type, children }: { type: 'warn' | 'error'; children: React.ReactNode }) {
  const isWarn = type === 'warn';
  return (
    <div style={{
      background: isWarn ? '#fef3c7' : '#fee2e2',
      border: `1px solid ${isWarn ? '#fcd34d' : '#fca5a5'}`,
      borderRadius: 8,
      padding: '10px 16px',
      marginBottom: 16,
      fontSize: 13,
      color: isWarn ? '#92400e' : '#991b1b',
      fontWeight: 600,
    }}>
      {children}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={s.statCard}>
      <div style={{ ...s.statValue, color: accent ?? '#111827' }}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page:        { maxWidth: 960, margin: '0 auto', padding: '24px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#111827' },
  topBadge:    { display: 'inline-block', background: '#1e3a5f', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', padding: '3px 10px', borderRadius: 4, marginBottom: 12 },
  heading:     { fontSize: 20, fontWeight: 700, margin: '0 0 4px 0' },
  sub:         { fontSize: 13, color: '#6b7280', marginBottom: 20, marginTop: 0 },
  hint:        { fontSize: 13, color: '#6b7280' },
  error:       { padding: 32, color: '#dc2626', fontFamily: 'sans-serif', fontSize: 14 },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 28 },
  statCard:    { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px' },
  statValue:   { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  statLabel:   { fontSize: 11, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' },
  orderCard:   { marginBottom: 24, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' },
  orderHeader: { display: 'flex', gap: 16, alignItems: 'center', background: '#f9fafb', padding: '10px 16px', borderBottom: '1px solid #e5e7eb' },
  orderNum:    { fontWeight: 700, fontSize: 15 },
  orderMeta:   { fontSize: 12, color: '#9ca3af', flex: 1 },
  orderTotal:  { fontWeight: 700, fontSize: 14 },
  table:       { width: '100%', borderCollapse: 'collapse' },
  th:          { padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb', textAlign: 'left' },
  td:          { padding: '8px 12px', fontSize: 13, borderBottom: '1px solid #f3f4f6' },
  tdCenter:    { padding: '8px 12px', fontSize: 13, borderBottom: '1px solid #f3f4f6', textAlign: 'center' },
  tdRight:     { padding: '8px 12px', fontSize: 13, borderBottom: '1px solid #f3f4f6', textAlign: 'right' },
  warnBadge:   { fontSize: 10, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 4, marginLeft: 6, fontWeight: 700 },
  basisNote:   { fontSize: 11, color: '#9ca3af', marginBottom: 12, marginTop: -8 },
  footer:      { fontSize: 11, color: '#d1d5db', marginTop: 32, textAlign: 'center' },
};
