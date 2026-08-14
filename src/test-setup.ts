import '@testing-library/jest-dom'
// IndexedDB for the v2 slice store tests (jsdom ships none). Harmless for
// tests that never touch it.
import 'fake-indexeddb/auto'

// jsdom in this environment doesn't expose Web Storage, so `localStorage` is
// undefined and any test that touches it throws. Provide a minimal in-memory
// Storage. Guarded: if a real implementation is ever present, we leave it alone.
if (typeof globalThis.localStorage === 'undefined') {
  class MemoryStorage {
    private m = new Map<string, string>()
    get length() {
      return this.m.size
    }
    clear() {
      this.m.clear()
    }
    getItem(k: string) {
      return this.m.has(k) ? this.m.get(k)! : null
    }
    setItem(k: string, v: string) {
      this.m.set(k, String(v))
    }
    removeItem(k: string) {
      this.m.delete(k)
    }
    key(i: number) {
      return [...this.m.keys()][i] ?? null
    }
  }
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true })
}

// jsdom ships no IntersectionObserver (Stocks' HRail, plan Task 15, uses one
// for lazy rail loading). A silent no-op default so any test that mounts a
// rail without caring about visibility doesn't crash; tests that DO care
// (Stocks.test.tsx) stub a controllable fake over this per-test.
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class NoopIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', { value: NoopIntersectionObserver, configurable: true, writable: true })
}
