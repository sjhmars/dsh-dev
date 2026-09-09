/** External Gateway 包自有的不变量配套插件。 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-external-gateway'

/** Cordis 配套插件名称。 */
export const name = 'external-gateway-invariant'
/** 注册前必须提供不变量注册表。 */
export const inject = ['invariants']

/**
 * storage-domain 的结构校验和序号检查在其所属的
 * 持久化边界执行；本包没有需要额外审计的第二条可变事件流。
 */
const install: InvariantInstaller = (_ctx: Context) => {}

/**
 * 注册本包的不变量配套插件。
 * @param ctx - 提供不变量服务的上下文。
 * @returns 注册释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
