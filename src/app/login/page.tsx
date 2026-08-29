'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, AlertCircle, Shield } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const loadOrgSettings = useOrgSettingsStore((s) => s.load);
  const { companyName, logoUrl } = useOrgSettingsStore((s) => s.settings);
  useEffect(() => { loadOrgSettings(); }, [loadOrgSettings]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const { token, user } = await api.post<{ token: string; user: import('@/lib/authStore').AuthUser }>('/auth/login', { email, password });
      setAuth(user, token);
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Invalid credentials');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: '#f5f0eb' }}>
      {/* Left brand panel */}
      <div className="hidden lg:flex lg:w-1/2 xl:w-3/5 relative overflow-hidden bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900">
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(59,130,246,0.35) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        <div className="relative flex flex-col justify-end h-full p-12 text-white z-10">
          <div className="max-w-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300 mb-3">
              Hire Purchase Management
            </p>
            <h1 className="text-3xl font-black leading-tight mb-3">
              Finance devices.{'\n'}Manage contracts.{'\n'}Stay in control.
            </h1>
            <p className="text-white/70 text-sm leading-relaxed">
              Save-to-own, deposit + instalment, and device loan contracts — with cash and USSD payments,
              SMS receipts, and daily reports, all from one dashboard.
            </p>
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-14 bg-[#f5f0eb]">
        <div className="flex items-center gap-2.5 mb-8">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={companyName} className="w-9 h-9 object-cover shadow-sm" />
          ) : (
            <div className="w-9 h-9 bg-blue-600 flex items-center justify-center shadow-sm">
              <Shield className="w-5 h-5 text-white" />
            </div>
          )}
          <div>
            <p className="text-sm font-bold text-gray-900 leading-none tracking-wide">{companyName.toUpperCase()}</p>
            <p className="text-xs text-gray-400 leading-none mt-0.5">Management System</p>
          </div>
        </div>

        <div className="w-full max-w-[400px]">
          <div className="bg-white border border-gray-200 shadow-sm p-8">
            <div className="mb-7">
              <h2 className="text-2xl font-bold text-gray-900">Welcome back</h2>
              <p className="text-sm text-gray-400 mt-1">Sign in to your staff account</p>
            </div>

            {error && (
              <div className="mb-5 flex items-start gap-2.5 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  placeholder="you@zple.test"
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
                    placeholder="Enter your password"
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
                className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors mt-2"
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

            <div className="mt-6 pt-5 border-t border-gray-100 flex items-center justify-between">
              <span className="text-xs text-gray-300">Seeded password: Passw0rd!123</span>
              <p className="text-xs text-gray-300">Staff access only</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
