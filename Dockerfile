FROM node:20-slim
WORKDIR /app

# Install git (required by @whiskeysockets/baileys during npm install)
RUN apt-get update -y && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
EXPOSE 8080
CMD ["node", "index.js"]
