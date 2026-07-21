'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { listProviderManifests } from '@/modules/providers/publicRegistry';

const PROVIDERS = listProviderManifests();

const initialAccount = {
  name: '',
  email: '',
  preferredProvider: 'replicate',
  providerCredentials: {},
};

export default function AccountSettingsForm() {
  const router = useRouter();
  const [account, setAccount] = useState(initialAccount);
  const [credential, setCredential] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingAccount, setIsSavingAccount] = useState(false);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [accountMessage, setAccountMessage] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [error, setError] = useState('');

  const selectedManifest = PROVIDERS.find(({ id }) => id === account.preferredProvider) || PROVIDERS[0];
  const selectedProviderHasKey = Boolean(
    account.providerCredentials?.[account.preferredProvider]?.hasCredential,
  );

  useEffect(() => {
    let isMounted = true;

    async function loadAccount() {
      try {
        const response = await fetch('/api/account', { cache: 'no-store' });
        if (response.status === 401) {
          router.replace('/login?next=/settings/account');
          return;
        }

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error?.message || 'Unable to load account.');
        }

        if (isMounted) {
          setAccount({
            name: data.user?.name || '',
            email: data.user?.email || '',
            preferredProvider: data.user?.provider || data.user?.preferredProvider || 'replicate',
            providerCredentials: data.user?.providerCredentials || {},
          });
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError?.message || 'Unable to load account.');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadAccount();

    return () => {
      isMounted = false;
    };
  }, [router]);

  const updateField = (field, value) => {
    setAccount((current) => ({ ...current, [field]: value }));
    setAccountMessage('');
    setError('');
  };

  const saveAccount = async (event) => {
    event.preventDefault();
    setIsSavingAccount(true);
    setAccountMessage('');
    setError('');

    try {
      const response = await fetch('/api/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: account.name, email: account.email }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error?.message || 'Unable to save account.');
      }

      setAccount({
        name: data.user?.name || '',
        email: data.user?.email || '',
        preferredProvider: data.user?.provider || data.user?.preferredProvider || 'replicate',
        providerCredentials: data.user?.providerCredentials || {},
      });
      setAccountMessage('Account updated.');
      router.refresh();
    } catch (saveError) {
      setError(saveError?.message || 'Unable to save account.');
    } finally {
      setIsSavingAccount(false);
    }
  };

  const saveProviderSettings = async (event) => {
    event.preventDefault();
    setIsSavingKey(true);
    setKeyMessage('');
    setError('');

    try {
      const body = {
        provider: account.preferredProvider,
      };

      if (credential.trim()) body.credential = credential;

      const response = await fetch('/api/account/provider', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error?.message || 'Unable to save provider settings.');
      }

      setAccount((current) => ({
        ...current,
        preferredProvider: data.user?.provider || data.user?.preferredProvider || current.preferredProvider,
        providerCredentials: data.user?.providerCredentials || {},
      }));
      setCredential('');
      setKeyMessage('Provider settings saved.');
      router.refresh();
    } catch (saveError) {
      setError(saveError?.message || 'Unable to save provider settings.');
    } finally {
      setIsSavingKey(false);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('muapi_key');
    document.cookie = 'muapi_key=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    router.replace('/login');
  };

  return (
    <main className="min-h-screen bg-[#030303] text-white px-4 py-8">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/35">Settings</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight">Account</h1>
          </div>
          <Link
            href="/studio"
            className="inline-flex h-10 items-center justify-center rounded-md border border-white/10 bg-white/5 px-4 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            Back to Studio
          </Link>
        </div>

        {isLoading ? (
          <div className="rounded-md border border-white/10 bg-white/5 p-6 text-sm text-white/50">
            Loading account...
          </div>
        ) : (
          <div className="space-y-6">
            {error && (
              <p className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">
                {error}
              </p>
            )}

            <form onSubmit={saveAccount} className="rounded-lg border border-white/10 bg-[#0a0a0a] p-6">
              <div className="mb-6">
                <h2 className="text-base font-bold">Account Data</h2>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-xs font-bold text-white/35">Name</span>
                  <input
                    value={account.name}
                    onChange={(event) => updateField('name', event.target.value)}
                    autoComplete="name"
                    className="w-full rounded-md border border-white/[0.06] bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:ring-1 focus:ring-[var(--primary-color)]/40"
                    required
                  />
                </label>

                <label className="block">
                  <span className="mb-2 block text-xs font-bold text-white/35">Email</span>
                  <input
                    type="email"
                    value={account.email}
                    onChange={(event) => updateField('email', event.target.value)}
                    autoComplete="email"
                    className="w-full rounded-md border border-white/[0.06] bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:ring-1 focus:ring-[var(--primary-color)]/40"
                    required
                  />
                </label>
              </div>

              <div className="mt-6 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={isSavingAccount}
                  className="h-10 rounded-md bg-[var(--primary-color)] px-4 text-sm font-semibold text-black transition-colors hover:bg-[var(--primary-light-color)] disabled:opacity-60"
                >
                  {isSavingAccount ? 'Saving...' : 'Save account'}
                </button>
                {accountMessage && <span className="text-sm text-[var(--primary-color)]">{accountMessage}</span>}
              </div>
            </form>

            <form onSubmit={saveProviderSettings} className="rounded-lg border border-white/10 bg-[#0a0a0a] p-6">
              <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-base font-bold">Provider</h2>
                  <p className="mt-2 max-w-xl text-sm text-white/45">
                    Choose the account provider and store the matching API key.
                  </p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/60">
                  {selectedManifest?.label} {selectedProviderHasKey ? 'saved' : 'not saved'}
                </span>
              </div>

              <div className="mb-6">
                <span className="mb-2 block text-xs font-bold text-white/35">Provider</span>
                <div className="grid gap-2 rounded-md border border-white/[0.06] bg-white/5 p-1" style={{ gridTemplateColumns: `repeat(${PROVIDERS.length}, minmax(0, 1fr))` }}>
                  {PROVIDERS.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => {
                        updateField('preferredProvider', provider.id);
                        setCredential('');
                        setKeyMessage('');
                      }}
                      className={`h-10 rounded text-sm font-semibold capitalize transition-colors ${
                        account.preferredProvider === provider.id
                          ? 'bg-[var(--primary-color)] text-black'
                          : 'text-white/60 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs font-bold text-white/35">
                  New {selectedManifest?.credential.label}
                </span>
                <input
                  type="password"
                  value={credential}
                  onChange={(event) => {
                    setCredential(event.target.value);
                    setKeyMessage('');
                    setError('');
                  }}
                  autoComplete="off"
                  className="w-full rounded-md border border-white/[0.06] bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-white/15 focus:ring-1 focus:ring-[var(--primary-color)]/40"
                  placeholder={selectedManifest?.credential.placeholder || ''}
                  required={!selectedProviderHasKey}
                />
              </label>

              <div className="mt-6 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={isSavingKey}
                  className="h-10 rounded-md bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-[var(--primary-light-color)] disabled:opacity-60"
                >
                  {isSavingKey ? 'Saving...' : 'Save provider'}
                </button>
                {keyMessage && <span className="text-sm text-[var(--primary-color)]">{keyMessage}</span>}
              </div>
            </form>

            <div className="rounded-lg border border-white/10 bg-[#0a0a0a] p-6">
              <h2 className="mb-4 text-base font-bold">Account Actions</h2>
              <button
                type="button"
                onClick={logout}
                className="h-10 rounded-md border border-white/10 bg-white/5 px-4 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
