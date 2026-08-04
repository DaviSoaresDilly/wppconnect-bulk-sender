FROM node:18-slim

# Instala dependências do Chromium para o Puppeteer no ambiente Linux
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt-get/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "--expose-gc", "--max-old-space-size=384", "server.js"]
