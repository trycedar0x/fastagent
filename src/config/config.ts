import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { FastagentError } from '../errors.js';
import { DEFAULT_MODEL_REFERENCE, TOKEN_MODEL_REFERENCE } from '../models/reference.js';

export const projectNameSchema = z.string().min(1).max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

const legacyModel = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const tokenModel = z.string().regex(TOKEN_MODEL_REFERENCE);
const protectedConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: projectNameSchema,
  framework: z.literal('openai'),
  model: legacyModel,
  deployment: z.strictObject({ access: z.literal('protected') }),
});
const tokenConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: projectNameSchema,
  framework: z.literal('openai'),
  model: tokenModel,
  deployment: z.strictObject({ access: z.literal('token') }),
});
export const projectConfigSchema = z.union([tokenConfigSchema, protectedConfigSchema]);

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export function validateConfig(value: unknown): ProjectConfig {
  const result = projectConfigSchema.safeParse(value);
  if (!result.success) {
    // Do not echo rejected config values, which could contain credentials.
    // Do not rewrite protected apps into token apps, or the reverse.
    throw new FastagentError('CONFIG_INVALID',
      'Invalid fastagent.yaml: expected schemaVersion 1, a lowercase application name, framework openai, and deployment.access token or protected. Token apps require openrouter/<vendor>/<model> or openai/<model>. Existing protected apps are left unchanged; unknown fields are not allowed.');
  }
  return result.data;
}

export function isDeployableModel(config: ProjectConfig): boolean {
  if (config.deployment.access === 'protected') return /^openai\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.model);
  return TOKEN_MODEL_REFERENCE.test(config.model);
}

export function parseConfig(source: string): ProjectConfig {
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) throw new Error('Invalid YAML');
    return validateConfig(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof FastagentError) throw error;
    throw new FastagentError('CONFIG_INVALID', 'Invalid fastagent.yaml: malformed YAML or unsupported aliases.');
  }
}

export function serializeConfig(config: ProjectConfig): string {
  return stringify(validateConfig(config));
}

export function createConfig(name: string, framework = 'openai'): ProjectConfig {
  if (framework !== 'openai') {
    throw new FastagentError('UNSUPPORTED_FRAMEWORK', 'Only framework openai is supported. The Vercel AI SDK is not supported.', 2);
  }
  if (!projectNameSchema.safeParse(name).success) {
    throw new FastagentError('INVALID_NAME',
      'Name must be 1–63 lowercase letters, digits or hyphens, starting and ending with a letter or digit. Use --name to set it explicitly.', 2);
  }
  return validateConfig({
    schemaVersion: 1,
    name,
    framework,
    model: DEFAULT_MODEL_REFERENCE,
    deployment: { access: 'token' },
  });
}
