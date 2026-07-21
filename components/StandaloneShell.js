'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ImageStudio, VideoStudio, ClippingStudio, VibeMotionStudio, LipSyncStudio, RecastStudio, CinemaStudio, AudioStudio, MarketingStudio, WorkflowStudio, AgentStudio, AppsStudio, AiInfluencerStudio } from 'studio';
import { getProviderManifest } from '@/modules/providers/publicRegistry';

const DesignAgentStudio = dynamic(() => import('studio').then(mod => mod.DesignAgentStudio), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-black flex items-center justify-center text-white/20">Loading Design Studio...</div>
});

const TABS = [
  { id: 'image',   label: 'Image Studio' },
  { id: 'video',   label: 'Video Studio' },
  { id: 'audio',   label: 'Audio Studio' },
  { id: 'clipping', label: 'AI Clipping' },
  { id: 'vibe-motion', label: 'Vibe Motion' },
  { id: 'lipsync', label: 'Lip Sync' },
  { id: 'body-swap', label: 'Body Swap' },
  { id: 'cinema',  label: 'Cinema Studio' },
  { id: 'marketing', label: 'Marketing Studio' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'agents', label: 'Agents' },
  { id: 'design-agent', label: 'Design Agent' },
  { id: 'apps', label: 'Explore Apps' },
  { id: 'ai-influencer', label: 'AI Influencer Studio' },
];

const TAB_FEATURES = {
  clipping: 'clipping',
  'vibe-motion': 'vibeMotion',
  apps: 'apps',
  'ai-influencer': 'apps',
  workflows: 'workflow',
  agents: 'agents',
  'design-agent': 'designAgent',
};

export default function StandaloneShell() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const slug = params?.slug || []; 
  const idFromParams = params?.id;
  const tabFromParams = params?.tab;

  // Helper to extract workflow details precisely from either route structure
  const getWorkflowInfo = useCallback(() => {
    if (idFromParams) {
        return { id: idFromParams, tab: tabFromParams || null };
    }
    const wfIndex = slug.findIndex(s => s === 'workflows' || s === 'workflow');
    if (wfIndex === -1) return { id: null, tab: null };
    return {
      id: slug[wfIndex + 1] || null,
      tab: slug[wfIndex + 2] || null
    };
  }, [slug, idFromParams, tabFromParams]);

  const { id: urlWorkflowId } = getWorkflowInfo();

  // Initialize activeTab from URL slug/params or default to 'image'
  const getInitialTab = () => {
    if (idFromParams || slug.includes('workflow')) return 'workflows';
    if (slug.includes('agents')) return 'agents';
    if (slug.includes('design-agent')) return 'design-agent';
    if (slug.includes('apps')) return 'apps';
    const firstSegment = slug[0];
    if (firstSegment && TABS.find(t => t.id === firstSegment)) return firstSegment;
    return 'image';
  };
  
  const apiKey = null;
  const [activeTab, setActiveTab] = useState(getInitialTab());

  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [studioModelsByMode, setStudioModelsByMode] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const [hasMounted, setHasMounted] = useState(false);

  // Drag and Drop State
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState(null);

  // Sync tab with URL if user navigates manually or via browser back/forward
  useEffect(() => {
    const info = getWorkflowInfo();
    if (info.id) {
        setActiveTab('workflows');
    } else if (slug.includes('agents')) {
        setActiveTab('agents');
    } else if (slug.includes('design-agent')) {
        setActiveTab('design-agent');
    } else if (slug.includes('apps')) {
        setActiveTab('apps');
    } else {
        const firstSegment = slug[0];
        if (firstSegment && TABS.find(t => t.id === firstSegment)) {
          setActiveTab(firstSegment);
        }
    }
  }, [slug, getWorkflowInfo]);

  const handleTabChange = (tabId) => {
    router.push(`/studio/${tabId}`);
    // setActiveTab(tabId);
  };

  const handleMobileTabChange = (tabId) => {
    setShowMobileNav(false);
    handleTabChange(tabId);
  };

  useEffect(() => {
    let isMounted = true;

    async function checkAuth() {
      try {
        const response = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!response.ok) {
          router.replace(`/login?next=${encodeURIComponent(pathname || '/studio')}`);
          return;
        }

        const data = await response.json();
        if (isMounted) {
          setAuthUser(data.user);
          setAuthChecked(true);
        }
      } catch {
        router.replace(`/login?next=${encodeURIComponent(pathname || '/studio')}`);
      }
    }

    checkAuth();

    return () => {
      isMounted = false;
    };
  }, [pathname, router]);

  useEffect(() => {
    if (!authChecked) return;
    let isMounted = true;

    async function loadStudioModels() {
      try {
        const response = await fetch('/api/studio/models', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (isMounted) {
          setStudioModelsByMode(data.models || null);
        }
      } catch {
        if (isMounted) setStudioModelsByMode(null);
      }
    }

    loadStudioModels();

    return () => {
      isMounted = false;
    };
  }, [authChecked, authUser?.provider, authUser?.preferredProvider]);

  useEffect(() => {
    if (!authChecked) return;
    const provider = authUser?.provider || authUser?.preferredProvider || 'replicate';
    const manifest = getProviderManifest(provider);
    const feature = TAB_FEATURES[activeTab];
    if (!manifest || (feature && manifest.features?.[feature] !== true)) {
      router.replace('/studio/image');
    }
  }, [authChecked, authUser?.provider, authUser?.preferredProvider, activeTab, router]);

  // Auto-hide header when inside a specific workflow view or design agent
  useEffect(() => {
    const isEditingWorkflow = (activeTab === 'workflows' || !!idFromParams) && urlWorkflowId;
    const isDesignAgent = activeTab === 'design-agent';
    
    if (isEditingWorkflow || isDesignAgent) {
      setIsHeaderVisible(false);
    } else {
      setIsHeaderVisible(true);
    }
  }, [activeTab, urlWorkflowId, idFromParams]);

  // Global builder CSS cleanup when switching away from Workflows or Design Agent tabs
  useEffect(() => {
    const fromBuilder = sessionStorage.getItem("fromWorkflowBuilder");
    const fromDesignAgent = sessionStorage.getItem("fromDesignAgent");
    
    if ((fromBuilder && activeTab !== 'workflows') || (fromDesignAgent && activeTab !== 'design-agent')) {
      sessionStorage.removeItem("fromWorkflowBuilder");
      sessionStorage.removeItem("fromDesignAgent");
      window.location.reload();
    }
  }, [activeTab]);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  }, [router]);

  // Drag and Drop Handlers
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set to false if we're leaving the container itself, not moving between children
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setDroppedFiles(files);
    }
  }, []);

  const handleFilesHandled = useCallback(() => {
    setDroppedFiles(null);
  }, []);

  if (!hasMounted || !authChecked) return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center">
      <div className="animate-spin text-[var(--primary-color)] text-3xl">◌</div>
    </div>
  );

  const preferredProvider = authUser?.provider || authUser?.preferredProvider || 'replicate';
  const providerManifest = getProviderManifest(preferredProvider);
  const providerLabel = providerManifest?.label || preferredProvider;
  const selectedProviderHasKey = Boolean(authUser?.providerCredentials?.[preferredProvider]?.hasCredential);

  const visibleTabs = TABS.filter((tab) => {
    const feature = TAB_FEATURES[tab.id];
    return !feature || providerManifest?.features?.[feature] === true;
  });
  const activeTabLabel = visibleTabs.find((tab) => tab.id === activeTab)?.label || 'Image Studio';

  return (
    <div 
      className="h-screen bg-[#030303] flex flex-col overflow-hidden text-white relative"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-[100] bg-[var(--primary-color)]/10 backdrop-blur-md border-4 border-dashed border-[var(--primary-color)]/50 flex items-center justify-center pointer-events-none transition-all duration-300">
          <div className="bg-[#0a0a0a] p-8 rounded-3xl border border-white/10 shadow-2xl flex flex-col items-center gap-4 scale-110 animate-pulse">
            <div className="w-20 h-20 bg-[var(--primary-color)] rounded-2xl flex items-center justify-center">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-xl font-bold text-white">Drop your media here</span>
              <span className="text-sm text-white/40">Images, videos, or audio files</span>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      {isHeaderVisible && (
        <header className="flex-shrink-0 h-14 border-b border-white/[0.03] flex items-center justify-between px-4 sm:px-6 bg-black/20 backdrop-blur-md z-40 gap-4">
          {/* Left: Logo */}
          <div className="flex-shrink-0 flex items-center gap-2">
            <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" id="Ebene_2" data-name="Ebene 2" viewBox="0 0 801 1081.21" width="25" height="25">
                <g id="Ebene_2-2" data-name="Ebene 2">
                  <g>
                    <path d="m1,810.34V270.87L400.5,1.21l399.5,269.66v539.47l-399.5,269.66L1,810.34Zm122-494.97v450.48l277.5,225.41,277.5-225.41v-450.48L400.5,89.96,123,315.37Z"/>
                    <path d="m400.5,1.81l399,269.32v538.94l-399,269.33L1.5,810.07V271.13L400.5,1.81m0,990.08l.63-.51,277-225,.37-.3v-450.95l-.37-.3L401.13,89.83l-.63-.51-.63.51L122.87,314.83l-.37.3v450.95l.37.3,277,225,.63.51M400.5.6L.5,270.6v540l400,270,400-270V270.6L400.5.6h0Zm0,990l-277-225v-450L400.5,90.6l277,225v450l-277,225h0Z"/>
                  </g>
                  <g>
                    <path d="m270.6,592.1l-128.75-51.5,128.75-51.5h259.81l128.75,51.5-128.75,51.5h-259.81Zm129.9-84c-17.92,0-32.5,14.58-32.5,32.5s14.58,32.5,32.5,32.5,32.5-14.58,32.5-32.5-14.58-32.5-32.5-32.5Z"/>
                    <path d="m530.31,489.6l127.5,51-127.5,51h-259.61l-127.5-51,127.5-51h259.61m-129.81,84c18.2,0,33-14.8,33-33s-14.8-33-33-33-33,14.8-33,33,14.8,33,33,33m130-85h-260l-130,52,130,52h260l130-52-130-52h0Zm-130,84c-17.67,0-32-14.33-32-32s14.33-32,32-32,32,14.33,32,32-14.33,32-32,32h0Z"/>
                  </g>
                </g>
              </svg>
            </div>
            <span className="text-[1.25rem] font-bold tracking-[-0.1rem] hidden sm:block">
              AI HUB
            </span>
          </div>

          <div className="lg:hidden flex-1 min-w-0 px-2 text-center">
            <span className="block truncate text-[14px] font-bold text-white/90">
              {activeTabLabel}
            </span>
          </div>

          {/* Center: Navigation Container with fade edges */}
          <div className="hidden lg:flex flex-1 min-w-0 mx-4 sm:mx-6 relative overflow-hidden h-full items-center justify-center">
            <nav className="flex items-center gap-4 overflow-x-auto scrollbar-none w-full lg:w-auto h-full px-4 lg:px-0">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={`relative text-[13px] font-medium transition-all duration-300 whitespace-nowrap px-1 flex-shrink-0 flex items-center h-full ${
                    activeTab === tab.id
                      ? 'text-[var(--primary-color)]'
                      : 'text-white/50 hover:text-white'
                  }`}
                >
                  <span className="relative z-10">{tab.label}</span>
                  {activeTab === tab.id && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[var(--primary-color)] to-[var(--color-accent)] rounded-full shadow-[var(--shadow-glow)]" />
                  )}
                </button>
              ))}
            </nav>
          </div>

          {/* Right: Actions */}
          <div className="hidden lg:flex flex-shrink-0 items-center gap-4">
            <div className="flex items-center gap-3 bg-white/5 px-3 py-1.5 rounded-full border border-white/5 transition-colors">
              <div className={`w-2 h-2 rounded-full ${selectedProviderHasKey ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs font-bold text-white/90">{providerLabel}</span>
            </div>

            <button
              onClick={() => setShowSettings(true)}
              title="Settings - provider keys, account, preferences"
              className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/10 bg-white/5 text-[13px] font-bold text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowMobileNav(true)}
            aria-label="Open navigation"
            aria-expanded={showMobileNav}
            className="lg:hidden flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/85 hover:text-white hover:bg-white/10 transition-colors"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </svg>
          </button>
        </header>
      )}

      {isHeaderVisible && showMobileNav && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#030303] text-white lg:hidden">
          <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-white flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 801 1081.21" width="25" height="25">
                  <path d="m1,810.34V270.87L400.5,1.21l399.5,269.66v539.47l-399.5,269.66L1,810.34Zm122-494.97v450.48l277.5,225.41,277.5-225.41v-450.48L400.5,89.96,123,315.37Z"/>
                  <path d="m270.6,592.1l-128.75-51.5,128.75-51.5h259.81l128.75,51.5-128.75,51.5h-259.81Zm129.9-84c-17.92,0-32.5,14.58-32.5,32.5s14.58,32.5,32.5,32.5,32.5-14.58,32.5-32.5-14.58-32.5-32.5-32.5Z"/>
                </svg>
              </div>
              <span className="text-[1.1rem] font-bold tracking-[-0.08rem]">AI HUB</span>
            </div>
            <button
              type="button"
              onClick={() => setShowMobileNav(false)}
              aria-label="Close navigation"
              className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/85 hover:text-white hover:bg-white/10 transition-colors"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-5">
            <div className="grid grid-cols-1 gap-2">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleMobileTabChange(tab.id)}
                  className={`flex min-h-12 items-center justify-between rounded-md border px-4 text-left text-[15px] font-semibold transition-colors ${
                    activeTab === tab.id
                      ? 'border-[var(--primary-color)]/50 bg-[var(--primary-color)]/10 text-[var(--primary-color)]'
                      : 'border-white/[0.06] bg-white/[0.04] text-white/80 hover:border-white/15 hover:bg-white/[0.08] hover:text-white'
                  }`}
                >
                  <span>{tab.label}</span>
                  {activeTab === tab.id && (
                    <span className="h-2 w-2 rounded-full bg-[var(--primary-color)] shadow-[var(--shadow-glow)]" />
                  )}
                </button>
              ))}
            </div>

            <div className="mt-6 border-t border-white/[0.06] pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowMobileNav(false);
                  setShowSettings(true);
                }}
                className="flex min-h-12 w-full items-center justify-between rounded-md border border-white/[0.06] bg-white/[0.04] px-4 text-left text-[15px] font-semibold text-white/80 hover:border-white/15 hover:bg-white/[0.08] hover:text-white transition-colors"
              >
                <span>Settings</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Studio Content */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {activeTab === 'image'   && <ImageStudio   apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
        {activeTab === 'video'   && <VideoStudio   apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
        {activeTab === 'clipping' && providerManifest?.features.clipping && <ClippingStudio apiKey={apiKey} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
        {activeTab === 'vibe-motion' && providerManifest?.features.vibeMotion && <VibeMotionStudio apiKey={apiKey} />}
        {activeTab === 'lipsync' && <LipSyncStudio apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
        {activeTab === 'body-swap' && <RecastStudio apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
        {activeTab === 'cinema'  && <CinemaStudio  apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} />}
        {activeTab === 'audio'   && <AudioStudio   apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
        {activeTab === 'marketing' && <MarketingStudio apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} droppedFiles={droppedFiles} onFilesHandled={handleFilesHandled} />}
        {activeTab === 'workflows' && <WorkflowStudio apiKey={apiKey} provider={preferredProvider} providerFeatures={providerManifest?.features} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />}
        {activeTab === 'agents' && <AgentStudio apiKey={apiKey} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />}
        {activeTab === 'design-agent' && <DesignAgentStudio apiKey={apiKey} provider={preferredProvider} modelsByMode={studioModelsByMode} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />}
        {activeTab === 'apps' && providerManifest?.features.apps && <AppsStudio apiKey={apiKey} />}
        {activeTab === 'ai-influencer' && providerManifest?.features.apps && <AiInfluencerStudio apiKey={apiKey} />}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in-up">
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-8 w-full max-w-sm shadow-2xl">
            <h2 className="text-white font-bold text-lg mb-2">Settings</h2>
            <p className="text-white/40 text-[13px] mb-8">
              Manage your AI studio preferences and authentication.
            </p>
            
            <div className="space-y-4 mb-8">
              <div className="bg-white/5 border border-white/[0.03] rounded-md p-4">
                <label className="block text-xs font-bold text-white/30 mb-2">
                   Signed In
                </label>
                <div className="text-[13px] text-white/80">
                  {authUser?.name || authUser?.email}
                </div>
                <div className="text-[12px] text-white/35 truncate">
                  {authUser?.email}
                </div>
              </div>
              <div className="bg-white/5 border border-white/[0.03] rounded-md p-4">
                <label className="block text-xs font-bold text-white/30 mb-2">
                   Provider
                </label>
                <div className="flex items-center justify-between gap-4 text-[13px] text-white/80">
                  <span>{providerLabel}</span>
                  <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] font-semibold text-white/55">
                    {selectedProviderHasKey ? 'Key saved' : 'No key yet'}
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={() => router.push('/settings/account')}
                className="h-10 rounded-md bg-[var(--primary-color)] text-black hover:bg-[var(--primary-light-color)] text-xs font-semibold transition-all"
              >
                Account
              </button>
              <button
                onClick={handleLogout}
                className="h-10 rounded-md bg-white/5 text-white/80 hover:bg-white/10 text-xs font-semibold transition-all border border-white/5"
              >
                Logout
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="h-10 rounded-md bg-white/5 text-white/80 hover:bg-white/10 text-xs font-semibold transition-all border border-white/5"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
