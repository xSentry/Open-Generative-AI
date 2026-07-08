'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

const initialForm = {
  name: '',
  email: '',
  password: '',
};

export default function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isRegister = mode === 'register';

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError('');

    const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
    const payload = isRegister
      ? form
      : { email: form.email, password: form.password };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data?.error?.message || 'Authentication failed.');
        return;
      }

      router.replace(searchParams.get('next') || '/studio');
      router.refresh();
    } catch {
      setError('Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#030303] text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-[#0a0a0a]/90 border border-white/10 rounded-xl p-8 shadow-2xl">
        <div className="mb-8">
          <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center mb-5">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <h1 className="text-xl font-bold tracking-tight">
            {isRegister ? 'Create account' : 'Sign in'}
          </h1>
        </div>

        <div className="grid grid-cols-2 gap-1 bg-white/5 border border-white/[0.04] rounded-md p-1 mb-6">
          <button
            type="button"
            onClick={() => { setMode('login'); setError(''); }}
            className={`h-9 rounded text-sm font-medium transition-colors ${!isRegister ? 'bg-white text-black' : 'text-white/55 hover:text-white'}`}
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => { setMode('register'); setError(''); }}
            className={`h-9 rounded text-sm font-medium transition-colors ${isRegister ? 'bg-white text-black' : 'text-white/55 hover:text-white'}`}
          >
            Register
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {isRegister && (
            <label className="block">
              <span className="block text-xs font-bold text-white/35 mb-2">Name</span>
              <input
                value={form.name}
                onChange={(event) => updateField('name', event.target.value)}
                autoComplete="name"
                className="w-full bg-white/5 border border-white/[0.05] rounded-md px-4 py-3 text-sm text-white placeholder:text-white/15 focus:outline-none focus:ring-1 focus:ring-[var(--primary-color)]/40"
                required
              />
            </label>
          )}

          <label className="block">
            <span className="block text-xs font-bold text-white/35 mb-2">Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => updateField('email', event.target.value)}
              autoComplete="email"
              className="w-full bg-white/5 border border-white/[0.05] rounded-md px-4 py-3 text-sm text-white placeholder:text-white/15 focus:outline-none focus:ring-1 focus:ring-[var(--primary-color)]/40"
              required
            />
          </label>

          <label className="block">
            <span className="block text-xs font-bold text-white/35 mb-2">Password</span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => updateField('password', event.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={8}
              className="w-full bg-white/5 border border-white/[0.05] rounded-md px-4 py-3 text-sm text-white placeholder:text-white/15 focus:outline-none focus:ring-1 focus:ring-[var(--primary-color)]/40"
              required
            />
          </label>

          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full h-10 rounded-md bg-[var(--primary-color)] text-black text-sm font-semibold hover:bg-[var(--primary-light-color)] disabled:opacity-60 disabled:hover:bg-[var(--primary-color)] transition-colors"
          >
            {isSubmitting ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
