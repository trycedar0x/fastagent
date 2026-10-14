import { z } from 'zod';

const temperatureInput = z.object({ value: z.number().min(-1000).max(1000), from: z.enum(['C', 'F']) }).strict();

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown): Promise<unknown>;
}

// Pure, bounded developer-owned logic: no network, shell, or invented facts.
export const tools = {
  convertTemperature: {
    name: 'convertTemperature',
    description: 'Convert a temperature between Celsius and Fahrenheit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'number', minimum: -1000, maximum: 1000 },
        from: { type: 'string', enum: ['C', 'F'] },
      },
      required: ['value', 'from'],
    },
    async execute(input: unknown) {
      const parsed = temperatureInput.parse(input);
      return { value: parsed.from === 'C' ? parsed.value * 9 / 5 + 32 : (parsed.value - 32) * 5 / 9, unit: parsed.from === 'C' ? 'F' : 'C' };
    },
  } satisfies AgentTool,
};
