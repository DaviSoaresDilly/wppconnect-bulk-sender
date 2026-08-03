# Plataforma Web de Envio Esporádico via WhatsApp (WPPConnect + Node.js + Socket.io)

Aplicação web minimalista e performática para extração automática de contatos salvos da agenda do chip do WhatsApp e envio esporádico de mensagens com intervalo de segurança anti-banimento.

## 🚀 Tecnologias Utilizadas

- **Backend:** Node.js, Express, Socket.io
- **WhatsApp Engine:** `@wppconnect-team/wppconnect` (com Puppeteer em modo headless otimizado para contêineres)
- **Frontend:** HTML5, CSS3 (Material Design / Clean Tech), Vanilla JS com Socket.io Client

---

## ⚡ Como Executar Localmente

### 1. Instalação das Dependências
No terminal, dentro da pasta do projeto, execute:
```bash
npm install
```

### 2. Iniciar o Servidor
```bash
npm start
```
Ou para desenvolvimento:
```bash
npm run dev
```

### 3. Acessar no Navegador
Abra [http://localhost:3000](http://localhost:3000) no seu navegador.

---

## 🌐 Implantação em Nuvem (Render, Heroku, Railway)

### 📌 Render (Web Service)
1. Crie um novo **Web Service** conectado ao repositório do projeto.
2. Defina o **Build Command**: `npm install`
3. Defina o **Start Command**: `npm start`
4. Na seção **Environment Variables**, certifique-se de que `PORT` é configurada automaticamente pela plataforma.
5. Se utilizar Docker ou Environment nativo Linux, certifique-se de que as dependências do Chrome/Chromium (Puppeteer) estejam disponíveis.

### 📌 Heroku / Railway
- O servidor lê automaticamente a variável `process.env.PORT`.
- Os argumentos de Puppeteer já incluem `--no-sandbox`, `--disable-setuid-sandbox` e `--disable-dev-shm-usage` para evitar estouro de memória compartilhada em contêineres de nuvem.

---

## 🛡️ Segurança e Anti-Banimento

- **Sem Planilhas:** O sistema lê os contatos diretamente da agenda do WhatsApp (`getAllContacts` / `getAllChats`).
- **Filtro de Grupos:** Todos os grupos (`isGroup: true` ou `@g.us`) são estritamente removidos da lista de disparos.
- **Intervalo Fixo de 12 Segundos:** O sistema possui uma função `sleep` baseada em Promises que impõe uma pausa obrigatória e exata de 12 segundos entre cada mensagem enviada, evitando detecção de spam pelos servidores do WhatsApp.
