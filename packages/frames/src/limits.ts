// What a frame answer may carry. No I/O here, so servers that only check
// answers (the API route, Convex) can import it.
export const FILE_NAME=/^[a-z0-9-]{1,24}$/;
export const MAX_FILES=64;
export const MAX_ANSWER_BYTES=48*1024*1024;
export const MAX_REPORT=8000;
