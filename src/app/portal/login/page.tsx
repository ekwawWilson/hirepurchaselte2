'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Wallet } from 'lucide-react';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import { useCustomerAuthStore, type PortalCustomer } from '@/lib/customerAuthStore';
import { CompanyLogo } from '@/components/CompanyLogo';

// Rotating panel copy. Text rather than photographs: this app ships no
// imagery of its own now that the branding comes from Settings, and a
// missing image would be worse than none.
const SLIDES = [
  {
    headline: 'Your contract.\nYour balance.\nYour account.',
    sub: 'Check what you owe and what you have paid, whenever you want to.',
  },
  {
    headline: 'Pay from\nyour phone.',
    sub: 'Pay by mobile money in a few taps — no trip to the shop needed.',
  },
  {
    headline: 'Every payment,\nwritten down.',
    sub: 'Your full payment history is here, receipt by receipt.',
  },
];

export default function PortalLoginPage() {
  const router = useRouter();
  const { companyName, logoUrl } = useOrgSettingsStore((s) => s.settings);
  const loadOrgSettings = useOrgSettingsStore((s) => s.load);
  const setAuth = useCustomerAuthStore((s) => s.setAuth);

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    loadOrgSettings();
  }, [loadOrgSettings]);

  useEffect(() => {
    const timer = setInterval(() => setSlide((s) => (s + 1) % SLIDES.length), 6000);
    return () => clearInterval(timer);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const res = await fetch('/api/portal/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      });
      const data = (await res.json()) as { token?: string; customer?: PortalCustomer; error?: string };
      if (!res.ok || !data.token || !data.customer) throw new Error(data.error || 'Sign in failed');
      setAuth(data.customer, data.token);
      router.replace(data.customer.mustChangePassword ? '/portal/profile' : '/portal/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid phone number or password');
    } finally {
      setIsLoading(false);
    }
  }

  const current = SLIDES[slide];

  return (
    <div className="min-h-screen flex bg-[#f5f0eb]">
      {/* Left panel */}
      <div className="hidden lg:flex lg:w-1/2 xl:w-3/5 relative bg-slate-900 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/30 via-slate-900 to-slate-900" />
        {/* A soft glow in the logo's own orange — a small, deliberate dose
            (blue stays dominant, matching the logo mark itself). */}
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-brand-accent/20 blur-3xl" />
        <div className="relative flex flex-col justify-between h-full p-12 text-white z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-primary flex items-center justify-center">
              <Wallet className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm tracking-wide">{companyName.toUpperCase()}</span>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300 mb-3">Customer Portal</p>
            <h1 className="text-4xl font-black leading-tight mb-3 whitespace-pre-line">{current.headline}</h1>
            <p className="text-white/70 text-sm leading-relaxed max-w-sm">{current.sub}</p>
          </div>

          <div className="flex gap-2">
            {SLIDES.map((s, i) => (
              <button
                key={s.headline}
                onClick={() => setSlide(i)}
                aria-label={`Slide ${i + 1}`}
                className={`h-1.5 rounded-full transition-all ${i === slide ? 'w-8 bg-white' : 'w-4 bg-white/30'}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-14">
        <div className="flex items-center gap-2.5 mb-8">
          <CompanyLogo
            logoUrl={logoUrl}
            companyName={companyName}
            imgClassName="w-9 h-9 object-cover shadow-sm"
            fallback={
              <div className="w-9 h-9 bg-primary flex items-center justify-center shadow-sm">
                <Wallet className="w-5 h-5 text-white" />
              </div>
            }
          />
          <div>
            <p className="text-sm font-bold text-gray-900 leading-none tracking-wide">{companyName.toUpperCase()}</p>
            <p className="text-xs text-gray-400 leading-none mt-0.5">Customer Portal</p>
          </div>
        </div>

        <div className="w-full max-w-[400px]">
          <div className="bg-white border border-gray-200 shadow-sm p-8">
            <div className="mb-7">
              <h2 className="text-2xl font-bold text-gray-900">Welcome</h2>
              <p className="text-sm text-gray-400 mt-1">Sign in with your phone number</p>
            </div>

            {error && (
              <div className="mb-5 flex items-start gap-2.5 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="phone" className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
                  Phone number
                </label>
                <input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  disabled={isLoading}
                  placeholder="024 000 0000"
                  className="w-full h-11 px-3.5 border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition disabled:opacity-50"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={isLoading}
                    placeholder="Your password"
                    className="w-full h-11 px-3.5 pr-11 border border-gray-200 bg-gray-50 text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 w-11 flex items-center justify-center text-gray-400 hover:text-gray-600 transition"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full h-11 bg-primary hover:bg-primary/90 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2 transition-colors mt-2"
              >
                {isLoading ? (
                  <>
                    <div className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Signing in…
                  </>
                ) : (
                  'Sign in'
                )}
              </button>
            </form>

            <p className="mt-6 text-xs text-gray-400 leading-relaxed">
              First time here? Sign in with your phone number as both your number and your password —
              you will be asked to choose a password straight away.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
