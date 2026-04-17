import OnboardingLoading from '@/components/auth/OnboardingLoading';

interface Props {
  searchParams: Promise<{ storeId?: string }>;
}

export default async function OnboardingPage({ searchParams }: Props) {
  const { storeId } = await searchParams;

  if (!storeId) {
    return (
      <div style={{ padding: 32, fontFamily: 'sans-serif', color: '#dc2626' }}>
        Missing <code>storeId</code> query parameter.
      </div>
    );
  }

  return <OnboardingLoading storeId={storeId} />;
}
