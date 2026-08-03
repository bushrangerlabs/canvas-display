/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: contracts/scene/v1/scene-manifest.schema.json
 * Regenerate with: npm run contracts:generate:ts
 */

export type SceneUuid = string;
export type SceneTimestamp = string;
export type SceneSha256Digest = string;

/**
 * Immutable, credential-free Canvas scene revision manifest delivered by Core and staged by Edge.
 */
export interface SceneManifestV1 {
  schema_version: 1;
  scene_id: SceneUuid;
  revision_id: SceneUuid;
  revision_number: number;
  published_at: SceneTimestamp;
  manifest_digest: SceneSha256Digest;
  requirements: RendererRequirements;
  canvas: CanvasDescription;
  document: SceneDocumentReference;
  /**
   * @maxItems 2048
   */
  assets: AssetReference[];
  /**
   * @maxItems 2048
   */
  entity_subscriptions: EntitySubscription[];
  security: SceneSecurityPolicy;
  offline: OfflinePolicy;
}
export interface RendererRequirements {
  minimum_version: string;
  /**
   * @maxItems 128
   */
  capabilities: string[];
}
export interface CanvasDescription {
  width: number;
  height: number;
  background: string;
}
export interface SceneDocumentReference {
  hash: SceneSha256Digest;
  size: number;
  media_type: 'application/vnd.canvas.scene+json';
  logical_path: 'scene.json';
}
export interface AssetReference {
  hash: SceneSha256Digest;
  size: number;
  media_type: string;
  logical_path: string;
}
export interface EntitySubscription {
  entity_id: string;
  /**
   * @minItems 1
   * @maxItems 64
   */
  fields: [string, ...string[]];
}
export interface SceneSecurityPolicy {
  /**
   * @maxItems 128
   */
  allowed_origins: string[];
  allow_raw_html: boolean;
  allow_iframes: boolean;
}
export interface OfflinePolicy {
  eligible: boolean;
  schedule_eligible: boolean;
  max_stale_seconds: number;
  expires_at?: SceneTimestamp;
  fallback_revision_id?: SceneUuid;
}
