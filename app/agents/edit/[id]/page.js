import AgentEditClient from "./AgentEditClient";

export default async function EditAgentPage({ params }) {
  await params;
  return <AgentEditClient userData={null} />;
}
