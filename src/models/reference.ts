export const DEFAULT_MODEL_REFERENCE = 'openrouter/deepseek/deepseek-v4.1-flash';

// Official OpenRouter alias IDs may prefix the vendor with one tilde, for example
// ~deepseek/deepseek-flash-latest. That is not a substitute for the pinned default.
export const OPENROUTER_MODEL_ID = /^~?[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,150}$/;
export const OPENAI_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,150}$/;
export const TOKEN_MODEL_REFERENCE = /^(?:openai\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,150}|openrouter\/~?[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,150})$/;

export function modelApiKeyName(reference: string): 'OPENAI_API_KEY' | 'OPENROUTER_API_KEY' {
  if (reference.startsWith('openai/') && OPENAI_MODEL_ID.test(reference.slice('openai/'.length))) return 'OPENAI_API_KEY';
  if (reference.startsWith('openrouter/') && OPENROUTER_MODEL_ID.test(reference.slice('openrouter/'.length))) return 'OPENROUTER_API_KEY';
  throw new Error('Unsupported model reference.');
}
