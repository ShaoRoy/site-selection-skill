/**
 * DSH 运行时的最小类型桩。
 *
 * 发布包里不带 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`（由宿主提供），
 * 但没有声明 `tsc` 连模块都解析不了。这里给最小可用声明，
 * 让 `npm run typecheck` 在离线环境也能跑起来。
 *
 * 边界说明（诚实标注）：
 *  · 引擎自身的类型（接口、联合、schema 常量、财务计算）会被**完整检查**
 *  · 只有「宿主是否会拒绝这份 schema」这一层无法在包内验证——
 *    因为宿主用泛型把 parameters/output 收敛成严格类型，这里只能退化成宽松签名
 *  · 在完整开发工作区（装了宿主依赖）里本桩不生效，真实模块优先
 *
 * 为什么要用 any：宿主签名会给 render/execute 的回调参数**上下文类型**；
 * 桩若不给上下文类型，strict 模式下会报 40+ 个 implicit any，
 * 那是假错，会把真实错误淹没。
 */

declare module '@deepseek-ai/cordis' {
  /** 插件上下文：只需 tools 服务的注册能力 */
  export interface Context {
    tools: {
      register(definition: unknown): () => void
    }
    on?(event: string, handler: (...args: any[]) => void): void
  }
}

declare module '@deepseek-ai/dsh-tools' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type AnyFn = (...args: any[]) => any

  /** 工具定义的可识别字段；回调一律给宽松签名，避免桩产生假错 */
  export interface ToolDefinitionLike {
    name: string
    description: string
    parameters?: any
    output?: {
      schema?: any
      render?: AnyFn
    }
    execute: AnyFn
  }

  /**
   * 工具定义构造器。返回传入的对象本身（恒等），
   * 因此 `tool.execute(...)` 的返回类型仍由引擎自己的 async 函数推断。
   */
  export function defineTool<T extends ToolDefinitionLike>(definition: T): T
}
