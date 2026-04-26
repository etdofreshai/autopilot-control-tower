FROM node:24-alpine
RUN apk add --no-cache git python3 bash \
  && npm install -g openclaw@2026.4.24
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY .autopilot ./.autopilot
ENV NODE_ENV=production
ENV PORT=8787
ENV OPENCLAW_HOME=/openclaw
EXPOSE 8787
CMD ["npm", "start"]
