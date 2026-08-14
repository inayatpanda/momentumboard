// /api/* middleware: the Tauri CORS policy, scoped so static assets never
// invoke a Function. The policy itself lives in ../cors.ts; /report applies
// the same wrap inside its own handler.
export { onRequest } from '../cors'
