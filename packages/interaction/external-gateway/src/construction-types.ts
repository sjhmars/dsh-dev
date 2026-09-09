/** 网关内部对象构造使用的类型；对外 DTO 仍保持只读。 */

/** 仅在对象交给存储或调用方之前允许逐字段赋值，不改变嵌套值的只读约束。 */
export type GatewayDraft<T> = { -readonly [K in keyof T]: T[K] }
