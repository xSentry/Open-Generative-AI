"use client";

import { CreateAgentPage } from "ai-agent";
import { useCallback } from "react";

export default function AgentCreateClient({ userData }) {
  const useUser = useCallback(
    () => ({
      user: {
        username: userData?.email?.split("@")[0] || "Studio User",
        name: userData?.email?.split("@")[0] || "Studio User",
        email: userData?.email || null,
        profile_photo: null,
        balance: userData?.balance || 0,
      },
      isAuthorized: !!userData,
    }),
    [userData]
  );

  return (
    <CreateAgentPage
      useUser={useUser}
      usedIn="studio"
    />
  );
}
