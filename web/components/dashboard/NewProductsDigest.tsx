'use client';

import { useEffect, useState } from 'react';
import { fetchNewProductsDigest, type NewProductsDigestData } from '@/lib/api';

const MAX_TITLES = 3;

export default function NewProductsDigest({ shop }: { shop: string }) {
  const [data, setData] = useState<NewProductsDigestData | null>(null);

  useEffect(() => {
    fetchNewProductsDigest(shop).then(setData);
  }, [shop]);

  if (!data || data.count === 0) return null;

  const shown    = data.products.slice(0, MAX_TITLES);
  const overflow = data.count - shown.length;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.badge}>{data.count}</span>
        <span style={styles.heading}>
          {data.count === 1
            ? 'New product added this month'
            : `${data.count} new products added this month`}
        </span>
      </div>
      <p style={styles.body}>
        {data.count === 1
          ? "This product hasn't been reviewed in CRODoctor yet — fresh optimization work is ready."
          : "These haven't been reviewed in CRODoctor yet — fresh optimization work is ready."}
      </p>
      <ul style={styles.list}>
        {shown.map(p => (
          <li key={p.id} style={styles.chip}>{p.title}</li>
        ))}
        {overflow > 0 && (
          <li style={{ ...styles.chip, opacity: 0.6 }}>+{overflow} more</li>
        )}
      </ul>
    </div>
  );
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
    marginBottom: 6,
  },
  badge: {
    background:   '#4361ee',
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
  body: {
    fontSize:   14,
    color:      '#555',
    margin:     '0 0 10px',
    lineHeight: 1.5,
  },
  list: {
    margin:    0,
    padding:   0,
    listStyle: 'none',
    display:   'flex',
    flexWrap:  'wrap',
    gap:       6,
  },
  chip: {
    background:   '#f4f6ff',
    borderRadius: 6,
    padding:      '3px 10px',
    fontSize:     13,
    color:        '#333',
  },
};
