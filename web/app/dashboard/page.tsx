import DashboardLoader from '@/components/dashboard/DashboardLoader';

// Dashboard identity + data are fetched client-side (see DashboardLoader) so the
// browser can attach the cross-site API session cookie. A Server Component on
// Vercel cannot read the cookie set on the Render API domain.
export default function DashboardPage() {
  return <DashboardLoader />;
}
