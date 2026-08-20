/**
 * Limits for a profile photo.
 *
 * In their own module because `profile.ts` is a `"use server"` file, and such a
 * file may only export async functions — exporting a number from it fails the
 * build with "A 'use server' file can only export async functions, found
 * number". The upload route needs the ceiling before it reads the body, so the
 * constants have to live somewhere a route can import.
 */

/** Same ceiling as a lead's captured photo. A face does not need more. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export const AVATAR_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
