/**
 * Upload ceiling for server-log analysis.
 *
 * A plain module rather than the `"use server"` file beside it. Next.js allows
 * only async functions to be exported from those, and while a bare number has
 * been slipping through the build where an array does not, that is luck rather
 * than a guarantee — the rule says functions.
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
