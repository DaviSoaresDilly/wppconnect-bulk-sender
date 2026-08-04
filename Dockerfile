FROM node:18-slim

# Chromium do sistema + dumb-init.
# dumb-init é necessário porque o Chromium abre vários processos filhos; com o
# node como PID 1 eles viram zumbis e nunca são coletados, vazando memória do
# container a cada reconexão.
RUN apt-get update && apt-get install -y \
    chromium \
    dumb-init \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# O Chromium já vem da imagem: impede o puppeteer de baixar outros ~350MB.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# tokens/ guarda o perfil do Chromium e o token da sessão. Precisa existir e,
# em produção, ser um volume — senão o QR Code é pedido de novo a cada deploy.
RUN mkdir -p tokens uploads

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--expose-gc", "--max-old-space-size=192", "server.js"]
