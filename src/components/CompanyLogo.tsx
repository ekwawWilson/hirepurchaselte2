'use client';

import { useEffect, useState } from 'react';

interface CompanyLogoProps {
  logoUrl: string | null;
  companyName: string;
  imgClassName: string;
  fallback: React.ReactNode;
}

/**
 * Renders the company logo set in Settings > company details (there is no
 * built-in default logo — see orgSettingsStore.ts), falling back to `fallback`
 * (an initials badge everywhere it's used) both when no logoUrl is set and
 * when the configured one fails to load. Without the onError handling, a
 * stale/broken URL (e.g. Settings still pointing at an image file that no
 * longer exists) rendered as a visibly broken image in every nav/report spot
 * that shows the logo, instead of degrading to the initials badge like the
 * "no logo configured" case already does.
 */
export function CompanyLogo({ logoUrl, companyName, imgClassName, fallback }: CompanyLogoProps) {
  const [errored, setErrored] = useState(false);
  useEffect(() => setErrored(false), [logoUrl]);

  if (!logoUrl || errored) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={logoUrl} alt={companyName} className={imgClassName} onError={() => setErrored(true)} />
  );
}
