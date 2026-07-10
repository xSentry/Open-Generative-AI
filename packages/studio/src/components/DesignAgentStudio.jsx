"use client";

import { useState, useEffect } from 'react';
import { CreativeCanvas } from 'design-agent';

import { getUserBalance } from '../muapi';

export default function DesignAgentStudio({ apiKey, provider = 'replicate', modelsByMode = null, isHeaderVisible, onToggleHeader }) {
  const [userData, setUserData] = useState(null);

  useEffect(() => {
    sessionStorage.setItem("fromDesignAgent", "true");
    if (apiKey) localStorage.setItem("token", apiKey);

    if (provider !== 'muapi') {
      setUserData({
        username: 'Studio User',
        email: '',
        balance: 0
      });
      return;
    }

    if (!apiKey) return;
    
    const fetchUser = async () => {
      try {
        const data = await getUserBalance(apiKey);
        setUserData({
          username: data.email?.split('@')[0] || 'Studio User',
          email: data.email,
          balance: data.balance || 0
        });
      } catch (err) {
        console.error('Failed to fetch user data for Design Agent:', err);
      }
    };

    fetchUser();
  }, [apiKey, provider]);

  return (
    <div className="h-full w-full bg-black overflow-hidden design-agent-studio">
      <CreativeCanvas 
        user={userData}
        isAuthorized={!!userData}
        provider={provider}
        modelsByMode={modelsByMode}
        creditConversionRate={200}
        theme="dark"
        onToggleHeader={onToggleHeader}
        isHeaderVisible={isHeaderVisible}
      />
    </div>
  );
}
