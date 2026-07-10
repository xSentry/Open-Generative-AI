import React, { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { BiLoaderAlt } from "react-icons/bi";
import { RiRobot2Fill } from "react-icons/ri";
import { IoArrowBackOutline } from "react-icons/io5";
import { useRouter } from "next/navigation";

const BASE_URL = "/api/agents";
const AGENTS_HOME_PATH = "/studio/agents";

const CreateAgent = ({ useUser, usedIn }) => {
  const userContext = useUser ? useUser() : {};
  let user = null;

  if (usedIn === "vadoo") {
    const { serverDetails } = userContext;
    user = serverDetails?.user_details
      ? { email: serverDetails.user_details.email, name: serverDetails.user_details.name }
      : null;
  } else {
    // muapiapp
    user = userContext.user || null;
  }
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleArchitectAgent = async (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    try {
      setLoading(true);
      setError(null);

      const suggestResponse = await axios.post(`${BASE_URL}/suggest`, {
        prompt,
      });
      const suggestion = suggestResponse.data;
      const createPayload = {
        name: suggestion.name || "Unnamed Agent",
        description: suggestion.description || "",
        system_prompt: suggestion.system_prompt || "",
        skill_ids: suggestion.recommended_skill_ids || [],
        welcome_message: suggestion.welcome_message || "",
        initial_suggestions: suggestion.initial_suggestions || [],
        is_published: false,
        is_template: false,
      };

      const createResponse = await axios.post(`${BASE_URL}`, createPayload);
      if (createResponse.status === 200 || createResponse.status === 201) {
        const createdAgent = createResponse.data;
        router.push(`/agents/edit/${createdAgent.agent_id}`);
      }
    } catch (err) {
      console.error("Agent creation failed:", err);
      setError(
        err.response?.data?.message ||
        err.response?.data?.detail ||
        err.message ||
        "Failed to architect agent. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full w-full bg-[#030303] text-white">
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-black/50 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href={AGENTS_HOME_PATH}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white"
              aria-label="Back to Agents"
            >
              <IoArrowBackOutline className="h-4 w-4" />
            </Link>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-black uppercase tracking-[0.2em] text-[var(--primary-color)]">
                Create Agent
              </h1>
              <p className="mt-1 text-xs text-white/35">
                Define the assistant once; chat with it anywhere in Agents.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <form onSubmit={handleArchitectAgent} className="min-w-0">
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.035] shadow-2xl shadow-black/30">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-[var(--primary-color)]">
                  <RiRobot2Fill className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">Agent brief</h2>
                  <p className="mt-0.5 text-xs text-white/40">Describe the role, knowledge, tone, and expected output.</p>
                </div>
              </div>
            </div>

            <div className="space-y-4 p-5">
              <label className="block text-xs font-bold uppercase tracking-[0.18em] text-white/45">
                What should this assistant do?
              </label>
              <textarea
                value={prompt}
                autoFocus
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Example: A product photography prompt assistant that helps ecommerce teams turn rough product notes into image prompts with camera, lighting, composition, and negative prompt guidance."
                className="min-h-[260px] w-full resize-none rounded-md border border-white/[0.08] bg-black/35 px-4 py-4 text-sm leading-6 text-white outline-none transition-colors placeholder:text-white/20 focus:border-[var(--primary-color)] focus:bg-black/50"
                disabled={loading}
              />

              {error && (
                <div className="flex items-start gap-3 rounded-md border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-200">
                  <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              <div className="flex items-center justify-between gap-4 border-t border-white/[0.06] pt-4">
                <p className="text-xs text-white/35">
                  The generated profile can be edited before use.
                </p>
                <button
                  type="submit"
                  disabled={loading || !prompt.trim()}
                  className="flex h-10 min-w-[150px] items-center justify-center gap-2 rounded-md bg-[var(--primary-color)] px-5 text-xs font-black uppercase tracking-[0.16em] text-black transition-all hover:bg-[var(--primary-light-color)] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/25"
                >
                  {loading ? (
                    <>
                      <BiLoaderAlt className="h-4 w-4 animate-spin" />
                      Creating
                    </>
                  ) : (
                    "Create Agent"
                  )}
                </button>
              </div>
            </div>
          </div>
        </form>

        <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-5">
          <h3 className="text-xs font-black uppercase tracking-[0.18em] text-white/50">Better briefs</h3>
          <div className="mt-4 space-y-4 text-sm text-white/45">
            <p>State what the agent owns, what it should avoid, and the form its answers should take.</p>
            <p>Include domain constraints, examples, and preferred tone when they matter.</p>
            <p>Keep secrets, credentials, and private account data out of agent instructions.</p>
          </div>
        </div>
      </div>
    </div>
  )
};

export default CreateAgent;
