import AgentChatClient from "./AgentChatClient";

export async function generateMetadata() {
  return {
    title: "Agent Chat - Open Generative AI",
  };
}

export default async function AgentPage({ params }) {
  await params;
  return (
    <AgentChatClient
      agentDetails={null}
      initialHistory={null}
      userData={null}
    />
  );
}
