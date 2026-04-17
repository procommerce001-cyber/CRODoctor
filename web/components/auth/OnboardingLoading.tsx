'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

const TIMEOUT_MS = 45_000;

type Phase =
  | 'connecting'    // 0 – 2 s  initial
  | 'syncing'       // 2 s+     once subscription is confirmed
  | 'success'       // COMPLETED received
  | 'timeout';      // 45 s elapsed with no COMPLETED

interface Props {
  storeId: string;
}

export default function OnboardingLoading({ storeId }: Props) {
  const router               = useRouter();
  const [phase, setPhase]    = useState<Phase>('connecting');
  const channelRef           = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const timeoutRef           = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Advance to "syncing" copy after a short delay so the first message
    // registers visually before we transition.
    const connectTimer = setTimeout(() => setPhase(p => p === 'connecting' ? 'syncing' : p), 2000);

    // Hard timeout — if COMPLETED hasn't arrived in 45 s, show fallback UI.
    timeoutRef.current = setTimeout(() => {
      setPhase(p => p === 'success' ? p : 'timeout');
    }, TIMEOUT_MS);

    // Subscribe to UPDATE events on the Store row for this storeId.
    const channel = supabase
      .channel(`store-onboarding-${storeId}`)
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'Store',
          filter: `id=eq.${storeId}`,
        },
        (payload) => {
          const next = (payload.new as { setupStatus?: string }).setupStatus;
          if (next === 'COMPLETED') {
            // Clear the timeout so it can't fire after we're done.
            if (timeoutRef.current) clearTimeout(timeoutRef.current);

            setPhase('success');

            // Show success state for 1 s, then navigate.
            successTimerRef.current = setTimeout(() => {
              router.push('/dashboard');
            }, 1000);
          }
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      clearTimeout(connectTimer);
      if (timeoutRef.current)    clearTimeout(timeoutRef.current);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [storeId, router]);

  return (
    <div style={s.page}>
      <div style={s.card}>
        {phase === 'success' ? (
          <SuccessState />
        ) : phase === 'timeout' ? (
          <TimeoutState onNavigate={() => router.push('/dashboard')} />
        ) : (
          <LoadingState phase={phase} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-states
// ---------------------------------------------------------------------------

function LoadingState({ phase }: { phase: 'connecting' | 'syncing' }) {
  return (
    <>
      <Spinner />
      <p style={s.headline}>
        {phase === 'connecting'
          ? 'Connecting to your store\u2026'
          : 'Syncing your products and metrics\u2026'}
      </p>
      <p style={s.sub}>
        {phase === 'connecting'
          ? 'Completing Shopify authorisation.'
          : 'This usually takes under 30 seconds.'}
      </p>
      <ProgressBar phase={phase} />
    </>
  );
}

function SuccessState() {
  return (
    <>
      <div style={s.checkCircle}>
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="16" fill="#16a34a" />
          <path
            d="M9 16.5l5 5 9-9"
            stroke="#fff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <p style={s.headline}>Your store is ready!</p>
      <p style={s.sub}>Redirecting to your dashboard&hellip;</p>
    </>
  );
}

function TimeoutState({ onNavigate }: { onNavigate: () => void }) {
  return (
    <>
      <div style={s.warningIcon}>⏱</div>
      <p style={s.headline}>This is taking longer than expected.</p>
      <p style={s.sub}>
        Your products may still be syncing in the background. You can check
        back in a moment or head to the dashboard now.
      </p>
      <button style={s.ctaBtn} onClick={onNavigate}>
        Go to Dashboard
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Micro-components
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div style={s.spinnerWrap}>
      <style>{`
        @keyframes cro-spin { to { transform: rotate(360deg); } }
      `}</style>
      <div style={s.spinner} />
    </div>
  );
}

function ProgressBar({ phase }: { phase: 'connecting' | 'syncing' }) {
  return (
    <div style={s.progressTrack}>
      <style>{`
        @keyframes cro-progress {
          0%   { width: 5%; }
          100% { width: 90%; }
        }
        @keyframes cro-progress-fast {
          0%   { width: 40%; }
          100% { width: 88%; }
        }
        .cro-bar-connecting { animation: cro-progress 3s ease-out forwards; }
        .cro-bar-syncing    { animation: cro-progress-fast 40s ease-out forwards; }
      `}</style>
      <div
        className={phase === 'connecting' ? 'cro-bar-connecting' : 'cro-bar-syncing'}
        style={s.progressBar}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight:       '100vh',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    background:      '#f9fafb',
    fontFamily:      '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding:         '24px',
  },
  card: {
    background:   '#ffffff',
    borderRadius: '16px',
    boxShadow:    '0 4px 24px rgba(0,0,0,0.08)',
    padding:      '48px 40px',
    maxWidth:     '420px',
    width:        '100%',
    textAlign:    'center',
  },
  spinnerWrap: {
    display:        'flex',
    justifyContent: 'center',
    marginBottom:   '28px',
  },
  spinner: {
    width:           '48px',
    height:          '48px',
    borderRadius:    '50%',
    border:          '4px solid #e5e7eb',
    borderTopColor:  '#111827',
    animation:       'cro-spin 0.8s linear infinite',
  },
  checkCircle: {
    display:        'flex',
    justifyContent: 'center',
    marginBottom:   '24px',
  },
  warningIcon: {
    fontSize:     '40px',
    marginBottom: '16px',
  },
  headline: {
    fontSize:     '18px',
    fontWeight:   '600',
    color:        '#111827',
    margin:       '0 0 8px',
    lineHeight:   '1.4',
  },
  sub: {
    fontSize:   '14px',
    color:      '#6b7280',
    margin:     '0 0 28px',
    lineHeight: '1.6',
  },
  progressTrack: {
    height:       '4px',
    background:   '#e5e7eb',
    borderRadius: '2px',
    overflow:     'hidden',
    marginTop:    '8px',
  },
  progressBar: {
    height:       '100%',
    background:   '#111827',
    borderRadius: '2px',
    width:        '5%',
  },
  ctaBtn: {
    display:      'inline-block',
    padding:      '10px 24px',
    background:   '#111827',
    color:        '#ffffff',
    border:       'none',
    borderRadius: '8px',
    fontSize:     '14px',
    fontWeight:   '500',
    cursor:       'pointer',
    marginTop:    '4px',
  },
};
