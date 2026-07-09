import '@testing-library/jest-dom'

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
