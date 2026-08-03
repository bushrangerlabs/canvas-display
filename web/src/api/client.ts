/**
 * Canvas Core REST API client.
 *
 * Auth model (see core/src/auth.ts):
 *   - Session JWT lives in an HttpOnly cookie (`canvas_session`) set by
 *     `POST /api/admin/login`. The browser sends it automatically; we don't
 *     touch it here.
 *   - A second readable CSRF cookie (`canvas_csrf`) is also set. For
 *     CSRF-protected mutations we read it and echo it back in the
 *     `X-CSRF-Token` header (double-submit pattern).
 *
 * All admin endpoints require an authenticated session. Reads are admin/viewer
 * and CSRF-free; mutations are admin-only and CSRF-protected.
 */

export function getApiBase(): string {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  return '';
}

const BASE = getApiBase();

/** Read the readable CSRF cookie (set on login). Returns '' if absent. */
function getCsrfToken(): string {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith('csrf_token='));
  return match ? decodeURIComponent(match.split('=')[1] ?? '') : '';
}

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, path: string, method: string) {
    super(`API ${method} ${path} → ${status}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { csrf?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.csrf) {
    const token = getCsrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }
  // credentials: 'include' so the HttpOnly session cookie is sent.
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    if (res.status === 401 && path !== '/api/admin/login' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('canvas:unauthorized'));
    }
    throw new ApiError(res.status, text, path, method);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return res.json() as Promise<T>;
  return res.text() as unknown as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: { csrf?: boolean }) =>
    request<T>('POST', path, body, { csrf: true, ...opts }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body, { csrf: true }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body, { csrf: true }),
  delete: <T>(path: string) => request<T>('DELETE', path, undefined, { csrf: true }),
};

// ── Core types ───────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  role: string;
  gatewayPath: string;
}

export interface ProviderHealth {
  name: string;
  kind: string;
  healthy: boolean;
  detail?: string;
  latencyMs?: number;
  lastError?: string;
  uptimeMs?: number;
}

export interface ProvidersResponse {
  providers: ProviderHealth[];
  summary: Record<string, boolean>;
}

export type AuthorityMode = 'legacy' | 'shadow' | 'core' | 'rollback_pending';

export interface DeviceRow {
  id: string;
  name: string;
  architecture: string;
  protocol_version: string;
  group_name: string;
  capabilities: string;
  authority_mode: AuthorityMode;
  paired: boolean;
  status: string;
  last_seen: string;
  revoked_at: string | null;
  cert_fingerprint: string | null;
  audio_config?: Record<string, any>;
  voice_config?: Record<string, any>;
}

export interface InvitationRecord {
  id: string;
  scope: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_device_id: string | null;
}

export interface DevicesResponse {
  devices: DeviceRow[];
  invitations: InvitationRecord[];
}

export interface InvitationCreateResponse {
  id: string;
  token: string;
  scope: string;
  expires_at: string;
}

export type SceneStatus = 'staged' | 'published' | 'rolled_back';

export interface SceneRecord {
  id: string;
  name: string;
  revision: number;
  manifest: unknown;
  status: SceneStatus;
  createdAt: string;
  publishedAt: string | null;
}

export interface SceneRevisionRecord {
  id: string;
  sceneId: string;
  revision: number;
  manifest: unknown;
  status: SceneStatus;
  createdAt: string;
}

export interface SceneAssignment {
  sceneId: string;
  deviceId: string;
  assignedAt: string;
}

export interface ScenesResponse {
  scenes: SceneRecord[];
}

export interface SceneCreateResponse {
  ok: boolean;
  scene: SceneRecord;
}

export interface AuthorityStatusSummary {
  legacy: number;
  shadow: number;
  core: number;
  rollback_pending: number;
  total: number;
}

export interface PrivacySettings {
  retain_transcripts: boolean;
  retain_audio: boolean;
  retention_days: number;
  providers_allowed: string[];
  transcript_log_level: 'none' | 'anonymized' | 'full';
}

export interface PrivacyResponse {
  settings: PrivacySettings;
}

export interface StorageStatus {
  assetCount: number;
  assetTotalBytes: number;
  sceneCount: number;
  scheduleCount: number;
  unreferencedAssetCount: number;
}

export interface ShadowModeStatus {
  active: boolean;
  hermes_configured: boolean;
  corpus_size: number | null;
  last_run: boolean;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface CanvasQueryResult {
  intent: string;
  entities: string[];
  tool_calls: ToolCall[];
  clarification_needed: boolean;
  response: string;
  confidence: number;
}

export interface HermesQueryResponse {
  intent?: string;
  response?: string;
  [key: string]: unknown;
}

export interface ShadowResult {
  transcript: string;
  hermes_result: HermesQueryResponse | null;
  canvas_result: CanvasQueryResult;
  hermes_latency_ms: number | null;
  canvas_latency_ms: number;
  safety_pass: boolean;
  safety_detail?: string;
  matches: boolean;
  clarification_needed: boolean;
  error: string | null;
}

export interface AudioFocusState {
  state: string;
  duckLevel?: number;
}

export interface PagePanel {
  id: string;
  name: string;
  content_type: 'url' | 'scene';
  url: string | null;
  scene_id: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  view_id?: string | null;
  z_index: number;
  visible: boolean;
  opacity: number;
}

export interface LegacyPage {
  id: string;
  name: string;
  panels: PagePanel[];
  assigned_device_ids: string[];
  floating_config?: unknown;
  created_at: string;
  updated_at: string;
}

export interface LegacySettings {
  device_name: string;
  server_port: string;
  canvas_core_url: string;
  edge_voice_token: string;
  mqtt_enabled: string;
  mqtt_broker_url: string;
  mqtt_username: string;
  mqtt_password: string;
  voice_enabled: string;
  voice_mic_device: string;
  voice_wake_word: string;
  voice_tts_volume: string;
  voice_wake_ack_enabled: string;
  voice_wake_ack_sound: string;
  voice_port: string;
  voice_friendly_name: string;
  voice_ha_url: string;
  voice_ha_token: string;
  voice_pipeline_id: string;
  active_page_id: string;
  playlist_selection_page_id: string;
  [key: string]: string;
}

export interface RequestClassification {
  domain: string;
  intent: string;
  confidence: number;
  needs_clarification: boolean;
  media_type?: string;
  source?: string;
  query?: string;
  reasoning?: string;
  classifier: 'deterministic' | 'ai' | 'fallback';
}

export interface MqttStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  lastError: string | null;
  connectedAt: string | null;
}

export interface AudioState {
  state: string;
  title: string;
  url: string;
  volume: number;
  muted: boolean;
}

export type AiProviderType = 'llm' | 'asr' | 'tts';
export type AiProviderKind =
  | 'openai' | 'openrouter' | 'anthropic' | 'gemini' | 'groq' | 'azure'
  | 'llama-cpp' | 'ollama' | 'vllm' | 'whisper' | 'piper' | 'coqui';

export interface AiProviderInfo {
  id: string;
  type: AiProviderType;
  kind: AiProviderKind;
  healthy: boolean;
  detail: string;
  config?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    [key: string]: unknown;
  };
}

export interface AiTaskAssignment {
  task: string;
  providerId: string;
}

export interface AiProvidersResponse {
  providers: AiProviderInfo[];
  assignments: Record<string, string>;
}

export interface McpServerInfo {
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  healthy: boolean;
  detail: string;
  tools: string[];
}

export interface McpServerAddPayload {
  name: string;
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServerUpdatePayload {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServersResponse {
  servers: McpServerInfo[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface PendingToolConfirmation {
  token: string;
  tool: string;
  params: Record<string, unknown>;
  expiresAt: string;
}

export interface AiChatResponse {
  reply: string;
  providerId: string;
  model?: string;
  pendingConfirmation?: PendingToolConfirmation;
}

export interface HaEntityCatalogueItem {
  entity_id: string;
  domain: string;
  friendly_name: string | null;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string | null;
  last_updated: string | null;
  cached_at: string;
}

export interface HaEntityCatalogueResponse {
  entities: HaEntityCatalogueItem[];
  configured: boolean;
  connected: boolean;
  cached: boolean;
  count: number;
}

export type RoutineOwner = 'canvas_core' | 'home_assistant' | 'hybrid' | 'clarification_required';
export interface RoutineStep { id: string; kind: 'tool'|'condition'|'delay'|'routine'|'result'; config: Record<string, unknown>; timeoutMs?: number; onFailure?: 'stop'|'continue'; }
export interface RoutineDefinition { schemaVersion: 1; name: string; description?: string; owner: RoutineOwner; triggers: Array<Record<string, unknown> & {type:string}>; inputs: Record<string,unknown>; steps: RoutineStep[]; result: Record<string,unknown>; limits: {timeoutMs:number;maxSteps:number;maxRoutineDepth:number}; }
export interface RoutineRevision { id:string; routine_id:string; revision:number; definition:RoutineDefinition; status:string; creation_source:string; created_at:string; enabled_at?:string|null; }
export interface RoutineRecord { id:string; name:string; description?:string|null; owner:RoutineOwner; status:string; active_revision_id?:string|null; active_revision?:number|null; created_at:string; updated_at:string; revisions?:RoutineRevision[]; }
export interface RoutineExecution { id:string; routine_id:string; status:string; origin:string; origin_device_id?:string|null; principal:string; started_at:string; finished_at?:string|null; error?:string|null; result?:unknown; steps?:Array<Record<string,unknown>>; }
export interface RoutinePlan { prompt:string; definition:RoutineDefinition|null; owner:RoutineOwner; reasons:string[]; unresolved:string[]; ambiguous:Array<{value:string;candidates:string[]}>; permissions:string[]; risk:'low'|'medium'|'elevated'; validation:{valid:boolean;errors:Array<{path:string;message:string}>}; expectedBehavior:string; haDraft:{supported:false;reason:string}|null; changes:Array<{path:string;before?:unknown;after?:unknown}>; }
export type RoutineLearningMode='off'|'suggest'|'automatic_drafts';
export interface LearnedRoutinePlan { signature:string; normalized_phrase:string; plan:Array<{tool:string;args:Record<string,unknown>}>; success_count:number; status:string; routine_id?:string|null; fast_path_hits:number; last_fast_path_ms?:number|null; origin_devices:string[]; first_seen_at:string; last_seen_at:string; }
export interface SkillDefinition { schemaVersion:1;name:string;description:string;instructions:string;invocation:{phrases:string[];keywords:string[];examples:string[]};allowedTools:string[];routineId:string|null;responseStyle:string; }
export interface SkillRevision { id:string;skill_id:string;revision:number;definition:SkillDefinition;status:string;creation_source:string;created_at:string;enabled_at?:string|null; }
export interface SkillRecord { id:string;name:string;description?:string;status:string;active_revision?:number|null;revisions?:SkillRevision[]; }
export interface SkillPlan { prompt:string;definition:SkillDefinition|null;validation:{valid:boolean;errors:Array<{path:string;message:string}>};risk:'normal'|'elevated';remainsDisabled:true; }

// ── Typed API surface ───────────────────────────────────────────────────────

export const coreApi = {
  // Health / providers
  health: () => api.get<HealthResponse>('/health'),
  providers: () => api.get<ProvidersResponse>('/api/providers'),

  // Home Assistant entity catalogue
  haEntities: () => api.get<HaEntityCatalogueResponse>('/api/ha/entities'),
  refreshHaEntities: () =>
    api.post<{ ok: boolean; count: number; refreshedAt: string }>('/api/ha/entities/refresh'),

  routines: () => api.get<{routines:RoutineRecord[]}>('/api/admin/routines'),
  routine: (id:string) => api.get<{routine:RoutineRecord}>(`/api/admin/routines/${encodeURIComponent(id)}`),
  createRoutine: (definition:RoutineDefinition) => api.post<{ok:boolean;routine:{id:string}}>('/api/admin/routines',{definition,source:'user'}),
  reviseRoutine: (id:string,definition:RoutineDefinition) => api.post<{ok:boolean;revision:RoutineRevision}>(`/api/admin/routines/${encodeURIComponent(id)}/revisions`,{definition,source:'user'}),
  validateRoutine: (definition:RoutineDefinition) => api.post<{valid:boolean;errors:Array<{path:string;message:string}>}>('/api/admin/routines/validate',{definition}),
  enableRoutine: (id:string,revision?:number) => api.post<{ok:boolean;routine:RoutineRecord}>(`/api/admin/routines/${encodeURIComponent(id)}/enable`,{revision}),
  setRoutineStatus: (id:string,action:'disable'|'archive') => api.post<{ok:boolean;routine:RoutineRecord}>(`/api/admin/routines/${encodeURIComponent(id)}/${action}`),
  simulateRoutine: (id:string) => api.post<{ok:boolean;simulation:Record<string,unknown>}>(`/api/admin/routines/${encodeURIComponent(id)}/simulate`),
  runRoutine: (id:string,originDeviceId?:string) => api.post<{ok:boolean;execution:RoutineExecution}>(`/api/admin/routines/${encodeURIComponent(id)}/run`,{originDeviceId,idempotencyKey:crypto.randomUUID()}),
  routineExecutions: (id:string) => api.get<{executions:RoutineExecution[]}>(`/api/admin/routines/${encodeURIComponent(id)}/executions`),
  confirmRoutineExecution: (id:string) => api.post<{ok:boolean;execution:RoutineExecution}>(`/api/admin/routine-executions/${encodeURIComponent(id)}/confirm`),
  cancelRoutineExecution: (id:string) => api.post<{ok:boolean;execution:RoutineExecution}>(`/api/admin/routine-executions/${encodeURIComponent(id)}/cancel`),
  planRoutine: (prompt:string,routineId?:string,resolutions?:Record<string,string>) => api.post<{ok:boolean;plan:RoutinePlan}>('/api/admin/routines/plan',{prompt,routineId,resolutions}),
  createPlannedRoutineDraft: (definition:RoutineDefinition,routineId?:string) => api.post<{ok:boolean;routine:{id:string};revision?:RoutineRevision}>('/api/admin/routines/create-draft',{definition,routineId}),
  routineLearning: () => api.get<{mode:RoutineLearningMode;plans:LearnedRoutinePlan[]}>('/api/admin/routine-learning'),
  setRoutineLearningMode: (mode:RoutineLearningMode) => api.put<{ok:boolean;mode:RoutineLearningMode}>('/api/admin/routine-learning/mode',{mode}),
  dismissLearnedRoutinePlan: (signature:string) => api.post<{ok:boolean}>(`/api/admin/routine-learning/${encodeURIComponent(signature)}/dismiss`),
  createLearnedRoutineDraft: (signature:string) => api.post<{ok:boolean;routineId:string}>(`/api/admin/routine-learning/${encodeURIComponent(signature)}/create-draft`),
  skills:()=>api.get<{skills:SkillRecord[]}>('/api/admin/skills'),
  skill:(id:string)=>api.get<{skill:SkillRecord}>(`/api/admin/skills/${encodeURIComponent(id)}`),
  planSkill:(prompt:string)=>api.post<{ok:boolean;plan:SkillPlan}>('/api/admin/skills/plan',{prompt}),
  createSkill:(definition:SkillDefinition)=>api.post<{ok:boolean;skill:{id:string}}>('/api/admin/skills',{definition,source:'user'}),
  reviseSkill:(id:string,definition:SkillDefinition)=>api.post<{ok:boolean;revision:SkillRevision}>(`/api/admin/skills/${encodeURIComponent(id)}/revisions`,{definition}),
  enableSkill:(id:string,revision?:number)=>api.post<{ok:boolean;skill:SkillRecord}>(`/api/admin/skills/${encodeURIComponent(id)}/enable`,{revision}),
  setSkillStatus:(id:string,action:'disable'|'archive')=>api.post<{ok:boolean;skill:SkillRecord}>(`/api/admin/skills/${encodeURIComponent(id)}/${action}`),

  // Auth
  login: (username: string, password: string) =>
    api.post<{ ok: boolean; username: string; role: string }>('/api/admin/login', { username, password }, { csrf: false }),
  session: () =>
    api.get<{ authenticated: true; username: string; role: string }>('/api/admin/session'),
  logout: () => api.post<{ ok: boolean }>('/api/admin/logout', undefined),

  // Devices
  devices: () => api.get<DevicesResponse>('/api/admin/devices'),
  createInvitation: (scope?: string, ttlSeconds?: number) =>
    api.post<InvitationCreateResponse>('/api/admin/devices/invitations', { scope, ttlSeconds }),
  revokeDevice: (id: string) =>
    api.post<{ ok: boolean; device: DeviceRow }>(`/api/admin/devices/${id}/revoke`),

  // Scenes
  scenes: () => api.get<ScenesResponse>('/api/admin/scenes'),
  publishedScene: (id: string) =>
    api.get<{ scene: SceneRecord }>(`/api/scenes/${encodeURIComponent(id)}/published`),
  createScene: (name: string, manifest: unknown) =>
    api.post<SceneCreateResponse>('/api/admin/scenes', { name, manifest }),
  stageScene: (id: string, manifest: unknown) =>
    api.post<{ ok: boolean; revision: SceneRevisionRecord }>(`/api/admin/scenes/${id}/stage`, { manifest }),
  publishScene: (id: string) =>
    api.post<{ ok: boolean; scene: SceneRecord }>(`/api/admin/scenes/${id}/publish`),
  rollbackScene: (id: string) =>
    api.post<{ ok: boolean; scene: SceneRecord }>(`/api/admin/scenes/${id}/rollback`),
  deleteScene: (id: string, force = false) =>
    api.delete<{ ok: boolean; assignmentsRemoved: number; panelReferencesCleared: number }>(
      `/api/admin/scenes/${encodeURIComponent(id)}${force ? '?force=true' : ''}`,
    ),
  sceneRevisions: (id: string) =>
    api.get<{ sceneId: string; revisions: SceneRevisionRecord[] }>(`/api/admin/scenes/${id}/revisions`),
  assignScene: (id: string, deviceId: string) =>
    api.post<{ ok: boolean; assignment: SceneAssignment }>(`/api/admin/scenes/${id}/assign`, { deviceId }),

  // Authority
  authorityStatus: () => api.get<AuthorityStatusSummary>('/api/admin/authority/status'),
  switchAuthority: (device_ids: string[], authority_mode: AuthorityMode) =>
    api.post<{ ok: boolean; switched: number; skipped: number; epoch: string }>(
      '/api/admin/authority/switch',
      { device_ids, authority_mode },
    ),

  // Privacy
  privacy: () => api.get<PrivacyResponse>('/api/admin/privacy'),
  updatePrivacy: (settings: Partial<PrivacySettings>) =>
    api.put<{ settings: PrivacySettings }>('/api/admin/privacy', settings),
  purgePrivacy: () => api.post<{ purgedTranscripts: number; purgedAudio: number }>('/api/admin/privacy/purge'),

  // Storage
  storageStatus: () => api.get<StorageStatus>('/api/admin/storage/status'),
  runGc: () => api.post<{ ok: boolean; assetCount: number; assetTotalBytes: number; sceneCount: number; scheduleCount: number; unreferencedAssetCount: number }>('/api/admin/storage/gc'),

  // Shadow mode / intelligence
  shadowStatus: () => api.get<ShadowModeStatus>('/api/admin/shadow-mode/status'),
  shadowRunSingle: (transcript: string) =>
    api.post<ShadowResult>('/api/admin/shadow-mode/run-single', { transcript }),
  shadowRun: () => api.post<unknown>('/api/admin/shadow-mode/run'),
  shadowReport: () => api.get<unknown>('/api/admin/shadow-mode/report'),
  audioFocus: () => api.get<AudioFocusState>('/api/admin/audio-focus'),
  voiceBridge: () => api.get<{ configured: boolean; source: 'env' | 'db' | 'none'; token: string | null; coreUrl: string }>('/api/admin/voice-bridge'),

  // Pages / WebViews (legacy-compatible records managed by Core)
  pages: () => api.get<LegacyPage[]>('/api/pages'),
  createPage: (name: string) => api.post<LegacyPage>('/api/pages', { name }),
  renamePage: (id: string, name: string) =>
    api.patch<LegacyPage>(`/api/pages/${encodeURIComponent(id)}`, { name }),
  deletePage: (id: string) =>
    api.delete<void>(`/api/pages/${encodeURIComponent(id)}`),
  createPagePanel: (pageId: string, panel: Omit<PagePanel, 'id'>) =>
    api.post<PagePanel>(`/api/pages/${encodeURIComponent(pageId)}/panels`, panel),
  updatePagePanel: (pageId: string, panelId: string, panel: Omit<PagePanel, 'id'>) =>
    api.patch<PagePanel>(`/api/pages/${encodeURIComponent(pageId)}/panels/${encodeURIComponent(panelId)}`, panel),
  deletePagePanel: (pageId: string, panelId: string) =>
    api.delete<void>(`/api/pages/${encodeURIComponent(pageId)}/panels/${encodeURIComponent(panelId)}`),
  assignPage: (pageId: string, deviceId: string) =>
    api.put<{ device_id: string; page_id: string; assigned_at: string; delivered: boolean }>(
      `/api/pages/${encodeURIComponent(pageId)}/assign`,
      { device_id: deviceId },
    ),
  unassignPage: (pageId: string, deviceId: string) =>
    api.delete<{ success: boolean }>(
      `/api/pages/${encodeURIComponent(pageId)}/assign/${encodeURIComponent(deviceId)}`,
    ),
  forceDisplayPage: (pageId: string, deviceId: string) =>
    api.post<{ delivered: boolean }>(
      `/api/pages/${encodeURIComponent(pageId)}/display`,
      { device_id: deviceId },
    ),
  devicePageLibrary: (deviceId: string) =>
    api.get<{
      device_id: string;
      pages: Array<{ page_id: string; name: string; sync_status: string; cached_revision: number; bytes: number }>;
      active_page_id: string | null;
      default_page_id: string | null;
      fallback_page_id: string | null;
      history: string[];
    }>(`/api/devices/${encodeURIComponent(deviceId)}/pages`),
  devicePageBack: (deviceId: string) =>
    api.post<{ delivered: boolean; page_id: string }>(`/api/devices/${encodeURIComponent(deviceId)}/page/back`),
  devicePageReload: (deviceId: string) =>
    api.post<{ delivered: boolean; page_id: string }>(`/api/devices/${encodeURIComponent(deviceId)}/page/reload`),
  patchDevicePanel: (
    deviceId: string,
    panelId: string,
    patch: { content_type?: 'url' | 'scene'; url?: string; scene_id?: string; visible?: boolean },
  ) => api.patch<{ delivered: boolean }>(
    `/api/devices/${encodeURIComponent(deviceId)}/panels/${encodeURIComponent(panelId)}`,
    patch,
  ),
  commandPanel: (command: {
    device_id: string;
    panel_id?: string;
    panel?: string;
    page_id?: string;
    page?: string;
    content_type?: 'url' | 'scene';
    url?: string;
    scene_id?: string;
    visible?: boolean;
    reload?: boolean;
  }) => api.post<{
    success: boolean;
    delivered: boolean;
    queued?: boolean;
    panel_id: string;
  }>('/api/commands/panel', command),
  settings: () => api.get<LegacySettings>('/api/settings'),
  updateSettings: (settings: Record<string, string>) =>
    api.put<{ updated: string[] }>('/api/settings', settings),
  testRequestRouting: (transcript: string) =>
    api.post<{ transcript: string; classification: RequestClassification }>('/api/admin/request-routing/test', { transcript }),
  mqttStatus: () => api.get<MqttStatus>('/api/settings/mqtt'),
  reconnectMqtt: () => api.post<{ ok: boolean } & MqttStatus>('/api/settings/mqtt/reconnect'),
  disconnectMqtt: () => api.post<{ ok: boolean }>('/api/settings/mqtt/disconnect'),
  coreBridgeStatus: () => api.get<{ url: string; tokenSet: boolean; source: string }>('/api/settings/core-bridge'),
  testCoreBridge: () => api.post<{ ok: boolean; status?: unknown; error?: string }>('/api/settings/core-bridge/test'),
  restartVoice: () => api.post<{ ok: boolean; mode: string; status: string }>('/api/settings/voice/restart'),
  audioState: () => api.get<AudioState>('/api/audio/state'),

   // AI providers (multi-provider model registry)
  aiProviders: () => api.get<AiProvidersResponse>('/api/admin/ai-providers'),
  assignAiProvider: (task: string, providerId: string) =>
    api.put<{ ok: boolean }>('/api/admin/ai-providers/assign', { task, providerId }),
  healthCheckAiProviders: () =>
    api.post<{ providers: AiProviderInfo[] }>('/api/admin/ai-providers/health-check'),
  addAiProvider: (id: string, type: string, kind: string, config: Record<string, unknown>) =>
    api.post<{ ok: boolean; id: string }>('/api/admin/ai-providers', { id, type, kind, config }),
  updateAiProvider: (id: string, type: string, kind: string, config: Record<string, unknown>) =>
    api.put<{ ok: boolean; id: string }>(`/api/admin/ai-providers/${id}`, { type, kind, config }),
  deleteAiProvider: (id: string) =>
    api.delete<{ ok: boolean }>('/api/admin/ai-providers/' + encodeURIComponent(id)),

  // MCP Servers
  mcpServers: () => api.get<McpServersResponse>('/api/admin/mcp-servers'),
  addMcpServer: (payload: McpServerAddPayload) => api.post<{ ok: boolean; name: string }>('/api/admin/mcp-servers', payload),
  updateMcpServer: (name: string, payload: McpServerUpdatePayload) => api.put<{ ok: boolean; name: string }>(`/api/admin/mcp-servers/${encodeURIComponent(name)}`, payload),
  deleteMcpServer: (name: string) => api.delete<{ ok: boolean }>('/api/admin/mcp-servers/' + encodeURIComponent(name)),

  // AI Chat
  chatSend: (messages: ChatMessage[], providerId?: string) =>
    api.post<AiChatResponse>('/api/admin/ai/chat', { messages, providerId }),
  confirmChatTool: (token: string) =>
    api.post<{ reply: string; toolResult: { ok: boolean; message: string; data?: unknown } }>('/api/admin/ai/chat/confirm', { token }),

  // Log level
  logLevel: () => api.get<{ level: string }>('/api/admin/log-level'),
  setLogLevel: (level: string) => api.put<{ level: string }>('/api/admin/log-level', { level }),

  // Device audio/voice config
  getDeviceAudio: (id: string) => api.get<{ audio_config: Record<string, any> | null; voice_config: Record<string, any> | null }>(`/api/admin/devices/${encodeURIComponent(id)}/audio`),
  getDeviceVoiceMetrics: (id: string) => api.get<{
    device_id: string; window: string;
    summary: { turns: number; capture_avg_ms: number | null; first_playback_p50_ms: number | null; first_playback_p95_ms: number | null; total_p50_ms: number | null; total_p95_ms: number | null };
    recent: Array<Record<string, any>>;
  }>(`/api/admin/devices/${encodeURIComponent(id)}/voice/metrics`),
  getDeviceAudioDevices: (id: string) =>
    api.get<{
      microphones: Array<{ id: string; name: string }>;
      speakers: Array<{ id: string; name: string }>;
      wake_words: Array<{ id: string; name: string }>;
    }>(`/api/admin/devices/${encodeURIComponent(id)}/audio/devices`),
  updateDeviceAudio: (id: string, config: Record<string, any>) =>
    api.put<{ ok: boolean }>(`/api/admin/devices/${encodeURIComponent(id)}/audio`, config),
  updateDeviceVoice: (id: string, config: Record<string, any>) =>
    api.put<{ ok: boolean }>(`/api/admin/devices/${encodeURIComponent(id)}/voice`, config),
  testDeviceMic: (id: string, config: { device: string; duration_ms?: number }) =>
    api.post<{ ok: boolean; sample: string; format: string; note?: string }>(`/api/admin/devices/${encodeURIComponent(id)}/audio/test-mic`, config),
  testDeviceSpeaker: (id: string, config: { device: string; volume: number }) =>
    api.post<{ ok: boolean; note?: string }>(`/api/admin/devices/${encodeURIComponent(id)}/audio/test-speaker`, config),
  testDeviceWakeword: (id: string, config: { wake_word: string; wake_threshold: number; mic_device: string; timeout_ms?: number }) =>
    api.post<{ ok: boolean; detected: boolean; note?: string }>(`/api/admin/devices/${encodeURIComponent(id)}/voice/test-wakeword`, config),
  uploadDeviceVoiceCue: (id: string, file: { data_base64: string; content_type: string; filename: string }) =>
    api.post<{ ok: boolean; sound: string; filename: string; size: number }>(
      `/api/admin/devices/${encodeURIComponent(id)}/voice/cue-upload`,
      file,
    ),
  testDeviceVoiceCue: (id: string, sound: string, volume: number) =>
    api.post<{ ok: boolean }>(`/api/admin/devices/${encodeURIComponent(id)}/voice/test-cue`, {
      sound,
      volume,
    }),
};
