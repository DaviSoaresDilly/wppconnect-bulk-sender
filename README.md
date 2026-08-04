# Plataforma Web de Envio Esporádico via WhatsApp (WPPConnect + Node.js + Socket.io)

Aplicação web para importação de contatos e envio esporádico de mensagens (texto, foto e vídeo)
com intervalo de segurança anti-banimento.

## 🚀 Tecnologias

- **Backend:** Node.js, Express, Socket.io
- **WhatsApp Engine:** `@wppconnect-team/wppconnect` com Puppeteer headless
- **Frontend:** HTML5, CSS3, Vanilla JS com Socket.io Client

---

## ⚠️ Requisito de memória (leia antes de fazer deploy)

Esta aplicação sobe um **Chromium completo** que carrega o WhatsApp Web. No pico do login e da
sincronização inicial, esse conjunto consome **700MB–1GB de RAM**.

| Ambiente | Resultado |
|---|---|
| Render Free / Starter (512MB) | ❌ OOM killer derruba o container ao conectar |
| Render Standard (2GB) | ✅ Funciona |
| 512MB + `BROWSER_WS` apontando para um Chromium externo | ✅ Funciona (só o Node roda aqui) |

O endpoint `GET /healthz` devolve o uso real de memória do container (lido do cgroup, não do
`process.memoryUsage()`, que enxerga apenas o Node e ignora os processos do Chromium).

---

## ⚡ Executando localmente

```bash
npm install
npm start
```

Acesse [http://localhost:3000](http://localhost:3000).

---

## 🌐 Deploy

### Render — recomendado (Docker, 2GB)

O `render.yaml` na raiz já descreve o serviço. Basta criar um **Blueprint** apontando para o
repositório. Ele configura runtime Docker, plano `standard`, health check e um disco persistente
em `/usr/src/app/tokens` — sem esse disco o QR Code é exigido de novo a cada deploy.

Se preferir configurar pelo dashboard: runtime **Docker**, plano **Standard**, health check
`/healthz`.

### Render em 512MB — Chromium externo

Hospede um Chromium em outro lugar (browserless, um container próprio, uma VM) e aponte para ele:

```
BROWSER_WS=ws://seu-chromium:3000
```

Com essa variável definida o servidor não abre navegador nenhum: ele apenas se conecta ao
endpoint remoto. O Node sozinho roda folgado em 512MB.

---

## 🔧 Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP (o Render define automaticamente) |
| `BROWSER_WS` | — | WebSocket de um Chromium externo. Definido, o app não abre navegador local |
| `PUPPETEER_EXECUTABLE_PATH` | — | Caminho do binário do Chromium (a imagem Docker já define) |
| `CHROMIUM_HEADLESS` | `shell` | `shell`, `true` ou `false` |
| `CHROMIUM_JS_HEAP_MB` | `160` | Teto do heap V8 do renderer |
| `MAX_MEDIA_MB` | `16` | Tamanho máximo por arquivo |
| `MAX_TOTAL_MEDIA_MB` | `32` | Soma máxima das mídias de um disparo |
| `MAX_MEDIA_FILES` | `5` | Quantidade máxima de anexos |
| `DISPATCH_INTERVAL_MS` | `12000` | Intervalo anti-banimento entre mensagens |
| `MEMORY_LIMIT_MB` | `512` | Limite assumido quando o cgroup não é legível |
| `MEMORY_WARN_PCT` | `80` | % de RAM que dispara aviso |
| `MEMORY_CRITICAL_PCT` | `90` | % de RAM que pausa o disparo |

---

## 📎 Limites de mídia

O WhatsApp recusa imagem/vídeo acima de ~16MB, e cada arquivo enviado é replicado várias vezes em
memória (base64 no Node → payload CDP → base64 no renderer → Blob → conteúdo criptografado). Por
isso o teto padrão é 16MB por arquivo e 32MB somados. Ajuste via variáveis de ambiente se a sua
instância tiver folga.

As mídias são convertidas para base64 **uma única vez por disparo** e reaproveitadas em todos os
contatos, em vez de reler o arquivo do disco a cada envio.

---

## 🛡️ Segurança e Anti-Banimento

- **Contatos:** importação manual, TXT, CSV e VCF, ou leitura da agenda do WhatsApp
  (`listChats` / `getAllContacts`) pelo botão de recarregar.
- **Filtro de Grupos:** grupos (`isGroup: true` ou `@g.us`) são removidos da lista de disparos.
- **Intervalo fixo:** pausa obrigatória entre cada mensagem (12s por padrão).
- **Backpressure de memória:** se o container passa de `MEMORY_CRITICAL_PCT`, o disparo pausa e
  aguarda a memória baixar em vez de seguir até ser morto pelo OOM killer.
- **Uploads confinados:** caminhos de mídia recebidos pelo socket são validados contra o diretório
  `uploads/` antes de qualquer leitura ou remoção.

---

## 🗂️ Sessão do WhatsApp

O perfil do Chromium e o token da sessão ficam em `tokens/`. Esse diretório **não deve ser
commitado** — ele contém as credenciais da sua sessão do WhatsApp e dezenas de MB de cache. Já
está no `.gitignore`.

Para forçar um novo QR Code, use o botão de reset na interface (apaga `tokens/` e reinicia o
navegador).
