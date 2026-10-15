// Published 0.1.0 apps copy a browser public/ directory. New apps are headless and do not.
// Accept either exact Dockerfile; do not rewrite one into the other.
export const legacyProtectedDockerfile = `FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json fastagent.yaml ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
`;

export function isApprovedDockerfile(content: string, bundled: string): boolean {
  const normalized = content.replaceAll('\r\n', '\n').trim();
  return [bundled, legacyProtectedDockerfile].some((candidate) => candidate.replaceAll('\r\n', '\n').trim() === normalized);
}
