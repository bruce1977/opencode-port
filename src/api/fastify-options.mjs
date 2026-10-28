// Fastify enables AJV coerceTypes: 'array' by default, which rewrites the request body in place across anyOf branches:
// the standard OpenAI/Anthropic content block array ([{type:"text",...}]) therefore fails validation as a string.
// Disable coercion so the body reaches zod validation unchanged.
export const AJV_OPTIONS = { customOptions: { coerceTypes: false } };
