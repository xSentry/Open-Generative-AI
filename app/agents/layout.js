/**
 * Layout for /agents/* pages.
 * These pages host the AiAgent component full-screen — no studio chrome needed.
 * Provider credentials remain server-side and are resolved from the session user.
 */
export const metadata = {
  title: "Agent Chat — Open Generative AI",
};

export default function AgentsLayout({ children }) {
  return (
    <div className="h-screen w-full overflow-hidden bg-black">
      {children}
    </div>
  );
}
