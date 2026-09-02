/** Wire, storage, and Session-adapter types for the External Gateway. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionIntent } from '@deepseek-ai/dsh-user-questions/types'

/** Lossless JSON value accepted at the HTTP and storage boundaries. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Opaque identity minted or supplied by an external protocol client. */
export type GatewayClientId = Branded<'ExternalGatewayClientId'>
/** Opaque identity assigned to one external delivery. */
export type GatewayDeliveryId = Branded<'ExternalGatewayDeliveryId'>
/** Opaque identity for a client-visible interaction. */
export type GatewayInteractionId = Branded<'ExternalGatewayInteractionId'>
/** Opaque identity for an outbox event. */
export type GatewayEventId = Branded<'ExternalGatewayEventId'>
/** Opaque identity assigned to one resumable binary upload. */
export type GatewayUploadId = Branded<'ExternalGatewayUploadId'>

/** A text block in a message submitted through the gateway. */
export interface GatewayTextContent {
  readonly type: 'text'
  readonly text: string
}

/** An encoded image admitted through the existing Session Controller. */
export interface GatewayImageContent {
  readonly type: 'image'
  /** Present for an inline image; omitted when `uploadId` names a completed upload. */
  readonly mediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** Canonical base64 image bytes for the inline form. */
  readonly data?: string
  /** Completed image upload to resolve on the Host before prompt admission. */
  readonly uploadId?: GatewayUploadId
  readonly name?: string
}

/** A completed upload resolved by the Host into an image or safe file-path prompt. */
export interface GatewayUploadContent {
  readonly type: 'upload'
  readonly uploadId: GatewayUploadId
}

/** Explicit file-upload spelling accepted as a message content block. */
export interface GatewayFileContent {
  readonly type: 'file'
  readonly uploadId: GatewayUploadId
}

/** A named skill reference selected by an external client. */
export interface GatewaySkillContent {
  readonly type: 'skill'
  readonly name: string
}

/** Content accepted in an ordinary Session message. */
export type GatewayMessageContent =
  | GatewayTextContent
  | GatewayImageContent
  | GatewayUploadContent
  | GatewayFileContent
  | GatewaySkillContent

/** Common fields carried by delivery payload variants. */
export interface GatewaySessionAddress {
  readonly accountId: string
  readonly peerId: string
}

/** Credential-derived identity used by storage and Session adapters. */
export interface GatewayPeerIdentity extends GatewaySessionAddress {
  readonly clientId: string
}

/** Create one gateway-owned, ungrouped Session. */
export interface GatewaySessionCreatePayload {
  readonly type: 'session-create'
  readonly title?: string
  readonly model?: GatewayModelSelection
  readonly permissionPreset?: string
}

/** Select one gateway-owned Session as active. */
export interface GatewaySessionSelectPayload {
  readonly type: 'session-select'
  readonly sessionId: SessionId
}

/** Rename one gateway-owned Session. */
export interface GatewaySessionRenamePayload {
  readonly type: 'session-rename'
  readonly sessionId: SessionId
  readonly title: string
}

/** Fork one gateway-owned Session. */
export interface GatewaySessionForkPayload {
  readonly type: 'session-fork'
  readonly sessionId: SessionId
  readonly eventSeq?: number
}

/** Cancel one active Session turn. */
export interface GatewaySessionCancelPayload {
  readonly type: 'session-cancel'
  readonly sessionId?: SessionId
}

/** A provider/model route selected for one Session. */
export interface GatewayModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Select a model for one gateway-owned Session. */
export interface GatewayModelSelectPayload {
  readonly type: 'model-select'
  readonly sessionId: SessionId
  readonly selection: GatewayModelSelection
}

/** Select one existing sandbox and approval preset for a Session. */
export interface GatewayPermissionSelectPayload {
  readonly type: 'permission-select'
  readonly sessionId: SessionId
  readonly preset: string
}

/** Submit one message to the active or explicitly named Session. */
export interface GatewayMessagePayload {
  readonly type: 'message'
  /** Gateway-reserved target when the message uses the active Session. */
  readonly sessionId?: SessionId
  readonly content: readonly GatewayMessageContent[]
  readonly mode?: 'queue' | 'steer'
}

/** Execute one session-level slash command without sending it to the model. */
export interface GatewayCommandPayload {
  readonly type: 'command'
  readonly sessionId?: SessionId
  readonly command: string
}

/** Answer one pending question interaction. */
export interface GatewayQuestionAnswerPayload {
  readonly type: 'question-answer'
  readonly interactionId: GatewayInteractionId
  readonly answers: readonly GatewayQuestionAnswer[]
}

/** One structured answer item for a question. */
export interface GatewayQuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Answer one pending approval interaction. */
export interface GatewayApprovalAnswerPayload {
  readonly type: 'approval-answer'
  readonly interactionId: GatewayInteractionId
  readonly outcome: 'allowed-once' | 'rejected'
}

/** Continue one gateway-owned subagent. */
export interface GatewaySubagentFollowupPayload {
  readonly type: 'subagent-followup'
  readonly sessionId: SessionId
  readonly agentId: string
  readonly content: readonly GatewayMessageContent[]
}

/** Interrupt one gateway-owned subagent. */
export interface GatewaySubagentInterruptPayload {
  readonly type: 'subagent-interrupt'
  readonly sessionId: SessionId
  readonly agentId: string
}

/** Request a durable export artifact for one Session. */
export interface GatewaySessionExportPayload {
  readonly type: 'session-export'
  readonly sessionId: SessionId
}

/** Every mutation accepted by `/v1/deliveries`. */
export type GatewayPayload =
  | GatewaySessionCreatePayload
  | GatewaySessionSelectPayload
  | GatewaySessionRenamePayload
  | GatewaySessionForkPayload
  | GatewaySessionCancelPayload
  | GatewayModelSelectPayload
  | GatewayPermissionSelectPayload
  | GatewayMessagePayload
  | GatewayCommandPayload
  | GatewayQuestionAnswerPayload
  | GatewayApprovalAnswerPayload
  | GatewaySubagentFollowupPayload
  | GatewaySubagentInterruptPayload
  | GatewaySessionExportPayload

/** One accepted mutation before it is placed in the durable inbox. */
export interface GatewayDelivery extends GatewaySessionAddress {
  readonly deliveryId: GatewayDeliveryId
  readonly payload: GatewayPayload
}

/** Delivery lifecycle persisted by the gateway. */
export type GatewayDeliveryStatus = 'pending' | 'completed' | 'failed'

/** One durable inbox record. */
export interface GatewayDeliveryRecord extends GatewayDelivery {
  readonly clientId: GatewayClientId
  readonly digest: string
  readonly status: GatewayDeliveryStatus
  /** Session id reserved before an auto-create operation is dispatched. */
  readonly reservedSessionId?: SessionId
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly result?: JsonValue
}

/** Event names emitted through `/v1/events`. */
export type GatewayEventType =
  | 'delivery-completed'
  | 'delivery-failed'
  | 'session-created'
  | 'session-selected'
  | 'session-updated'
  | 'session-event'
  | 'assistant-final'
  | 'question'
  | 'approval'
  | 'interaction-expired'
  | 'subagent-started'
  | 'subagent-finished'
  | 'artifact-ready'
  | 'turn-failed'

/** A structured question offered to an external client. */
export interface GatewayQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  /** Presentation intent copied from the Host user-question request. */
  readonly intent?: AskUserQuestionIntent
}

/** Kind of data admitted by the resumable upload protocol. */
export type GatewayUploadKind = 'image' | 'file'
/** Lifecycle of one gateway upload. */
export type GatewayUploadStatus = 'pending' | 'completed'

/** One persisted binary upload part. */
export interface GatewayUploadPartRecord {
  readonly partNumber: number
  readonly bytes: number
  readonly digest: string
  /** Owner-private temporary path; never accepted from the wire. */
  readonly path: string
}

/** Durable owner-scoped metadata and received-part state for one upload. */
export interface GatewayUploadRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly uploadId: GatewayUploadId
  readonly kind: GatewayUploadKind
  readonly filename: string
  readonly contentType: string
  readonly size: number
  readonly sha256?: string
  readonly chunkSize: number
  readonly totalParts: number
  readonly parts: readonly GatewayUploadPartRecord[]
  /** Owner-private completed path under the fixed gateway cwd. */
  readonly path: string
  readonly status: GatewayUploadStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
}

/** Client metadata used to create or resume one upload. */
export interface GatewayUploadInitRequest extends GatewaySessionAddress {
  /** Optional client-chosen id used for idempotent initiation retries. */
  readonly uploadId?: GatewayUploadId
  readonly kind: GatewayUploadKind
  readonly filename: string
  readonly contentType: string
  readonly size: number
  readonly sha256?: string
}

/** Optional checksum supplied when committing an upload. */
export interface GatewayUploadCompleteRequest {
  readonly sha256?: string
}

/** Public metadata returned by upload endpoints. */
export interface GatewayUploadReceipt {
  readonly uploadId: GatewayUploadId
  readonly status: GatewayUploadStatus
  readonly kind: GatewayUploadKind
  readonly filename: string
  readonly contentType: string
  readonly size: number
  readonly chunkSize: number
  readonly totalParts: number
  readonly receivedParts: readonly number[]
  readonly sha256?: string
  /** Content block that can be embedded in a later `message` delivery. */
  readonly content: GatewayUploadContent
}

/** Event payloads stored in the durable outbox. */
export type GatewayEventPayload =
  | { readonly type: 'delivery-completed'; readonly deliveryId: GatewayDeliveryId; readonly result?: JsonValue }
  | { readonly type: 'delivery-failed'; readonly deliveryId: GatewayDeliveryId; readonly code: string; readonly message: string }
  | { readonly type: 'session-created'; readonly sessionId: SessionId }
  | { readonly type: 'session-selected'; readonly sessionId: SessionId }
  | { readonly type: 'session-updated'; readonly sessionId: SessionId; readonly changes: JsonValue }
  | { readonly type: 'session-event'; readonly sessionId: SessionId; readonly event: JsonValue }
  | { readonly type: 'assistant-final'; readonly sessionId: SessionId; readonly text: string }
  | { readonly type: 'question'; readonly sessionId: SessionId; readonly interactionId: GatewayInteractionId; readonly expiresAt: number; readonly questions: readonly GatewayQuestion[] }
  | { readonly type: 'approval'; readonly sessionId: SessionId; readonly interactionId: GatewayInteractionId; readonly expiresAt: number; readonly toolName: string; readonly reason?: string }
  | { readonly type: 'interaction-expired'; readonly sessionId: SessionId; readonly interactionId: GatewayInteractionId; readonly kind: 'question' | 'approval' }
  | { readonly type: 'subagent-started'; readonly sessionId: SessionId; readonly agentId: string }
  | { readonly type: 'subagent-finished'; readonly sessionId: SessionId; readonly agentId: string; readonly result?: JsonValue }
  | { readonly type: 'artifact-ready'; readonly sessionId: SessionId; readonly artifactId: string }
  | { readonly type: 'turn-failed'; readonly sessionId: SessionId; readonly message: string }

/** One outbox event returned to a client. */
export interface GatewayEvent {
  readonly clientId: GatewayClientId
  readonly sequence: number
  readonly eventId: GatewayEventId
  readonly accountId: string
  readonly peerId: string
  readonly sessionId?: SessionId
  readonly causedByDeliveryId?: GatewayDeliveryId
  readonly payload: GatewayEventPayload
  readonly createdAt: number
}

/** Durable outbox record. */
export interface GatewayOutboxRecord extends GatewayEvent {
  readonly acknowledged?: boolean
}

/** Sequence state for one authenticated client. */
export interface GatewayClientStateRecord {
  readonly clientId: GatewayClientId
  readonly nextSequence: number
  readonly acknowledgedSequence: number
}

/** Session ownership persisted by the gateway. */
export interface GatewaySessionOwnershipRecord {
  readonly clientId: GatewayClientId
  readonly accountId: string
  readonly peerId: string
  readonly sessionId: SessionId
  readonly cwd: string
  readonly createdAt: number
  readonly status: 'pending' | 'ready'
  readonly active: boolean
}

/** Active-session mapping for one client/account/peer conversation. */
export interface GatewayConversationRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly sessionId?: SessionId
  readonly updatedAt: number
}

/** Persisted ownership and lifetime of a question or approval interaction. */
export interface GatewayInteractionRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly sessionId: SessionId
  readonly interactionId: GatewayInteractionId
  readonly kind: 'question' | 'approval'
  readonly expiresAt: number
  readonly status: 'pending' | 'answered' | 'expired'
}

/** Last Session event durably copied into the gateway outbox. */
export interface GatewayProjectionCursorRecord {
  readonly sessionId: SessionId
  readonly sequence: number
}

/** Durable metadata for a peer-owned downloadable artifact. */
export interface GatewayArtifactRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly artifactId: string
  readonly sessionId: SessionId
  readonly path: string
  readonly filename: string
  readonly contentType: string
  readonly createdAt: number
}

/** One client declaration accepted by the gateway. */
export interface GatewayClientConfig {
  readonly clientId: string
  readonly tokenFile: string
  readonly accountIds?: readonly string[]
  readonly peerIds?: readonly string[]
}

/** Runtime policy loaded by the Cordis plugin. */
export interface ExternalGatewayConfig {
  readonly tokenFile: string
  readonly artifactDirectory: string
  readonly clientId: string
  readonly accountIds: string[]
  readonly peerIds: string[]
  readonly maxBodyBytes: number
  readonly maxTextBytes: number
  readonly maxEvents: number
  readonly maxPollMs: number
  readonly completedRetentionMs: number
  readonly maxOutbox: number
  readonly interactionTimeoutMs: number
  readonly maxUploadBytes: number
  readonly maxImageBytes: number
  readonly startupCwd?: string
}

/** Runtime address and payload handed to a Session adapter. */
export interface ExternalGatewayDispatchRequest extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly deliveryId: GatewayDeliveryId
  readonly payload: GatewayPayload
  /** Reserved id for a create or auto-create message operation. */
  readonly reservedSessionId?: SessionId
  readonly cwd: string
}

/** Result of one adapter mutation. */
export interface ExternalGatewayDispatchResult {
  readonly sessionId?: SessionId
  readonly result?: JsonValue
}

/** Query operation exposed by the unified external protocol. */
export type ExternalGatewayQueryOperation =
  | 'sessions'
  | 'session'
  | 'history'
  | 'models'
  | 'skills'
  | 'subagents'
  | 'artifact'

/** Read-only operation handed to the Session adapter. */
export interface ExternalGatewayQueryRequest extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly operation: ExternalGatewayQueryOperation
  readonly sessionId?: SessionId
  readonly artifactId?: string
  readonly cursor?: string
  readonly limit?: number
}

/** JSON response from a query operation. */
export interface ExternalGatewayJsonQueryResult {
  readonly kind: 'json'
  readonly value: JsonValue
}

/** Binary response from an artifact operation. */
export interface ExternalGatewayBytesQueryResult {
  readonly kind: 'bytes'
  readonly contentType: string
  readonly body: Uint8Array
  readonly filename?: string
}

/** Result of a read-only operation. */
export type ExternalGatewayQueryResult = ExternalGatewayJsonQueryResult | ExternalGatewayBytesQueryResult

/** Runtime event emitted after the Session adapter observes a gateway-owned Session. */
export interface ExternalGatewayRuntimeEvent extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly sessionId: SessionId
  readonly payload: GatewayEventPayload
  /** Durable Session event sequence used for crash-safe replay and deduplication. */
  readonly sourceSequence?: number
  readonly interaction?: Omit<GatewayInteractionRecord, 'status'>
}

/** Adapter implemented by the Session-runtime package. */
export interface ExternalGatewayRuntime {
  /** Fixed cwd used for every new gateway-owned Session. */
  readonly startupCwd: string
  /** Execute one durable mutation against a gateway-owned Session. */
  dispatch(request: ExternalGatewayDispatchRequest, signal: AbortSignal): Promise<ExternalGatewayDispatchResult>
  /** Read one gateway-owned projection or artifact. */
  query(request: ExternalGatewayQueryRequest, signal: AbortSignal): Promise<ExternalGatewayQueryResult>
  /** Subscribe to final replies, questions, approvals, and Session events. */
  subscribe(listener: (event: ExternalGatewayRuntimeEvent) => Promise<void>): () => void
  /** Replay durable Session events that have not reached the gateway outbox. */
  replay(): Promise<void>
}

/** Route registration surface used by the HTTP carrier. */
export interface GatewayHttpCarrier {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade?(route: {
    readonly path: string
    readonly handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

/** Public projection of one stored delivery accepted by the API. */
export interface GatewayDeliveryReceipt {
  readonly deliveryId: GatewayDeliveryId
  readonly status: GatewayDeliveryStatus
  readonly duplicate?: boolean
}
