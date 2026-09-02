/** Strict wire and durable-record schemas for the External Gateway. */

import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  GatewayArtifactRecord,
  GatewayUploadRecord,
  GatewayClientStateRecord,
  GatewayConversationRecord,
  GatewayDelivery,
  GatewayDeliveryRecord,
  GatewayEvent,
  GatewayEventPayload,
  GatewayInteractionRecord,
  GatewayUploadCompleteRequest,
  GatewayUploadInitRequest,
  GatewayPayload,
  GatewayProjectionCursorRecord,
  GatewaySessionOwnershipRecord,
} from './types.ts'

/** Maximum length of one opaque protocol identity. */
export const MAX_ID_LENGTH = 512
/** Maximum text length accepted in one message block. */
export const MAX_TEXT_LENGTH = 1_000_000
/** Maximum number of message blocks in one delivery. */
export const MAX_CONTENT_BLOCKS = 128
/** Maximum number of choices in one question answer. */
export const MAX_QUESTION_ANSWERS = 128
/** Maximum bytes admitted by one resumable upload part. */
export const GATEWAY_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
/** Maximum complete file upload size accepted by the gateway. */
export const MAX_GATEWAY_UPLOAD_BYTES = 100 * 1024 * 1024
/** Maximum complete image upload size accepted by the gateway. */
export const MAX_GATEWAY_IMAGE_BYTES = 20 * 1024 * 1024
/** Maximum UTF-8 bytes retained in one uploaded filename. */
export const MAX_UPLOAD_FILENAME_BYTES = 255

/** A non-empty, trimmed opaque string at a wire boundary. */
export const opaqueStringSchema = z.string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .refine(value => value.trim() === value && value.length > 0, 'value must be trimmed and non-empty')

/** A non-negative safe integer used for sequence, timestamp, and cursor fields. */
export const safeIntegerSchema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

/** Lossless JSON data accepted in event projections and runtime results. */
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]))

/** A Session id with its compile-time brand restored after JSON parsing. */
export const sessionIdSchema = opaqueStringSchema.transform(value => value as SessionId)

/** A message text block. */
export const gatewayTextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

/** An encoded image promoted to durable Session attachment storage by the Host. */
export const gatewayImageContentSchema = z.object({
  type: z.literal('image'),
  mediaType: z.union([
    z.literal('image/png'),
    z.literal('image/jpeg'),
    z.literal('image/webp'),
    z.literal('image/gif'),
  ]).optional(),
  data: z.string().min(1).optional(),
  uploadId: opaqueStringSchema.optional(),
  name: z.string().min(1).max(MAX_ID_LENGTH).optional(),
}).strict().refine(value => (value.data === undefined) !== (value.uploadId === undefined), {
  message: 'image content must provide exactly one of data or uploadId',
})

/** A completed upload referenced by a later Session message. */
export const gatewayUploadContentSchema = z.object({
  type: z.literal('upload'),
  uploadId: opaqueStringSchema,
}).strict()

/** Explicit file-upload reference accepted by the message protocol. */
export const gatewayFileContentSchema = z.object({
  type: z.literal('file'),
  uploadId: opaqueStringSchema,
}).strict()

/** A named skill reference carried by a message. */
export const gatewaySkillContentSchema = z.object({
  type: z.literal('skill'),
  name: opaqueStringSchema,
}).strict()

/** Content blocks accepted by the external message operation. */
export const gatewayMessageContentSchema = z.discriminatedUnion('type', [
  gatewayTextContentSchema,
  gatewayImageContentSchema,
  gatewayUploadContentSchema,
  gatewayFileContentSchema,
  gatewaySkillContentSchema,
])

const modelSelectionSchema = z.object({
  provider: opaqueStringSchema,
  model: opaqueStringSchema,
  reasoningEffort: opaqueStringSchema.optional(),
}).strict()

const questionAnswerSchema = z.object({
  id: opaqueStringSchema,
  selected: z.array(opaqueStringSchema).max(MAX_QUESTION_ANSWERS),
  custom: z.string().max(MAX_TEXT_LENGTH).optional(),
}).strict()

const sessionCreatePayloadSchema = z.object({
  type: z.literal('session-create'),
  title: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  model: modelSelectionSchema.optional(),
  permissionPreset: opaqueStringSchema.optional(),
}).strict()

const sessionSelectPayloadSchema = z.object({
  type: z.literal('session-select'),
  sessionId: sessionIdSchema,
}).strict()

const sessionRenamePayloadSchema = z.object({
  type: z.literal('session-rename'),
  sessionId: sessionIdSchema,
  title: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

const sessionForkPayloadSchema = z.object({
  type: z.literal('session-fork'),
  sessionId: sessionIdSchema,
  eventSeq: safeIntegerSchema.optional(),
}).strict()

const sessionCancelPayloadSchema = z.object({
  type: z.literal('session-cancel'),
  sessionId: sessionIdSchema.optional(),
}).strict()

const modelSelectPayloadSchema = z.object({
  type: z.literal('model-select'),
  sessionId: sessionIdSchema,
  selection: modelSelectionSchema,
}).strict()

const permissionSelectPayloadSchema = z.object({
  type: z.literal('permission-select'),
  sessionId: sessionIdSchema,
  preset: opaqueStringSchema,
}).strict()

const messagePayloadSchema = z.object({
  type: z.literal('message'),
  sessionId: sessionIdSchema.optional(),
  content: z.array(gatewayMessageContentSchema).min(1).max(MAX_CONTENT_BLOCKS),
  mode: z.union([z.literal('queue'), z.literal('steer')]).optional(),
}).strict()

const commandPayloadSchema = z.object({
  type: z.literal('command'),
  sessionId: sessionIdSchema.optional(),
  command: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

const questionAnswerPayloadSchema = z.object({
  type: z.literal('question-answer'),
  interactionId: opaqueStringSchema,
  answers: z.array(questionAnswerSchema).max(MAX_QUESTION_ANSWERS),
}).strict()

const approvalAnswerPayloadSchema = z.object({
  type: z.literal('approval-answer'),
  interactionId: opaqueStringSchema,
  outcome: z.union([z.literal('allowed-once'), z.literal('rejected')]),
}).strict()

const subagentFollowupPayloadSchema = z.object({
  type: z.literal('subagent-followup'),
  sessionId: sessionIdSchema,
  agentId: opaqueStringSchema,
  content: z.array(gatewayMessageContentSchema).min(1).max(MAX_CONTENT_BLOCKS),
}).strict()

const subagentInterruptPayloadSchema = z.object({
  type: z.literal('subagent-interrupt'),
  sessionId: sessionIdSchema,
  agentId: opaqueStringSchema,
}).strict()

const sessionExportPayloadSchema = z.object({
  type: z.literal('session-export'),
  sessionId: sessionIdSchema,
}).strict()

/** Strict discriminated union for every mutation operation. */
export const gatewayPayloadSchema: z.ZodType<GatewayPayload> = z.discriminatedUnion('type', [
  sessionCreatePayloadSchema,
  sessionSelectPayloadSchema,
  sessionRenamePayloadSchema,
  sessionForkPayloadSchema,
  sessionCancelPayloadSchema,
  modelSelectPayloadSchema,
  permissionSelectPayloadSchema,
  messagePayloadSchema,
  commandPayloadSchema,
  questionAnswerPayloadSchema,
  approvalAnswerPayloadSchema,
  subagentFollowupPayloadSchema,
  subagentInterruptPayloadSchema,
  sessionExportPayloadSchema,
]) as unknown as z.ZodType<GatewayPayload>

/** Strict request body for `POST /v1/deliveries`. */
export const gatewayDeliverySchema: z.ZodType<GatewayDelivery> = z.object({
  deliveryId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  payload: gatewayPayloadSchema,
}).strict() as unknown as z.ZodType<GatewayDelivery>

/** Strict request body for `POST /v1/events/ack`. */
export const gatewayAckSchema = z.object({
  upToSequence: safeIntegerSchema,
}).strict()

const uploadDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const uploadKindSchema = z.union([z.literal('image'), z.literal('file')])

/** Strict metadata body for `POST /v1/uploads`. */
export const gatewayUploadInitSchema: z.ZodType<GatewayUploadInitRequest> = z.object({
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  uploadId: opaqueStringSchema.optional(),
  kind: uploadKindSchema,
  filename: z.string().min(1).max(MAX_TEXT_LENGTH),
  contentType: z.string().min(1).max(MAX_ID_LENGTH),
  size: safeIntegerSchema,
  sha256: uploadDigestSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayUploadInitRequest>

/** Strict optional checksum body for `POST /v1/uploads/:id/complete`. */
export const gatewayUploadCompleteSchema: z.ZodType<GatewayUploadCompleteRequest> = z.object({
  sha256: uploadDigestSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayUploadCompleteRequest>

const questionOptionSchema = z.object({
  label: z.string().min(1).max(MAX_TEXT_LENGTH),
  description: z.string().max(MAX_TEXT_LENGTH).optional(),
}).strict()

const questionIntentSchema = z.object({
  kind: z.literal('plan-review'),
  approve: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

const questionSchema = z.object({
  id: opaqueStringSchema,
  question: z.string().min(1).max(MAX_TEXT_LENGTH),
  detail: z.string().max(MAX_TEXT_LENGTH).optional(),
  header: z.string().max(MAX_ID_LENGTH).optional(),
  options: z.array(questionOptionSchema).max(MAX_QUESTION_ANSWERS).optional(),
  multiSelect: z.boolean().optional(),
  intent: questionIntentSchema.optional(),
}).strict()

const eventPayloadSchemas = [
  z.object({ type: z.literal('delivery-completed'), deliveryId: opaqueStringSchema, result: jsonValueSchema.optional() }).strict(),
  z.object({ type: z.literal('delivery-failed'), deliveryId: opaqueStringSchema, code: opaqueStringSchema, message: z.string().min(1).max(MAX_TEXT_LENGTH) }).strict(),
  z.object({ type: z.literal('session-created'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('session-selected'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('session-updated'), sessionId: sessionIdSchema, changes: jsonValueSchema }).strict(),
  z.object({ type: z.literal('session-event'), sessionId: sessionIdSchema, event: jsonValueSchema }).strict(),
  z.object({ type: z.literal('assistant-final'), sessionId: sessionIdSchema, text: z.string().max(MAX_TEXT_LENGTH) }).strict(),
  z.object({ type: z.literal('question'), sessionId: sessionIdSchema, interactionId: opaqueStringSchema, expiresAt: safeIntegerSchema, questions: z.array(questionSchema).min(1).max(MAX_QUESTION_ANSWERS) }).strict(),
  z.object({ type: z.literal('approval'), sessionId: sessionIdSchema, interactionId: opaqueStringSchema, expiresAt: safeIntegerSchema, toolName: opaqueStringSchema, reason: z.string().max(MAX_TEXT_LENGTH).optional() }).strict(),
  z.object({ type: z.literal('interaction-expired'), sessionId: sessionIdSchema, interactionId: opaqueStringSchema, kind: z.union([z.literal('question'), z.literal('approval')]) }).strict(),
  z.object({ type: z.literal('subagent-started'), sessionId: sessionIdSchema, agentId: opaqueStringSchema }).strict(),
  z.object({ type: z.literal('subagent-finished'), sessionId: sessionIdSchema, agentId: opaqueStringSchema, result: jsonValueSchema.optional() }).strict(),
  z.object({ type: z.literal('artifact-ready'), sessionId: sessionIdSchema, artifactId: opaqueStringSchema }).strict(),
  z.object({ type: z.literal('turn-failed'), sessionId: sessionIdSchema, message: z.string().min(1).max(MAX_TEXT_LENGTH) }).strict(),
] as const

/** Strict event payload schema for durable outbox rows. */
export const gatewayEventPayloadSchema: z.ZodType<GatewayEventPayload> = z.discriminatedUnion(
  'type', eventPayloadSchemas,
) as unknown as z.ZodType<GatewayEventPayload>

/** Strict durable inbox record schema. */
export const gatewayDeliveryRecordSchema: z.ZodType<GatewayDeliveryRecord> = z.object({
  deliveryId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  payload: gatewayPayloadSchema,
  clientId: opaqueStringSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.union([z.literal('pending'), z.literal('completed'), z.literal('failed')]),
  reservedSessionId: sessionIdSchema.optional(),
  attempts: safeIntegerSchema,
  createdAt: safeIntegerSchema,
  updatedAt: safeIntegerSchema,
  completedAt: safeIntegerSchema.optional(),
  errorCode: opaqueStringSchema.optional(),
  errorMessage: z.string().max(MAX_TEXT_LENGTH).optional(),
  result: jsonValueSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayDeliveryRecord>

/** Strict durable outbox event schema. */
export const gatewayEventSchema: z.ZodType<GatewayEvent> = z.object({
  clientId: opaqueStringSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema.optional(),
  causedByDeliveryId: opaqueStringSchema.optional(),
  payload: gatewayEventPayloadSchema,
  createdAt: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayEvent>

/** Strict client sequence state schema. */
export const gatewayClientStateSchema: z.ZodType<GatewayClientStateRecord> = z.object({
  clientId: opaqueStringSchema,
  nextSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  acknowledgedSequence: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayClientStateRecord>

/** Strict Session ownership schema. */
export const gatewaySessionOwnershipSchema: z.ZodType<GatewaySessionOwnershipRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema,
  cwd: z.string().min(1).max(MAX_TEXT_LENGTH),
  createdAt: safeIntegerSchema,
  status: z.union([z.literal('pending'), z.literal('ready')]),
  active: z.boolean(),
}).strict() as unknown as z.ZodType<GatewaySessionOwnershipRecord>

/** Strict active conversation mapping schema. */
export const gatewayConversationSchema: z.ZodType<GatewayConversationRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema.optional(),
  updatedAt: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayConversationRecord>

/** Strict interaction ownership schema. */
export const gatewayInteractionSchema: z.ZodType<GatewayInteractionRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema,
  interactionId: opaqueStringSchema,
  kind: z.union([z.literal('question'), z.literal('approval')]),
  expiresAt: safeIntegerSchema,
  status: z.union([z.literal('pending'), z.literal('answered'), z.literal('expired')]),
}).strict() as unknown as z.ZodType<GatewayInteractionRecord>

/** Durable cursor for Session-log to gateway-outbox projection. */
export const gatewayProjectionCursorSchema: z.ZodType<GatewayProjectionCursorRecord> = z.object({
  sessionId: sessionIdSchema,
  sequence: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayProjectionCursorRecord>

/** Durable peer ownership and file metadata for one export artifact. */
export const gatewayArtifactSchema: z.ZodType<GatewayArtifactRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  artifactId: opaqueStringSchema,
  sessionId: sessionIdSchema,
  path: z.string().min(1),
  filename: z.string().min(1).max(MAX_ID_LENGTH),
  contentType: z.string().min(1).max(MAX_ID_LENGTH),
  createdAt: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayArtifactRecord>

/** Strict durable resumable-upload metadata and part state. */
export const gatewayUploadRecordSchema: z.ZodType<GatewayUploadRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  uploadId: opaqueStringSchema,
  kind: z.union([z.literal('image'), z.literal('file')]),
  filename: z.string().min(1).max(MAX_UPLOAD_FILENAME_BYTES),
  contentType: z.string().min(1).max(MAX_ID_LENGTH),
  size: safeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  chunkSize: z.literal(GATEWAY_UPLOAD_CHUNK_BYTES),
  totalParts: safeIntegerSchema,
  parts: z.array(z.object({
    partNumber: safeIntegerSchema,
    bytes: safeIntegerSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    path: z.string().min(1),
  }).strict()),
  path: z.string().min(1),
  status: z.union([z.literal('pending'), z.literal('completed')]),
  createdAt: safeIntegerSchema,
  updatedAt: safeIntegerSchema,
  completedAt: safeIntegerSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayUploadRecord>

/** Durable inbox/outbox domain schemas exported for tests and adapters. */
export const gatewayRecordSchemas = {
  delivery: gatewayDeliveryRecordSchema,
  event: gatewayEventSchema,
  clientState: gatewayClientStateSchema,
  sessionOwnership: gatewaySessionOwnershipSchema,
  conversation: gatewayConversationSchema,
  interaction: gatewayInteractionSchema,
  projectionCursor: gatewayProjectionCursorSchema,
  artifact: gatewayArtifactSchema,
  upload: gatewayUploadRecordSchema,
} as const
