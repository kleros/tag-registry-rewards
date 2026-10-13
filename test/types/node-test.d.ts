// The subset of node:test the tests use. The installed @types/node (v14, kept
// for TypeScript 3.9) predates the built-in test runner.
declare module "node:test" {
  interface TestOptions {
    timeout?: number
    skip?: boolean | string
    todo?: boolean | string
    only?: boolean
    concurrency?: number | boolean
  }

  interface MockFunctionCall {
    arguments: any[]
    result: any
    error: unknown
  }

  interface MockFunctionContext {
    calls: MockFunctionCall[]
    callCount(): number
    mockImplementation(impl: (...args: any[]) => any): void
  }

  type Mock<F> = F & { mock: MockFunctionContext }

  interface MockTracker {
    fn<F extends (...args: any[]) => any>(original?: F, implementation?: F): Mock<F>
    method(object: object, methodName: string, implementation?: (...args: any[]) => any): Mock<(...args: any[]) => any>
    restoreAll(): void
    reset(): void
  }

  interface TestContext {
    readonly name: string
    readonly mock: MockTracker
    diagnostic(message: string): void
    skip(message?: string): void
    todo(message?: string): void
    after(fn: () => void | Promise<void>): void
  }

  type TestFn = (t: TestContext) => void | Promise<void>
  type SuiteFn = () => void | Promise<void>
  type HookFn = () => void | Promise<void>

  export function test(name: string, fn: TestFn): Promise<void>
  export function test(name: string, options: TestOptions, fn: TestFn): Promise<void>
  export function it(name: string, fn: TestFn): Promise<void>
  export function it(name: string, options: TestOptions, fn: TestFn): Promise<void>
  export function describe(name: string, fn: SuiteFn): Promise<void>
  export function describe(name: string, options: TestOptions, fn: SuiteFn): Promise<void>
  export function before(fn: HookFn): void
  export function after(fn: HookFn): void
  export function beforeEach(fn: HookFn): void
  export function afterEach(fn: HookFn): void
  export const mock: MockTracker
}
