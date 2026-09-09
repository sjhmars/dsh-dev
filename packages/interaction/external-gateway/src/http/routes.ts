/** /v1 路由及 DTO 绑定；路径解析、状态码与 Node 请求只存在于 HTTP 适配层。 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ExternalGatewayHttpOptions } from './types.ts'
import { GatewayHttpTransport, dtoResult, type HttpRequestContext, type HttpResult } from './transport.ts'
import { method, readRawBody } from './request.ts'
import { jsonResponse } from './response.ts'
import { HttpInputError } from './errors.ts'
import {
  deliveryRequest, eventsRequest, ackRequest, peerRequest, sessionRequest, artifactRequest,
  uploadCreateRequest, uploadRequest, uploadCompleteRequest, uploadPartNumber, pathParts,
} from '../protocol/requests.ts'
import { GATEWAY_UPLOAD_CHUNK_BYTES } from '../schema.ts'
import { DeliveryController } from '../controllers/delivery-controller.ts'
import { EventController } from '../controllers/event-controller.ts'
import { SessionController } from '../controllers/session-controller.ts'
import { ArtifactController } from '../controllers/artifact-controller.ts'
import { UploadController } from '../controllers/upload-controller.ts'

/**
 * 组装路由与具体控制器，不注册路由或启动 HTTP Server。
 * @param options - 业务和传输依赖。
 * @returns 可释放注册的路由声明。
 */
export function gatewayRoutes(options: ExternalGatewayHttpOptions): readonly WebRoute[] {
  const transport = new GatewayHttpTransport(options)
  const delivery = new DeliveryController(options.store, options.worker)
  const event = new EventController(options.store, options.worker)
  const session = new SessionController(options.store, options.runtime)
  const artifact = new ArtifactController(options.runtime)
  const upload = new UploadController(options.store)

  const bind = (
    expectedMethod: string | undefined,
    run: (req: IncomingMessage, res: ServerResponse, context: HttpRequestContext) => Promise<HttpResult>,
  ): WebRoute['handler'] => (req, res) => transport.handle(req, res, expectedMethod, context => run(req, res, context))

  return [
    {
      kind: 'exact', path: '/healthz',
      handler: (req, res) => {
        if (method(req, res, 'GET')) jsonResponse(res, 200, { status: 'ok' })
      },
    },
    {
      kind: 'exact', path: '/v1/deliveries',
      handler: bind('POST', async (req, _res, context) => {
        const request = deliveryRequest(await transport.body(req), context.clientId, options.config)
        transport.allow(request.delivery)
        const receipt = await delivery.delivery(request)
        if (receipt.duplicate === true) {
          return dtoResult(200, receipt)
        }
        return dtoResult(202, receipt)
      }),
    },
    {
      kind: 'exact', path: '/v1/events',
      handler: bind('GET', async (_req, _res, context) => dtoResult(
        200,
        await event.events(eventsRequest(context.url.searchParams, context.clientId, options.config), context.signal),
      )),
    },
    {
      kind: 'exact', path: '/v1/events/ack',
      handler: bind('POST', async (req, _res, context) => dtoResult(
        200, await event.ack(ackRequest(await transport.body(req), context.clientId)),
      )),
    },
    {
      kind: 'exact', path: '/v1/uploads',
      handler: bind(undefined, async (req, res, context) => {
        if (req.method === 'GET') {
          const peer = peerRequest(context.url.searchParams, context.clientId)
          transport.allow(peer)
          return dtoResult(200, upload.list(peer))
        }
        if (!method(req, res, 'POST')) return { kind: 'empty' }
        const request = uploadCreateRequest(await transport.body(req), context.clientId, options.config)
        transport.allow(request.upload)
        const result = await upload.create(request)
        if (result.duplicate) {
          return dtoResult(200, result.upload)
        }
        return dtoResult(201, result.upload)
      }),
    },
    {
      kind: 'prefix', path: '/v1/uploads',
      handler: bind(undefined, async (req, res, context) => {
        const parts = pathParts(context.url.pathname, '/v1/uploads')
        if (parts.length === 0) throw new HttpInputError(404, 'not_found', 'resource was not found')
        const peer = peerRequest(context.url.searchParams, context.clientId)
        const request = uploadRequest(parts, peer)
        transport.allow(peer)
        if (parts.length === 1) {
          if (!method(req, res, 'GET')) return { kind: 'empty' }
          return dtoResult(200, upload.get(request))
        }
        if (parts.length === 2 && parts[1] === 'content') {
          if (!method(req, res, 'GET')) return { kind: 'empty' }
          return { kind: 'query', result: await upload.content(request) }
        }
        if (parts.length === 2 && parts[1] === 'complete') {
          if (!method(req, res, 'POST')) return { kind: 'empty' }
          return dtoResult(200, await upload.complete(uploadCompleteRequest(await transport.body(req, true), request)))
        }
        if (parts.length === 3 && parts[1] === 'parts') {
          if (!method(req, res, 'PUT')) return { kind: 'empty' }
          const partNumber = uploadPartNumber(parts[2] as string)
          const bytes = await readRawBody(req, GATEWAY_UPLOAD_CHUNK_BYTES, 'upload')
          return dtoResult(200, await upload.part({ ...request, partNumber, bytes }))
        }
        throw new HttpInputError(404, 'not_found', 'resource was not found')
      }),
    },
    {
      kind: 'prefix', path: '/v1/sessions',
      handler: bind('GET', async (_req, _res, context) => {
        const parts = pathParts(context.url.pathname, '/v1/sessions')
        const peer = peerRequest(context.url.searchParams, context.clientId)
        transport.allow(peer)
        const request = sessionRequest(parts, context.url.searchParams, peer, options.config)
        return { kind: 'query', result: await session.sessions(request, context.signal) }
      }),
    },
    {
      kind: 'prefix', path: '/v1/artifacts',
      handler: bind('GET', async (_req, _res, context) => {
        const parts = pathParts(context.url.pathname, '/v1/artifacts')
        if (parts.length !== 1) throw new HttpInputError(404, 'not_found', 'resource was not found')
        const peer = peerRequest(context.url.searchParams, context.clientId)
        transport.allow(peer)
        return { kind: 'query', result: await artifact.artifact(artifactRequest(parts, peer), context.signal) }
      }),
    },
  ]
}
