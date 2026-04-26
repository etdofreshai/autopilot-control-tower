FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY .autopilot ./.autopilot
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "start"]
