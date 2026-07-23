import { getModelById, getVideoModelById, getI2IModelById, getI2VModelById, getV2VModelById, getRecastModelById, getLipSyncModelById, getAudioModelById } from './models.js';
import { registerDeferredFile, resolveDeferred } from './deferredUploads.js';
import { watchWorkflowRun } from '../../Vibe-Workflow/packages/workflow-builder/src/components/workflowStream.js';

// In an http(s) browser we route through the host app's proxy (Next.js routes
// under /api/* re-issue the call server-side) so api.muapi.ai CORS is bypassed.
// SSR (no window) and Electron's file:// renderer call the upstream directly.
const BASE_URL = (typeof window !== 'undefined' && window.location?.protocol?.startsWith('http'))
    ? '/api'
    : 'https://api.muapi.ai';
const PROXY_WF_BASE = '/api/workflow';

function notifyAuthRequired(status, detail) {
    if (typeof window === 'undefined') return;
    if (status !== 401 && status !== 403) return;
    window.dispatchEvent(new CustomEvent('muapi:auth-required', { detail: { status, message: detail } }));
}

async function pollForResult(requestId, key, maxAttempts = 900, interval = 2000) {
    const pollUrl = `${BASE_URL}/api/v1/predictions/${requestId}/result`;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, interval));
        try {
            const response = await fetch(pollUrl, {
                headers: { 'Content-Type': 'application/json', 'x-api-key': key }
            });
            if (!response.ok) {
                const errText = await response.text();
                if (response.status >= 500) continue;
                notifyAuthRequired(response.status, errText);
                throw new Error(`Poll Failed: ${response.status} - ${errText.slice(0, 100)}`);
            }
            const data = await response.json();
            const status = data.status?.toLowerCase();
            if (status === 'completed' || status === 'succeeded' || status === 'success') return data;
            if (status === 'failed' || status === 'error') throw new Error(`Generation failed: ${data.error || 'Unknown error'}`);
        } catch (error) {
            if (attempt === maxAttempts) throw error;
        }
    }
    throw new Error('Generation timed out after polling.');
}

async function submitAndPoll(endpoint, payload, key, onRequestId, maxAttempts = 60) {
    // Inputs are held locally until this moment; upload any deferred files now so
    // the request carries real bucket URLs (legacy / Electron sync path).
    payload = await resolveDeferredParams(key, payload);
    const url = `${BASE_URL}/api/v1/${endpoint}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errText = await response.text();
        notifyAuthRequired(response.status, errText);
        throw new Error(`API Request Failed: ${response.status} ${response.statusText} - ${errText.slice(0, 100)}`);
    }
    const submitData = await response.json();
    const requestId = submitData.request_id || submitData.id;
    if (!requestId) return submitData;
    if (onRequestId) onRequestId(requestId);
    const result = await pollForResult(requestId, key, maxAttempts);
    const outputUrl = result.outputs?.[0] || result.url || result.output?.url;
    return { ...result, url: outputUrl };
}

export async function generateImage(apiKey, params) {
    const modelInfo = getModelById(params.model);
    const endpoint = modelInfo?.endpoint || params.model;
    const payload = { prompt: params.prompt };
    copyDeclaredInputs(payload, params, params.inputSchema || modelInfo?.inputs);
    if (params.aspect_ratio) payload.aspect_ratio = params.aspect_ratio;
    if (params.resolution) payload.resolution = params.resolution;
    if (params.quality) payload.quality = params.quality;
    if (params.image_url) { 
        payload.image_url = params.image_url; 
        payload.strength = params.strength || 0.6; 
    } else if (params.images_list) {
        payload.images_list = params.images_list;
    } else {
        payload.image_url = null;
    }
    if (params.seed && params.seed !== -1) payload.seed = params.seed;
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 60);
}

export async function generateI2I(apiKey, params) {
    const modelInfo = getI2IModelById(params.model);
    const endpoint = modelInfo?.endpoint || params.model;
    const payload = {};
    if (params.prompt) payload.prompt = params.prompt;
    const imageField = modelInfo?.imageField || 'image_url';
    const imagesList = params.images_list?.length > 0 ? params.images_list : (params.image_url ? [params.image_url] : null);
    if (imagesList) {
        if (imageField === 'images_list') payload.images_list = imagesList;
        else payload[imageField] = imagesList[0];
    }
    if (modelInfo?.swapField && params.swap_url) {
        payload[modelInfo.swapField] = params.swap_url;
    }
    if (params.aspect_ratio) payload.aspect_ratio = params.aspect_ratio;
    if (params.resolution) payload.resolution = params.resolution;
    if (params.quality) payload.quality = params.quality;
    if (modelInfo?.inputs?.name) {
        payload.name = params.name || modelInfo.inputs.name.default;
    }
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 60);
}

function copyDeclaredInputs(payload, params, inputSchema) {
    for (const key of Object.keys(inputSchema || {})) {
        const value = params[key];
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        payload[key] = value;
    }
}

export async function generateVideo(apiKey, params) {
    const modelInfo = getVideoModelById(params.model);
    const endpoint = modelInfo?.endpoint || params.model;
    const payload = {};
    copyDeclaredInputs(payload, params, params.inputSchema || modelInfo?.inputs);
    copyDeclaredInputs(payload, params, params.inputSchema || modelInfo?.inputs);
    if (params.prompt) payload.prompt = params.prompt;
    if (params.aspect_ratio) payload.aspect_ratio = params.aspect_ratio;
    if (params.duration) payload.duration = params.duration;
    if (params.resolution) payload.resolution = params.resolution;
    if (params.quality) payload.quality = params.quality;
    if (params.mode) payload.mode = params.mode;
    if (params.image_url) payload.image_url = params.image_url;
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 900);
}

export async function generateI2V(apiKey, params) {
    const modelInfo = getI2VModelById(params.model);
    const endpoint = modelInfo?.endpoint || params.model;
    const payload = {};
    copyDeclaredInputs(payload, params, params.inputSchema || modelInfo?.inputs);
    if (params.prompt) payload.prompt = params.prompt;
    const imageField = modelInfo?.imageField || 'image_url';
    if (params.images_list && params.images_list.length > 0) {
        if (imageField === 'images_list') payload.images_list = params.images_list;
        else payload[imageField] = params.images_list[0];
    } else if (params.image_url) {
        if (imageField === 'images_list') payload.images_list = [params.image_url];
        else payload[imageField] = params.image_url;
    }
    const lastImageField = modelInfo?.lastImageField;
    if (lastImageField && params.last_image) {
        if (lastImageField === 'images_list') {
            if (!payload.images_list) payload.images_list = [];
            if (payload.images_list.indexOf(params.last_image) === -1) {
                payload.images_list.push(params.last_image);
            }
        } else {
            payload[lastImageField] = params.last_image;
        }
    }
    if (params.aspect_ratio) payload.aspect_ratio = params.aspect_ratio;
    if (params.duration) payload.duration = params.duration;
    if (params.resolution) payload.resolution = params.resolution;
    if (params.quality) payload.quality = params.quality;
    if (params.mode) payload.mode = params.mode;
    if (modelInfo?.inputs?.name) {
        payload.name = params.name || modelInfo.inputs.name.default;
    }
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 900);
}

export async function generateMarketingStudioAd(apiKey, params) {
    const endpoint = params.resolution === '1080p' ? 'sd-2-vip-omni-reference-1080p' : 'seedance-2-vip-omni-reference';
    const payload = {
        prompt: params.prompt,
        aspect_ratio: params.aspect_ratio || '16:9',
        duration: params.duration || 5,
        images_list: params.images_list || [],
        video_files: params.video_files || []
    };
    copyDeclaredInputs(payload, params, params.inputSchema);
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 900);
}

export async function processV2V(apiKey, params) {
    const modelInfo = getV2VModelById(params.model);
    const endpoint = modelInfo?.endpoint || params.model;
    const videoField = modelInfo?.videoField || 'video_url';
    const payload = {};
    const inputSchema = params.inputSchema || modelInfo?.inputs;
    copyDeclaredInputs(payload, params, inputSchema);
    if (params.video_url && payload[videoField] === undefined) {
        payload[videoField] = inputSchema?.[videoField]?.type === 'array'
            ? [params.video_url]
            : params.video_url;
    }
    if (modelInfo?.imageField && params.image_url) {
        payload[modelInfo.imageField] = params.image_url;
    }
    if (modelInfo?.hasPrompt && params.prompt) {
        payload.prompt = params.prompt;
    }
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 900);
}

export async function processRecast(apiKey, params) {
    const modelInfo = getRecastModelById(params.model);
    const endpoint = modelInfo?.endpoint || params.model;
    const videoField = modelInfo?.videoField || 'video_url';
    const payload = {};
    copyDeclaredInputs(payload, params, params.inputSchema || modelInfo?.inputs);
    if (params.video_url && payload[videoField] === undefined) payload[videoField] = params.video_url;
    if (modelInfo?.imageField && params.image_url) {
        payload[modelInfo.imageField] = params.image_url;
    }
    if (modelInfo?.hasPrompt && params.prompt) {
        payload.prompt = params.prompt;
    }
    if (params.aspect_ratio) {
        payload.aspect_ratio = params.aspect_ratio;
    }
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 900);
}

export async function processLipSync(apiKey, params) {
    const modelInfo = getLipSyncModelById(params.model);
    const endpoint = modelInfo?.endpoint || params.model;
    const payload = {};
    copyDeclaredInputs(payload, params, params.inputSchema || modelInfo?.inputs);
    if (params.audio_url) payload.audio_url = params.audio_url;
    if (params.image_url) payload.image_url = params.image_url;
    if (params.video_url) payload.video_url = params.video_url;
    if (modelInfo?.hasPrompt) payload.prompt = params.prompt || '';
    if (params.resolution) payload.resolution = params.resolution;
    if (params.seed !== undefined && params.seed !== -1) payload.seed = params.seed;
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 900);
}

export async function generateAudio(apiKey, params) {
    const modelId = params._modelId || params.model;
    const modelInfo = getAudioModelById(modelId);
    const endpoint = modelInfo?.endpoint || modelId;
    const payload = {};
    const skipKeys = ['_modelId', 'onRequestId'];
    for (const key in params) {
        if (!skipKeys.includes(key) && params[key] !== undefined && params[key] !== null) {
            payload[key] = params[key];
        }
    }
    return submitAndPoll(endpoint, payload, apiKey, params.onRequestId, 900);
}

// Actually upload a file to the storage bucket (S3/MinIO). In a hosted browser
// this goes through the app's own /api/studio/upload route; in Electron's
// file:// renderer it hits the upstream upload endpoint directly.
export function uploadFileToBucket(apiKey, file, onProgress) {
    return new Promise((resolve, reject) => {
        const isHostedBrowser = typeof window !== 'undefined' && window.location?.protocol?.startsWith('http');
        const url = isHostedBrowser ? '/api/studio/upload' : `${BASE_URL}/api/v1/upload_file`;
        const formData = new FormData();
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        if (!isHostedBrowser) xhr.setRequestHeader('x-api-key', apiKey);

        if (onProgress) {
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const percentComplete = Math.round((event.loaded / event.total) * 100);
                    onProgress(percentComplete);
                }
            };
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    const fileUrl = data.url || data.file_url || data.data?.url;
                    if (!fileUrl) {
                        reject(new Error('No URL returned from file upload'));
                    } else {
                        resolve(fileUrl);
                    }
                } catch (e) {
                    reject(new Error('Failed to parse upload response'));
                }
            } else {
                let detail = xhr.statusText;
                try {
                    const errObj = JSON.parse(xhr.responseText);
                    // Server routes return { error, message }; MuAPI returns { detail }.
                    detail = errObj.detail || errObj.message || errObj.error || detail;
                } catch (e) {
                    // fallback to statusText
                }
                notifyAuthRequired(xhr.status, detail);
                reject(new Error(`File upload failed: ${xhr.status} - ${detail}`));
            }
        };

        xhr.onerror = () => reject(new Error('Network error during file upload'));
        xhr.send(formData);
    });
}

// Select a file WITHOUT uploading it. The file is held in the browser and a
// local blob: URL is returned for preview. The real bucket upload is deferred
// until the generation is submitted (see resolveDeferredParams), so choosing a
// file that never gets generated leaves nothing behind in the bucket.
//
// The signature is unchanged, so every studio tool keeps calling it as before;
// the returned "url" is simply a local blob: URL until submit time.
export function uploadFile(apiKey, file, onProgress) {
    // No network happens yet — report completion so existing progress UIs settle.
    if (onProgress) onProgress(100);
    return Promise.resolve(registerDeferredFile(file));
}

// Resolve any deferred (locally-held) file inputs inside a params/payload object
// by uploading them to the bucket now and swapping in the real URLs. Called at
// the generation submit choke points (submitAndPoll here; startGeneration for the
// server-persisted path).
export function resolveDeferredParams(apiKey, params) {
    return resolveDeferred(params, (file) => uploadFileToBucket(apiKey, file));
}

export async function getUserBalance(apiKey) {
    const response = await fetch(`${BASE_URL}/api/v1/account/balance`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        notifyAuthRequired(response.status, errText);
        throw new Error(`Failed to fetch balance: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function getTemplateWorkflows(apiKey) {
    const response = await fetch(`${BASE_URL}/workflow/get-template-workflows`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch template workflows: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function getUserWorkflows(apiKey) {
    const response = await fetch(`${BASE_URL}/workflow/get-workflow-defs`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch user workflows: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function getPublishedWorkflows(apiKey) {
    const response = await fetch(`${BASE_URL}/workflow/get-published-workflows`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch published workflows: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

// Agents — uses direct URL → https://api.muapi.ai/agents/...
export async function getTemplateAgents(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/templates/agents`, {
        headers
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch template agents: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.agents || data.items || []);
};

export async function getUserAgents(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/user/agents`, {
        headers
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch user agents: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.agents || data.items || []);
};

export async function getPublishedAgents(apiKey) {
    // MuAPI: GET /agents/featured/agents
    const response = await fetch(`${BASE_URL}/agents/featured/agents`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch featured agents: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.agents || data.items || []);
};

// GET /agents/user/conversations — returns the user's chat history across all agents
export async function getUserConversations(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/user/conversations`, {
        headers
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch conversations: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
};

export async function deleteUserConversation(apiKey, conversationId) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/user/conversations/${conversationId}`, {
        method: 'DELETE',
        headers,
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to delete conversation: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function getUserSkills(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/user/skills`, { headers });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch skills: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
};

export async function createAgentSkill(apiKey, payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/skills`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to create skill: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function updateAgentSkill(apiKey, skillId, payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/skills/${skillId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to update skill: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function deleteAgentSkill(apiKey, skillId) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/agents/skills/${skillId}`, {
        method: 'DELETE',
        headers,
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to delete skill: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function createWorkflow(apiKey, payload) {
    const response = await fetch(`${BASE_URL}/workflow/create`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to create workflow: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function updateWorkflowName(apiKey, workflowId, name) {
    const response = await fetch(`${BASE_URL}/workflow/update-name/${workflowId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ name })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to rename workflow: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function deleteWorkflow(apiKey, workflowId) {
    const response = await fetch(`${BASE_URL}/workflow/delete-workflow-def/${workflowId}`, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to delete workflow: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

// Publish a fresh, run-free clone of an owned workflow as a provider template.
export async function setWorkflowTemplate(apiKey, workflowId, isTemplate) {
    const response = await fetch(`${BASE_URL}/workflow/workflow/${workflowId}/template`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ is_template: isTemplate })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to update template: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

// Clone a readable workflow (a template, a community/published one, or your own)
// into a fresh private workflow you own. Returns { workflow_id }.
export async function cloneWorkflow(apiKey, workflowId) {
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/clone`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to clone workflow: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function getWorkflowInputs(apiKey, workflowId) {
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/api-inputs`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch workflow inputs: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function executeWorkflow(apiKey, workflowId, inputs, options = {}) {
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/api-execute`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ inputs })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to execute workflow: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const submitData = await response.json();
    const runId = submitData.run_id || submitData.id;
    if (!runId) return submitData;
    
    return await streamWorkflowResult(runId, apiKey, options);
};

export async function uploadWorkflowThumbnail(apiKey, workflowId, file) {
    const body = new FormData();
    body.append('thumbnail', file);
    const headers = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/thumbnail`, {
        method: 'POST',
        headers,
        body,
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to update thumbnail: ${response.status} - ${errText.slice(0, 150)}`);
    }
    return await response.json();
};

export async function removeWorkflowThumbnail(apiKey, workflowId) {
    const headers = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/thumbnail`, {
        method: 'DELETE',
        headers,
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to remove thumbnail: ${response.status} - ${errText.slice(0, 150)}`);
    }
    return await response.json();
};

function terminalWorkflowStatus(status) {
    const value = String(status || '').toLowerCase();
    return value === 'completed' || value === 'succeeded' || value === 'success' || value === 'failed' || value === 'error';
}

function successfulWorkflowStatus(status) {
    const value = String(status || '').toLowerCase();
    return value === 'completed' || value === 'succeeded' || value === 'success';
}

function outputsFromWorkflowNodeRuns(nodes = {}) {
    const outputs = [];
    for (const [nodeId, runs] of Object.entries(nodes || {})) {
        if (!Array.isArray(runs) || runs.length === 0) continue;
        const latest = runs[runs.length - 1];
        const nodeOutputs = latest?.result?.outputs;
        if (!Array.isArray(nodeOutputs)) continue;
        outputs.push(...nodeOutputs.map((output) => ({ ...output, node_id: nodeId })));
    }
    return outputs;
}

async function getWorkflowApiOutputs(runId, apiKey) {
    const response = await fetch(`${BASE_URL}/workflow/run/${runId}/api-outputs`, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch workflow outputs: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

async function streamWorkflowResult(runId, apiKey, options = {}) {
    return await new Promise((resolve, reject) => {
        const maxDuration = options.maxDuration || 30 * 60 * 1000;
        let disposed = false;
        let disposer = null;
        let timeout = null;
        const state = {
            status: 'processing',
            outputs: [],
            error: null,
            nodes: {},
        };

        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            timeout = null;
            disposer?.();
            disposer = null;
        };

        const finish = async (status) => {
            if (disposed) return;
            disposed = true;
            cleanup();

            try {
                const final = await getWorkflowApiOutputs(runId, apiKey);
                options.onUpdate?.(final);
                if (successfulWorkflowStatus(final.status || status)) resolve(final);
                else reject(new Error(`Workflow failed: ${final.error || state.error || 'Unknown error'}`));
            } catch (error) {
                if (successfulWorkflowStatus(status)) reject(error);
                else reject(new Error(`Workflow failed: ${state.error || error.message || 'Unknown error'}`));
            }
        };

        timeout = setTimeout(() => {
            if (disposed) return;
            disposed = true;
            cleanup();
            reject(new Error('Workflow timed out while waiting for streamed updates.'));
        }, maxDuration);

        disposer = watchWorkflowRun(
            runId,
            (event) => {
                if (disposed) return;
                const nodeId = event.node_id;
                if (nodeId) {
                    const current = state.nodes[nodeId] || [];
                    const nextRun = {
                        node_run_id: event.node_run_id,
                        status: event.status,
                        result: event.result || null,
                        error: event.error || null,
                    };
                    const existingIndex = current.findIndex((run) => run.node_run_id === nextRun.node_run_id);
                    state.nodes[nodeId] = existingIndex >= 0
                        ? current.map((run, index) => (index === existingIndex ? nextRun : run))
                        : [...current, nextRun];
                }
                state.status = event.run_status || state.status;
                state.error = event.error || state.error;
                state.outputs = outputsFromWorkflowNodeRuns(state.nodes);
                options.onUpdate?.({
                    ...state,
                    nodes: { ...state.nodes },
                    outputs: [...state.outputs],
                });

                if (terminalWorkflowStatus(event.run_status)) {
                    finish(event.run_status);
                }
            },
            (error) => {
                if (disposed) return;
                state.error = error?.message || 'Workflow stream failed';
                options.onUpdate?.({ ...state, nodes: { ...state.nodes }, outputs: [...state.outputs] });
            },
        );
    });
}

export async function getAllNodeSchemas(apiKey, workflowId) {
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/node-schemas`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch node schemas: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function getWorkflowData(apiKey, workflowId) {
    const response = await fetch(`${BASE_URL}/workflow/get-workflow-def/${workflowId}`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch workflow data: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
};

export async function getNodeSchemas(apiKey, workflowId) {
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/api-node-schemas`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch node schemas: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function runSingleNode(apiKey, workflowId, nodeId, payload) {
    const response = await fetch(`${BASE_URL}/workflow/${workflowId}/node/${nodeId}/run`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to run single node: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function deleteNodeRun(apiKey, nodeRunId) {
    const response = await fetch(`${BASE_URL}/workflow/node-run/${nodeRunId}`, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to delete node run: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function getNodeStatus(apiKey, runId) {
    const response = await fetch(`${BASE_URL}/workflow/run/${runId}/status`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to get node status: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

/**
 * Handle proxy requests centralizing communication logic with MuAPI.
 * This is used by the server-side entry points.
 */
export async function handleProxyRequest(prefix, path, method, headers, body, apiKey) {
    const url = `${BASE_URL}/${prefix}/${path}`;
    
    const finalHeaders = new Headers(headers);
    finalHeaders.delete('host');
    finalHeaders.delete('connection');
    finalHeaders.delete('content-length'); // Let fetch recalculate this for safety

    if (apiKey) {
        finalHeaders.set('x-api-key', apiKey);
    }

    try {
        const response = await fetch(url, {
            method,
            headers: finalHeaders,
            body: (method !== 'GET' && method !== 'HEAD') ? body : undefined,
            redirect: 'follow',
        });

        const contentType = response.headers.get('Content-Type') || 'application/json';
        const buffer = await response.arrayBuffer();
        
        return {
            status: response.status,
            contentType,
            data: buffer
        };
    } catch (error) {
        console.error(`MuAPI Proxy error for ${url}:`, error);
        throw error;
    }
}

/**
 * A centralized handler for Next.js API routes or middleware.
 */
export async function handleServerSideProxy(prefix, request, params, apiKey) {
    try {
        const slug = await params;
        const pathSegments = slug.path || [];
        const path = pathSegments.join('/');
        
        const method = request.method;
        let body = null;
        if (method !== 'GET' && method !== 'HEAD') {
            body = await request.arrayBuffer();
        }

        const { search } = new URL(request.url);
        const pathWithSearch = search ? `${path}${search}` : path;

        return await handleProxyRequest(
            prefix, 
            pathWithSearch, 
            method, 
            request.headers, 
            body, 
            apiKey
        );
    } catch (error) {
        console.error(`Server proxy failed:`, error);
        throw error;
    }
}

export async function calculateDynamicCost(apiKey, taskName, payload) {
    const response = await fetch(`${BASE_URL}/api/v1/app/calculate_dynamic_cost`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ task_name: taskName, payload })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to calculate dynamic cost: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function registerAppInterest(apiKey, appName) {
    const response = await fetch(`${BASE_URL}/app/interest`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ app_name: appName })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to register interest: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function getAppInterests(apiKey) {
    const response = await fetch(`${BASE_URL}/app/interests`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch interests: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function runClipping(apiKey, params) {
    const payload = {
        video_url: params.video_url,
        num_highlights: params.num_highlights || 3,
        aspect_ratio: params.aspect_ratio || "9:16",
        return_coordinates_only: !!params.return_coordinates_only
    };
    return submitAndPoll("ai-clipping", payload, apiKey, params.onRequestId, 900);
}

export async function runMotionGraphics(apiKey, params) {
    const payload = {
        prompt: params.prompt,
        aspect_ratio: params.aspect_ratio || "16:9",
        duration_seconds: params.duration_seconds || 6,
    };
    return submitAndPoll("motion-graphics", payload, apiKey, params.onRequestId, 900);
}

export async function runMotionGraphicsEdit(apiKey, params) {
    const payload = {
        request_id: params.request_id,
        edit_prompt: params.edit_prompt,
        aspect_ratio: params.aspect_ratio || "16:9",
        duration_seconds: params.duration_seconds || 6,
    };
    return submitAndPoll("motion-graphics-edit", payload, apiKey, params.onRequestId, 900);
}
