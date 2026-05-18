'use client';

import { useEffect, useState } from 'react';
import { fetchMeasurementReadyDigest, type MeasurementReadyDigestData, type MeasurementReadyDigestItem } from '@/lib/api';

const MAX_SHOWN = 3;

export default function MeasurementReadyDigest({ shop }: { shop: string }) {
  const [data, setData] = useState<MeasurementReadyDigestData | null>(null);

  useEffect(() => {
    fetchMeasurementReadyDigest(shop).then(setData);
  }, [shop]);

  if (!data || data.count === 0) return null;

  const shown    = data.items.slice(0, MAX_SHOWN);
  const overflow = data.count - shown.length;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.badge}>{data.count}</span>
        <span style={styles.heading}>
          {data.count === 1
            ? '1 change is ready for review'
            : `${data.count} changes are ready for review`}
        </span>
      </div>
      <p style={styles.subheading}>
        Their 7-day measurement windows have closed — see what happened and decide the next move.
      </p>
      <ul style={styles.list}>
        {shown.map(item => (
          <li key={item.executionId} style={styles.row}>
            <span style={styles.title}>{item.productTitle ?? 'Unknown product'}</span>
            <span style={signalStyle(item)}>{item.nextActionLabel}</span>
          </li>
        ))}
        {overflow > 0 && (
          <li style={{ ...styles.row, opacity: 0.6 }}>
            <span style={styles.title}>+{overflow} more</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function signalStyle(item: MeasurementReadyDigestItem): React.CSSProperties {
  if (item.confidence === 'insufficient') return { ...styles.label, ...styles.labelGrey };
  switch (item.decisionSignal) {
    case 'rollback_candidate': return { ...styles.label, ...styles.labelAmber };
    case 'revise':             return { ...styles.label, ...styles.labelYellow };
    case 'keep':               return { ...styles.label, ...styles.labelGreen };
    default:                   return { ...styles.label, ...styles.labelGrey };
  }
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background:   '#fff',
    borderRadius: 12,
    border:       '1.5px solid #e8edff',
    padding:      '16px 20px',
  },
  header: {
    display:      'flex',
    alignItems:   'center',
    gap:          10,
    marginBottom: 4,
  },
  badge: {
    background:   '#f59e0b',
    color:        '#fff',
    borderRadius: 20,
    padding:      '2px 10px',
    fontSize:     13,
    fontWeight:   700,
    lineHeight:   '20px',
    flexShrink:   0,
  },
  heading: {
    fontWeight: 600,
    fontSize:   15,
    color:      '#1a1a2e',
  },
  subheading: {
    fontSize:   13,
    color:      '#666',
    margin:     '0 0 12px',
    lineHeight: 1.4,
  },
  list: {
    margin:        0,
    padding:       0,
    listStyle:     'none',
    display:       'flex',
    flexDirection: 'column',
    gap:           8,
  },
  row: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            8,
  },
  title: {
    fontSize: 13,
    color:    '#222',
    flex:     1,
  },
  label: {
    fontSize:     12,
    borderRadius: 6,
    padding:      '2px 8px',
    fontWeight:   500,
    flexShrink:   0,
    whiteSpace:   'nowrap' as const,
  },
  labelGreen:  { background: '#ecfdf5', color: '#065f46' },
  labelAmber:  { background: '#fff7ed', color: '#9a3412' },
  labelYellow: { background: '#fef3c7', color: '#b45309' },
  labelGrey:   { background: '#f3f4f6', color: '#374151' },
};
