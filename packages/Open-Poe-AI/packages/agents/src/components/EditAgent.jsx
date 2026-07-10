import React, { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { IoChevronBack, IoPencilOutline, IoShareOutline, IoTrashOutline, IoCloseOutline, IoImageOutline, IoSparklesOutline, IoChatbubblesOutline } from "react-icons/io5";
import { BiLoaderAlt } from "react-icons/bi";
import { RiRobot2Fill } from "react-icons/ri";
import toast from "react-hot-toast";
import { FaRegTrashCan } from "react-icons/fa6";
import { MdClose } from "react-icons/md";
import { themes } from "./themes";

const BASE_URL = "/api/agents";
const AGENTS_HOME_PATH = "/studio/agents";

const darkEditCss = `
  .agent-edit-surface {
    color: #fff;
    background: #030303;
  }
  .agent-edit-surface [class*="bg-white"],
  .agent-edit-surface [class*="bg-gray-50"],
  .agent-edit-surface [class*="bg-gray-100"],
  .agent-edit-surface [class*="bg-blue-50"],
  .agent-edit-surface [class*="bg-violet-50"] {
    background-color: rgba(255,255,255,0.035) !important;
  }
  .agent-edit-surface [class*="text-gray-900"],
  .agent-edit-surface [class*="text-gray-800"],
  .agent-edit-surface [class*="text-gray-700"],
  .agent-edit-surface [class*="text-gray-600"] {
    color: rgba(255,255,255,0.88) !important;
  }
  .agent-edit-surface [class*="text-gray-500"],
  .agent-edit-surface [class*="text-gray-400"] {
    color: rgba(255,255,255,0.42) !important;
  }
  .agent-edit-surface [class*="border-gray-"],
  .agent-edit-surface [class*="border-white"] {
    border-color: rgba(255,255,255,0.08) !important;
  }
  .agent-edit-surface input,
  .agent-edit-surface textarea {
    background-color: rgba(0,0,0,0.35) !important;
    color: rgba(255,255,255,0.9) !important;
    border-color: rgba(255,255,255,0.08) !important;
  }
  .agent-edit-surface input::placeholder,
  .agent-edit-surface textarea::placeholder {
    color: rgba(255,255,255,0.24) !important;
  }
  .agent-edit-surface input:focus,
  .agent-edit-surface textarea:focus {
    border-color: var(--primary-color) !important;
    box-shadow: none !important;
  }
  .agent-edit-surface .agent-edit-panel {
    background: rgba(255,255,255,0.035) !important;
    border: 1px solid rgba(255,255,255,0.075) !important;
    border-radius: 8px !important;
    box-shadow: 0 24px 80px rgba(0,0,0,0.28) !important;
  }
  .agent-edit-surface .agent-edit-button {
    border-radius: 6px !important;
  }
`;

const EditAgent = ({ useUser, usedIn }) => {
  // Project-specific user detail extraction
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
  const { id } = useParams();
  const router = useRouter();
  const fileInputRef = useRef(null);
  
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    system_prompt: "",
    icon_url: "",
    skill_ids: [],
    theme: "cosmic",
    is_published: false,
    is_template: false,
  });
  
  const [availableSkills, setAvailableSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [initialSkills, setInitialSkills] = useState([]);
  const [realignedPrompt, setRealignedPrompt] = useState("");
  const [isRealigning, setIsRealigning] = useState(false);
  const [showRealignModal, setShowRealignModal] = useState(false);
  const [generatingIcon, setGeneratingIcon] = useState(false);
  const [showIconPromptModal, setShowIconPromptModal] = useState(false);
  const [showIconSelectionModal, setShowIconSelectionModal] = useState(false);
  const [iconPrompt, setIconPrompt] = useState("");

  useEffect(() => {
    if (id) {
      fetchData();
    }
  }, [id]);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const [agentRes, skillsRes] = await Promise.all([
        axios.get(`${BASE_URL}/by-slug/${id}`),
        axios.get(`${BASE_URL}/skills`)
      ]);
      
      const agent = agentRes.data;
      if (!agent.is_owner) {
        setError("You are not authorized to edit this agent.");
        setLoading(false);
        return;
      }
      setFormData({
        name: agent.name,
        description: agent.description || "",
        system_prompt: agent.system_prompt,
        icon_url: agent.icon_url || "",
        skill_ids: agent.skills.map(s => s.id),
        theme: agent.theme || "cosmic",
        is_published: agent.is_published || false,
        is_template: agent.is_template || false,
      });
      setInitialSkills(agent.skills.map(s => s.id));
      setAvailableSkills(skillsRes.data);
    } catch (err) {
      console.error("Error fetching data:", err);
      setError(
        err.response?.data?.message || 
        err.response?.data?.detail || 
        "Failed to load agent details."
      );
    } finally {
      setLoading(false);
    }
  };
  
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSkillToggle = (skillId) => {
    setFormData(prev => {
      const isSelected = prev.skill_ids.includes(skillId);
      if (isSelected) {
        return { ...prev, skill_ids: prev.skill_ids.filter(id => id !== skillId) };
      } else {
        return { ...prev, skill_ids: [...prev.skill_ids, skillId] };
      }
    });
  };

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to delete this agent? This action cannot be undone.")) {
      return;
    }

    try {
      setSaving(true);
      await axios.delete(`${BASE_URL}/by-slug/${id}`);
      toast.success("Agent deleted successfully");
      router.push(AGENTS_HOME_PATH);
    } catch (err) {
      console.error("Delete error:", err);
      toast.error("Failed to delete agent");
      setError(err.response?.data?.detail || "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  const handleShare = () => {
    const url = `${window.location.origin}/agents/${id}`;
    navigator.clipboard.writeText(url);
    toast.success("Chat link copied to clipboard!");
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }

    try {
      setUploading(true);
      setUploadProgress(0);
      const { data: uploadParams } = await axios.get("/api/app/get_file_upload_url", {
        params: { filename: file.name }
      });

      const { url, fields } = uploadParams;
      const uploadData = new FormData();
      Object.entries(fields).forEach(([key, value]) => {
        uploadData.append(key, value);
      });
      uploadData.append("file", file);

      const uploadRes = await axios.post(url, uploadData, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (progressEvent) => {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(percent);
        }
      });
      const prefix = usedIn === "vadoo" ? "https://d3adwkbyhxyrtq.cloudfront.net/": "https://cdn.muapi.ai/";
      const uploadedUrl = uploadRes.data?.url || uploadParams.public_url || fields.public_url || `${prefix}${fields.key}`;
      setFormData(prev => ({ ...prev, icon_url: uploadedUrl }));
      toast.success("Profile image updated");
    } catch (err) {
      console.error("Upload failed:", err);
      toast.error("Failed to upload image");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleGenerateIcon = async (customPrompt) => {
    if (!formData.name && !customPrompt) {
      toast.error("Please enter an agent name first");
      return;
    }

    try {
      setGeneratingIcon(true);
      const prompt = customPrompt || `A professional, clean profile icon for an AI agent named "${formData.name}". Description: ${formData.description || "An AI assistant"}. Minimalist, high-quality, circular composition.`;
      
      const response = await axios.post("/api/api/v1/flux-schnell-image", {
        prompt,
        width: 1024,
        height: 1024,
        num_images: 1,
        sync: true
      });

      if (response.data && response.data.outputs && response.data.outputs.length > 0) {
        const generatedUrl = response.data.outputs[0];
        setFormData(prev => ({ ...prev, icon_url: generatedUrl }));
        setShowIconPromptModal(false);
        toast.success("AI icon generated!");
      } else {
        throw new Error("No image generated");
      }
    } catch (err) {
      console.error("Icon generation failed:", err);
      toast.error(err.response?.data?.detail || "Failed to generate AI icon");
    } finally {
      setGeneratingIcon(false);
    }
  };

  const handleRealign = async () => {
    try {
      setIsRealigning(true);
      const res = await axios.post(`${BASE_URL}/by-slug/${id}/preview-realign`, {
        current_prompt: formData.system_prompt,
        new_skill_ids: formData.skill_ids
      });
      setRealignedPrompt(res.data.proposed_prompt);
      setShowRealignModal(true);
      toast.success("Prompt realigned! Please review.");
    } catch (err) {
      console.error("Realign failed:", err);
      toast.error("Failed to realign prompt");
    } finally {
      setIsRealigning(false);
    }
  };

  const applyRealignedPrompt = () => {
    setFormData(prev => ({ ...prev, system_prompt: realignedPrompt }));
    setShowRealignModal(false);
    toast.success("New instructions applied!");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);
      
      await axios.put(`${BASE_URL}/by-slug/${id}`, formData);
      
      setSuccess(true);
      toast.success("Agent profile updated successfully!");
      setTimeout(() => {
        router.push(AGENTS_HOME_PATH);
      }, 1500);
    } catch (err) {
      console.error("Error updating agent:", err);
      setError(
        err.response?.data?.message || 
        err.response?.data?.detail || 
        "Failed to update agent."
      );
      toast.error("Failed to save changes");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="agent-edit-surface flex min-h-full w-full items-center justify-center bg-[#030303]">
        <style dangerouslySetInnerHTML={{ __html: darkEditCss }} />
        <div className="flex flex-col items-center gap-2">
          <BiLoaderAlt className="w-10 h-10 text-[var(--primary-color)] animate-spin" />
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/35 animate-pulse">Loading Agent</p>
        </div>
      </main>
    );
  }
  
  if (error) {
    return (
      <main className="agent-edit-surface flex min-h-full w-full flex-col items-center justify-center gap-4 bg-[#030303] p-8 text-center">
        <style dangerouslySetInnerHTML={{ __html: darkEditCss }} />
        <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10">
          <IoCloseOutline className="h-8 w-8 text-red-300" />
        </div>
        <h2 className="text-lg font-bold text-white">Access denied</h2>
        <p className="max-w-md text-sm text-white/45">
          {error}
        </p>
        <Link 
          href={AGENTS_HOME_PATH}
          className="mt-4 rounded-md bg-[var(--primary-color)] px-6 py-3 text-xs font-black uppercase tracking-[0.16em] text-black transition-all hover:bg-[var(--primary-light-color)] active:scale-95"
        >
          Return to My Agents
        </Link>
      </main>
    );
  }

  return (
    <div className="agent-edit-surface min-h-full w-full bg-[#030303] text-white">
      <style dangerouslySetInnerHTML={{ __html: darkEditCss }} />
      <div className="sticky top-0 z-30 border-b border-white/[0.06] bg-black/50 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5">
        <Link 
          href={AGENTS_HOME_PATH}
          className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs font-bold uppercase tracking-[0.14em] text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white"
        >
          <IoChevronBack className="w-4 h-4" />
          Back
        </Link>
        <div className="flex items-center gap-3">
          <Link 
            href={`${window.location.origin}/agents/${id}`}
            className="agent-edit-button flex items-center gap-2 border border-white/[0.08] bg-white/[0.05] px-4 py-2 text-xs font-bold text-white/80 transition-all hover:bg-white/[0.09] active:scale-95"
          >
            <IoChatbubblesOutline className="w-4 h-4" />
            Chat
          </Link>
          <button 
            type="button"
            onClick={handleShare}
            className="agent-edit-button flex items-center gap-2 border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-white/55 transition-all hover:bg-white/[0.07] hover:text-white active:scale-95"
            aria-label="Share agent"
          >
            <IoShareOutline className="w-4 h-4" />
          </button>
          <button 
            type="button"
            onClick={handleDelete}
            disabled={saving}
            className="agent-edit-button flex items-center gap-2 border border-red-500/20 bg-red-500/10 px-3 py-2 text-red-300 transition-all hover:bg-red-500/15 active:scale-95 disabled:opacity-50"
            aria-label="Delete agent"
          >
            <IoTrashOutline className="w-4 h-4" />
          </button>
          <Link 
            href="/docs/agents"
            target="_blank"
            className="agent-edit-button hidden items-center gap-2 border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs font-bold text-white/45 transition-all hover:bg-white/[0.07] hover:text-white active:scale-95 sm:flex"
          >
            Docs
          </Link>
        </div>
      </div>
      </div>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8">
        <form id="edit-agent-form" onSubmit={handleSubmit} className="flex w-full flex-col gap-6">
          <div className="agent-edit-panel flex w-full flex-col gap-6 p-5 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-8 w-full">
              <div className="relative">
                <div 
                  onClick={() => setShowIconSelectionModal(true)}
                  className="group relative h-24 w-24 cursor-pointer overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.035] transition-all hover:border-[var(--primary-color)]/50"
                >
                  {formData.icon_url ? (
                    <img src={formData.icon_url} alt="Profile" className="w-full h-full object-cover transition-transform group-hover:scale-110" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-black/30 transition-colors group-hover:bg-white/[0.04]">
                      <RiRobot2Fill className="h-10 w-10 text-white/20 transition-colors group-hover:text-[var(--primary-color)]" />
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                    <IoPencilOutline className="w-6 h-6 text-white" />
                  </div>
                  {uploading && (
                    <div className="absolute inset-0 bg-white/95 dark:bg-primary-bg/95 flex items-center justify-center rounded-full z-10 backdrop-blur-[1px]">
                      <div className="relative w-16 h-16">
                        <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                          <circle
                            cx="18"
                            cy="18"
                            r="16"
                            fill="none"
                            className="stroke-gray-100 dark:stroke-divider"
                            strokeWidth="3.5"
                          />
                          <circle
                            cx="18"
                            cy="18"
                            r="16"
                            fill="none"
                            className="stroke-black dark:stroke-primary transition-all duration-500 ease-out"
                            strokeWidth="3.5"
                            strokeDasharray="100.53"
                            strokeDashoffset={100.53 * (1 - uploadProgress / 100)}
                            strokeLinecap="round"
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xs font-bold text-gray-900 dark:text-white">
                            {uploadProgress}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*" />
              </div>
              <div className="flex min-w-0 flex-col gap-2 w-full">
                <div className="flex items-center gap-2 group/title w-full">
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleInputChange}
                    className="w-full truncate border-none bg-transparent p-0 text-3xl font-bold leading-tight tracking-tight text-white outline-none focus:ring-0"
                    placeholder="Unnamed Agent"
                    required
                  />
                  <IoPencilOutline className="w-5 h-5 text-gray-300 dark:text-divider opacity-0 group-hover/title:opacity-100 transition-opacity" />
                </div>
                <div className="flex items-center gap-3 mt-1 mr-auto">
                  {/* Toggles moved to better location */}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-3">
              <button
                type="submit"
                form="edit-agent-form"
                disabled={saving}
                className="agent-edit-button h-10 whitespace-nowrap bg-[var(--primary-color)] px-6 text-xs font-black uppercase tracking-[0.14em] text-black transition-all hover:bg-[var(--primary-light-color)] active:scale-95 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
              <div className="flex w-fit items-center gap-1.5 rounded-md border border-white/[0.08] bg-black/25 p-1">
                <div 
                  onClick={() => setFormData(prev => ({ ...prev, is_published: !prev.is_published }))}
                  className={`flex cursor-pointer items-center gap-2 rounded px-4 py-2 text-xs font-bold uppercase tracking-[0.14em] transition-all duration-300 ${
                    formData.is_published 
                      ? "bg-[var(--primary-color)] text-black"
                      : "text-white/35 hover:bg-white/[0.05] hover:text-white/75"
                  }`}
                >
                  <div className={`h-2 w-2 rounded-full transition-all duration-500 ${formData.is_published ? "bg-black/70" : "bg-white/20"}`} />
                  <span>Publish</span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-6">
            <div className="agent-edit-panel flex flex-col gap-5 p-5">
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white">Behavior & Identity</h2>
                <p className="text-sm text-white/40">
                  Shape how your agent thinks, responds, and describes itself
                </p>
              </div>
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between border-l-2 border-[var(--primary-color)] pl-3">
                    <label className="text-xs font-black uppercase tracking-[0.16em] text-white/65">Instructions</label>
                    <button
                      type="button"
                      onClick={handleRealign}
                      disabled={isRealigning || JSON.stringify(formData.skill_ids.sort()) === JSON.stringify(initialSkills.sort())}
                      className="agent-edit-button flex items-center gap-2 border border-violet-400/20 bg-violet-500/15 px-3 py-1.5 text-xs font-bold text-violet-100 transition-all hover:bg-violet-500/25 active:scale-95 disabled:opacity-45"
                      title={JSON.stringify(formData.skill_ids.sort()) === JSON.stringify(initialSkills.sort()) ? "No changes to skills" : "Sync instructions with current skills"}
                    >
                      {isRealigning ? <BiLoaderAlt className="animate-spin" /> : "✨ Realign with Skills"}
                    </button>
                  </div>
                  <div className="relative group">
                    <textarea
                      name="system_prompt"
                      value={formData.system_prompt}
                      onChange={handleInputChange}
                      className="min-h-[220px] w-full rounded-md border border-white/[0.08] bg-black/35 px-4 py-4 text-sm font-medium leading-relaxed text-white outline-none transition-colors focus:border-[var(--primary-color)]"
                      placeholder="Define how your agent thinks and communicates..."
                      required
                    />
                    <p className="ml-1 text-xs text-white/35">
                      Define how your agent thinks and communicates. Start with &quot;You are...&quot; and include specific examples.
                    </p>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="border-l-2 border-[var(--primary-color)] pl-3 text-xs font-black uppercase tracking-[0.16em] text-white/65">Description</label>
                  <textarea
                    name="description"
                    value={formData.description}
                    onChange={handleInputChange}
                    className="min-h-[110px] w-full rounded-md border border-white/[0.08] bg-black/35 px-4 py-4 text-sm font-medium leading-relaxed text-white outline-none transition-colors focus:border-[var(--primary-color)]"
                    placeholder="Add a description that describes your agent to others..."
                  />
                  <p className="ml-1 text-xs text-white/35">
                    This will be visible to users when they discover your agent.
                  </p>
                </div>
              </div>
            </div>
            <div className="agent-edit-panel flex flex-col gap-5 p-5">
              <div className="flex flex-col gap-2">
                <h2 className="border-l-2 border-[var(--primary-color)] pl-3 text-sm font-black uppercase tracking-[0.18em] text-white">Theme & Appearance</h2>
                <p className="ml-1 text-sm text-white/40">
                  Customize how your agent looks in the chat interface
                </p>
              </div>
              
              <div className="flex flex-col gap-8 lg:flex-row">
                {/* Theme Selection */}
                <div className="flex-1 flex flex-col gap-4">
                  <h4 className="ml-1 text-xs font-bold uppercase tracking-[0.16em] text-white/40">Select Theme</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {Object.values(themes || {}).map((theme) => (
                      <button
                        key={theme.id}
                        type="button"
                        onClick={() => setFormData(prev => ({ ...prev, theme: theme.id }))}
                        className={`group relative flex flex-col items-center gap-2 rounded-md border p-3 transition-all ${
                          formData.theme === theme.id 
                            ? "border-[var(--primary-color)] bg-white/[0.06]"
                            : "border-white/[0.08] bg-black/20 hover:border-[var(--primary-color)]/50 hover:bg-white/[0.04]"
                        }`}
                      >
                        <div 
                          className="w-full aspect-video rounded-xl shadow-inner border border-black/5 flex items-center justify-center relative overflow-hidden"
                          style={{ background: theme.colors.background }}
                        >
                          <div className="flex flex-col gap-1 w-[60%]">
                            <div className="h-1.5 w-[80%] rounded-full opacity-40" style={{ background: theme.colors.foreground }}></div>
                            <div className="h-1.5 w-[50%] rounded-full opacity-40 ml-auto" style={{ background: theme.colors.userBubble }}></div>
                          </div>
                        </div>
                        <span className={`text-xs font-bold transition-colors ${
                          formData.theme === theme.id ? "text-white" : "text-white/40 group-hover:text-white/75"
                        }`}>
                          {theme.name}
                        </span>
                        {formData.theme === theme.id && (
                          <div className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--primary-color)] text-black shadow-lg">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex-1 flex flex-col gap-4">
                  <h4 className="ml-1 text-xs font-bold uppercase tracking-[0.16em] text-white/40">Chat Preview</h4>
                  <div 
                    className="relative h-[300px] w-full overflow-hidden rounded-lg border border-white/[0.08] shadow-2xl"
                    style={{
                      background: (themes[formData.theme] || themes.cosmic)?.colors.background,
                      color: (themes[formData.theme] || themes.cosmic)?.colors.foreground
                    }}
                  >
                    <div 
                      className="px-4 py-3 flex items-center gap-2 border-b"
                      style={{ 
                        background: (themes[formData.theme] || themes.cosmic)?.colors.headerBg,
                        borderColor: (themes[formData.theme] || themes.cosmic)?.colors.border
                      }}
                    >
                      <div className="w-8 h-8 rounded-full bg-gray-400 overflow-hidden">
                        {formData.icon_url ? (
                          <img src={formData.icon_url} className="w-full h-full object-cover" />
                        ) : (
                          <RiRobot2Fill className="w-full h-full p-1.5 text-white/50" />
                        )}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs font-bold truncate">{formData.name || "Agent Name"}</span>
                        <span className="text-[10px] opacity-60">Online</span>
                      </div>
                    </div>
                    <div className="p-4 flex flex-col gap-4 h-[180px] overflow-y-auto">
                      <div className="flex flex-col items-end gap-1 max-w-[85%] ml-auto">
                        <div 
                          className="px-3 py-2 rounded-2xl text-xs font-medium shadow-sm"
                          style={{ 
                            background: (themes[formData.theme] || themes.cosmic)?.colors.userBubble,
                            color: (themes[formData.theme] || themes.cosmic)?.colors.userText
                          }}
                        >
                          Hi! How can you help me today?
                        </div>
                      </div>
                      <div className="flex flex-col items-start gap-1 max-w-[85%]">
                        <div 
                          className="px-3 py-2 rounded-2xl text-xs font-medium border shadow-sm"
                          style={{ 
                            background: (themes[formData.theme] || themes.cosmic)?.colors.agentBubble,
                            color: (themes[formData.theme] || themes.cosmic)?.colors.agentText,
                            borderColor: (themes[formData.theme] || themes.cosmic)?.colors.border
                          }}
                        >
                          I can help you with tasks, answer questions, and much more using {formData.skill_ids.length} configured skills!
                        </div>
                      </div>
                    </div>
                    <div className="absolute bottom-0 w-full p-4">
                      <div 
                        className="h-10 rounded-xl flex items-center px-4 gap-2 border shadow-inner"
                        style={{ 
                          background: (themes[formData.theme] || themes.cosmic)?.colors.inputBg,
                          borderColor: (themes[formData.theme] || themes.cosmic)?.colors.border
                        }}
                      >
                        <span className="text-xs opacity-30 flex-1">Type a message...</span>
                        <div 
                          className="w-6 h-6 rounded-lg flex items-center justify-center"
                          style={{ background: (themes[formData.theme] || themes.cosmic)?.colors.accent }}
                        >
                          <div className="w-1.5 h-1.5 rounded-full" style={{ background: (themes[formData.theme] || themes.cosmic)?.colors.accentText }}></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <p className="ml-1 text-xs text-white/35">
                This theme will be automatically applied to the chat interface for all users.
              </p>
            </div>

            <div className="agent-edit-panel flex flex-col gap-5 p-5">
              <h2 className="border-l-2 border-[var(--primary-color)] pl-3 text-sm font-black uppercase tracking-[0.18em] text-white">Capabilities</h2>
              <div className="flex flex-col gap-4">
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Type to search and add skills (e.g. image generation, web search)..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full rounded-md border border-white/[0.08] bg-black/35 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-[var(--primary-color)]"
                  />
                </div>
                <div className="flex flex-col gap-4">
                  <h4 className="ml-1 text-xs font-bold uppercase tracking-[0.16em] text-white/40">
                    Active Agent Skills ({formData.skill_ids.length})
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {formData.skill_ids.length > 0 ? (
                      formData.skill_ids.map((id) => {
                        const skill = availableSkills.find(s => s.id === id);
                        if (!skill) return null;
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => handleSkillToggle(skill.id)}
                            className="group relative flex items-center justify-between rounded-md border border-white/[0.08] bg-black/25 p-4 text-left transition-all hover:border-[var(--primary-color)]/50 hover:bg-white/[0.04]"
                          >
                            <div className="flex flex-col text-left">
                              <span title={skill.name} className="line-clamp-1 text-sm font-bold text-white">
                                {skill.name}
                              </span>
                              <span title={skill.description} className="line-clamp-2 text-xs text-white/40">
                                {skill.description}
                              </span>
                            </div>
                            <FaRegTrashCan size={16} className="absolute right-4 text-red-300 opacity-0 transition-all duration-300 ease-in-out group-hover:opacity-100" />
                          </button>
                        );
                      })
                    ) : (
                      <div className="col-span-full rounded-md border border-dashed border-white/[0.1] bg-black/20 p-10 text-center">
                        <p className="text-sm text-white/35">No skills configured yet</p>
                      </div>
                    )}
                  </div>
                    <div className="border-t border-white/[0.06] pt-4">
                      <h4 className="mb-2 ml-1 text-xs font-bold uppercase tracking-[0.16em] text-white/40">
                        Available in Registry
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                        {availableSkills
                          .filter(skill => 
                            !formData.skill_ids.includes(skill.id) && 
                            (skill.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                              skill.id.toLowerCase().includes(searchTerm.toLowerCase()))
                          )
                          .map((skill) => (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() => {
                                handleSkillToggle(skill.id);
                                setSearchTerm("");
                              }}
                              className="group flex items-center justify-between rounded-md border border-white/[0.08] bg-black/25 p-4 text-left transition-all hover:border-[var(--primary-color)]/50 hover:bg-white/[0.04]"
                            >
                              <div className="flex flex-col text-left">
                                <span title={skill.name} className="line-clamp-1 text-sm font-bold text-white">
                                  {skill.name}
                                </span>
                                <span title={skill.description} className="line-clamp-2 text-xs text-white/40">
                                  {skill.description}
                                </span>
                              </div>
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-[var(--primary-color)] text-sm font-bold text-black">+</span>
                            </button>
                          ))
                        }
                      </div>
                    </div>
                </div>
              </div>
              <p className="ml-1 text-xs text-white/35">
                Manage tools and skills your agent can use to perform tasks
              </p>
            </div>
          </div>
          {error && (
            <div className="flex animate-shake items-center gap-3 rounded-md border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-200">
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-medium">{error}</span>
            </div>
          )}
        </form>
      </div>
      {showRealignModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="agent-edit-panel flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-white/[0.08] bg-violet-500/10 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-violet-500/20 text-violet-100">
                  <RiRobot2Fill className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Review Brain Realignment</h3>
                  <p className="text-xs text-white/40">The AI has refactored your instructions to match your new skills.</p>
                </div>
              </div>
              <button
                onClick={() => setShowRealignModal(false)}
                className="rounded-md p-2 text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white"
              >
                <MdClose className="w-6 h-6" />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 md:flex-row custom-scrollbar">
              <div className="flex-1 flex flex-col gap-3">
                <label className="ml-1 text-xs font-bold uppercase tracking-[0.16em] text-white/40">Current Instructions</label>
                <div className="max-h-[400px] flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-white/[0.08] bg-black/30 p-4 text-sm font-medium text-white/50">
                  {formData.system_prompt}
                </div>
              </div>
              <div className="hidden md:flex items-center justify-center text-violet-300 dark:text-violet-500">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              </div>
              <div className="flex-1 flex flex-col gap-3">
                <label className="ml-1 text-xs font-bold uppercase tracking-[0.16em] text-violet-200">Proposed Instructions</label>
                <textarea
                  value={realignedPrompt}
                  onChange={(e) => setRealignedPrompt(e.target.value)}
                  className="min-h-[400px] flex-1 resize-none rounded-md border border-violet-400/20 bg-violet-500/10 p-4 text-sm font-medium leading-relaxed text-white outline-none transition-all focus:border-violet-300"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-white/[0.08] bg-black/25 px-6 py-5">
              <button
                onClick={() => setShowRealignModal(false)}
                className="agent-edit-button px-5 py-2.5 text-sm font-bold text-white/45 transition-colors hover:bg-white/[0.05] hover:text-white"
              >
                Discard Changes
              </button>
              <button
                onClick={applyRealignedPrompt}
                className="agent-edit-button bg-violet-500 px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-violet-400 active:scale-95"
              >
                Accept & Apply
              </button>
            </div>
          </div>
        </div>
      )}
      {showIconPromptModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="agent-edit-panel w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-white/[0.08] bg-white/[0.03] p-5">
              <h3 className="flex items-center gap-2 text-lg font-bold text-white">
                <span className="text-2xl">✨</span> Customize AI Icon Prompt
              </h3>
              <button
                onClick={() => setShowIconPromptModal(false)}
                className="rounded-md p-2 text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white"
              >
                <IoCloseOutline className="w-6 h-6" />
              </button>
            </div>

            <div className="p-6">
              <p className="mb-5 text-sm text-white/45">
                Tell the AI what kind of icon you want. You can describe style, colors, and specific elements.
              </p>

              <div className="space-y-4">
                <textarea
                  value={iconPrompt}
                  onChange={(e) => setIconPrompt(e.target.value)}
                  placeholder="Describe your agent's icon..."
                  className="h-40 w-full resize-none rounded-md border border-white/[0.08] bg-black/35 p-4 text-sm text-white outline-none transition-all placeholder:text-white/25 focus:border-[var(--primary-color)]"
                />

                <div className="flex gap-3 pt-4">
                  <button
                    onClick={() => setShowIconPromptModal(false)}
                    className="agent-edit-button flex-1 border border-white/[0.08] px-5 py-3 text-sm font-bold text-white/55 transition-all hover:bg-white/[0.06] hover:text-white active:scale-[0.98]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleGenerateIcon(iconPrompt)}
                    disabled={generatingIcon || !iconPrompt.trim()}
                    className="agent-edit-button flex flex-[2] items-center justify-center gap-2 bg-[var(--primary-color)] px-5 py-3 font-bold text-black transition-all hover:bg-[var(--primary-light-color)] active:scale-[0.98] disabled:opacity-50"
                  >
                    {generatingIcon ? (
                      <>
                        <BiLoaderAlt className="w-5 h-5 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <span className="text-lg">✨</span>
                        Generate Icon
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {showIconSelectionModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="agent-edit-panel w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-white/[0.08] p-6">
              <div>
                <h3 className="text-lg font-black leading-tight text-white">Profile Icon</h3>
                <p className="mt-1 text-sm text-white/40">Choose how to update your agent's look</p>
              </div>
              <button 
                onClick={() => setShowIconSelectionModal(false)}
                className="flex h-9 w-9 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white"
              >
                <IoCloseOutline className="w-6 h-6" />
              </button>
            </div>
            
            <div className="grid grid-cols-1 gap-3 p-6">
              <button
                onClick={() => {
                  setShowIconSelectionModal(false);
                  fileInputRef.current?.click();
                }}
                className="group flex flex-col items-center gap-4 rounded-md border border-white/[0.08] bg-black/25 p-6 transition-all duration-300 hover:border-[var(--primary-color)]/50 hover:bg-white/[0.04] active:scale-[0.98]"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white/45 transition-colors duration-300 group-hover:text-[var(--primary-color)]">
                  <IoImageOutline className="w-8 h-8" />
                </div>
                <div className="text-center">
                  <h4 className="text-base font-bold text-white">Upload Photo</h4>
                  <p className="mt-1 text-sm text-white/40">Pick a file from your device</p>
                </div>
              </button>

              <button
                onClick={() => {
                  setShowIconSelectionModal(false);
                  setIconPrompt(`A professional, clean profile icon for an AI agent named "${formData.name}". Description: ${formData.description || "An AI assistant"}. Minimalist, high-quality, circular composition.`);
                  setShowIconPromptModal(true);
                }}
                className="group flex flex-col items-center gap-4 rounded-md border border-[var(--primary-color)]/20 bg-[var(--primary-color)]/10 p-6 transition-all duration-300 hover:border-[var(--primary-color)]/60 hover:bg-[var(--primary-color)]/15 active:scale-[0.98]"
              >
                <div className="flex h-12 w-12 transform items-center justify-center rounded-md bg-[var(--primary-color)] text-black transition-transform duration-500 group-hover:scale-105">
                  <IoSparklesOutline className="w-8 h-8" />
                </div>
                <div className="text-center">
                  <h4 className="text-base font-bold text-[var(--primary-color)]">Generate with AI</h4>
                  <p className="mt-1 text-sm text-white/40">Create unique icon from prompt</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EditAgent
