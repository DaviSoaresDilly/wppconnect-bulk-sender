const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const wppconnect = require('@wppconnect-team/wppconnect');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// O wppconnect só aplica o plugin stealth quando ele mesmo abre o Chromium.
// Como este servidor passa a ser o dono do browser (ver launchBrowser), o plugin
// precisa ser registrado aqui.
puppeteer.use(StealthPlugin());

// ---------------------------------------------------------------------------
// 1. Configuração
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const SESSION_NAME = 'disparo-esporadico-session';
const TOKEN_FOLDER = 'tokens';

// O wppconnect resolve os caminhos de sessão a partir de process.cwd().
// Usamos a mesma base para que o reset de sessão e o perfil do Chromium nunca
// apontem para diretórios diferentes.
const SESSION_DIR = path.resolve(process.cwd(), TOKEN_FOLDER, SESSION_NAME);
const SESSION_TOKEN_FILE = path.resolve(process.cwd(), TOKEN_FOLDER, `${SESSION_NAME}.data.json`);

const numEnv = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Limites de mídia. O WhatsApp já recusa imagem/vídeo acima de ~16MB, e cada
// arquivo enviado custa várias cópias em memória (base64 no Node + base64 no
// renderer + Blob + payload criptografado), então o teto precisa ser baixo.
const MAX_MEDIA_MB = numEnv('MAX_MEDIA_MB', 16);
const MAX_TOTAL_MEDIA_MB = numEnv('MAX_TOTAL_MEDIA_MB', 32);
const MAX_MEDIA_FILES = numEnv('MAX_MEDIA_FILES', 5);
const MAX_MEDIA_BYTES = MAX_MEDIA_MB * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = MAX_TOTAL_MEDIA_MB * 1024 * 1024;

const DISPATCH_INTERVAL_MS = numEnv('DISPATCH_INTERVAL_MS', 12000);
const MEDIA_INTERVAL_MS = numEnv('MEDIA_INTERVAL_MS', 2000);

// Teto de heap do renderer do Chromium. Dentro de um container o V8 dimensiona
// o heap pela RAM do host, não pelo limite do cgroup, então precisa ser fixado.
// Medido: o limite efetivo do renderer fica ~100MB acima deste valor (new
// space, code space etc.), ou seja 160 aqui => ~257MB de teto real.
const CHROMIUM_JS_HEAP_MB = numEnv('CHROMIUM_JS_HEAP_MB', 160);

// Limite de memória assumido quando o cgroup não é legível.
const FALLBACK_MEMORY_LIMIT_MB = numEnv('MEMORY_LIMIT_MB', 512);
const MEMORY_WARN_PCT = numEnv('MEMORY_WARN_PCT', 80);
const MEMORY_CRITICAL_PCT = numEnv('MEMORY_CRITICAL_PCT', 90);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 2. Medição real de memória (cgroup, não process.memoryUsage)
// ---------------------------------------------------------------------------
//
// process.memoryUsage() enxerga apenas o processo Node. O Chromium roda em
// processos separados (browser, renderer, network service, zygote, GPU) e é lá
// que quase toda a memória é consumida. Quem mata o container é o OOM killer do
// cgroup, que soma todos eles — então é o cgroup que precisa ser lido.

const readIntFile = (file) => {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw === 'max' || raw === '') return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
};

const readStatField = (file, field) => {
  try {
    const line = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${field} `));
    if (!line) return null;
    const parsed = Number.parseInt(line.split(/\s+/)[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
};

function readCgroupMemory() {
  // cgroup v2
  const v2Used = readIntFile('/sys/fs/cgroup/memory.current');
  if (v2Used !== null) {
    // memory.current inclui page cache, que o kernel recupera antes de matar o
    // processo. Descontar inactive_file evita alarme falso.
    const inactiveFile = readStatField('/sys/fs/cgroup/memory.stat', 'inactive_file') || 0;
    return { used: Math.max(0, v2Used - inactiveFile), limit: readIntFile('/sys/fs/cgroup/memory.max') };
  }

  // cgroup v1
  const v1Used = readIntFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1Used !== null) {
    const inactiveFile = readStatField('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file') || 0;
    let limit = readIntFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    // Sem limite o kernel devolve um número enorme; trata como "desconhecido".
    if (limit !== null && limit > 1024 ** 4) limit = null;
    return { used: Math.max(0, v1Used - inactiveFile), limit };
  }

  return null;
}

function memorySnapshot() {
  const cgroup = readCgroupMemory();
  const toMB = (bytes) => Math.round(bytes / 1024 / 1024);

  const cgroupLimitMB = cgroup && cgroup.limit ? toMB(cgroup.limit) : null;
  const usedMB = cgroup ? toMB(cgroup.used) : toMB(process.memoryUsage().rss);
  const limitMB = cgroupLimitMB || FALLBACK_MEMORY_LIMIT_MB;

  return {
    usedMB,
    limitMB,
    pct: Math.round((usedMB / limitMB) * 100),
    nodeRssMB: toMB(process.memoryUsage().rss),
    // 'cgroup' cobre todos os processos (Node + Chromium). 'node' cobre apenas
    // este processo e subestima muito o uso real.
    usageSource: cgroup ? 'cgroup' : 'node',
    // Sem limite no cgroup usamos MEMORY_LIMIT_MB, que é só um palpite.
    limitSource: cgroupLimitMB ? 'cgroup' : 'fallback',
  };
}

const forceGc = () => {
  if (global.gc) {
    try {
      global.gc();
    } catch (e) {
      /* noop */
    }
  }
};

setInterval(() => {
  const mem = memorySnapshot();
  if (mem.pct >= MEMORY_WARN_PCT) {
    console.warn(
      `[RAM] ${mem.usedMB}MB / ${mem.limitMB}MB (${mem.pct}%) | Node RSS ${mem.nodeRssMB}MB` +
        `${mem.usageSource === 'cgroup' ? '' : ' [estimado: cgroup indisponível]'}`
    );
    forceGc();
    io.emit('memory_warning', mem);
  }
}, 30000);

// ---------------------------------------------------------------------------
// 3. Ciclo de vida do browser
// ---------------------------------------------------------------------------
//
// O servidor abre o Chromium e guarda a referência. Isso garante que qualquer
// falha na inicialização consiga fechar o browser, em vez de deixar processos
// órfãos consumindo RAM até o container morrer.

let browserRef = null; // Browser do Puppeteer que nós abrimos
let wppClient = null; // Cliente do wppconnect já autenticado
let initPromise = null; // Inicialização em andamento (guarda de chamada única)
let closing = false; // Fechamento em andamento (evita reentrada)
let shuttingDown = false; // Processo terminando

let validContacts = [];
let isDispatching = false;
let stopDispatchRequested = false;

function buildChromiumArgs() {
  return [
    // Obrigatórios em container
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',

    // Contenção de memória. Sem isso o Chromium abre um renderer por site e
    // dimensiona o heap do V8 pela RAM do host, ignorando o limite do cgroup.
    '--renderer-process-limit=1',
    `--js-flags=--max-old-space-size=${CHROMIUM_JS_HEAP_MB}`,
    '--disable-site-isolation-trials',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,IsolateOrigins,site-per-process,CalculateNativeWinOcclusion',

    // Defaults do wppconnect que precisam ser preservados. O wppconnect faz
    // `{...base, ...puppeteerOptions}`, então passar `args` por puppeteerOptions
    // apagava silenciosamente esta lista inteira.
    '--log-level=3',
    '--disable-blink-features=AutomationControlled',
    '--disable-webgl',
    '--disable-3d-apis',
    '--disable-accelerated-2d-canvas',
    '--disable-accelerated-video-decode',
    '--disable-accelerated-jpeg-decoding',
    '--disable-canvas-aa',
    '--disable-composited-antialiasing',
    '--disable-gl-extensions',
    '--disable-threaded-animation',
    '--disable-threaded-scrolling',
    '--disable-in-process-stack-traces',
    '--disable-histogram-customizer',
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
    '--autoplay-policy=no-user-gesture-required',

    // Desliga subsistemas que só gastam RAM em headless
    '--disable-gpu',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--disable-prompt-on-repost',
    '--disable-speech-api',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-experiments',
    '--no-pings',
    '--metrics-recording-only',
    '--password-store=basic',
  ];
}

// Quando BROWSER_WS aponta para um Chromium remoto (browserless, um container
// dedicado, uma VM), este processo não abre navegador nenhum. É a única forma
// de rodar de verdade em 512MB: o Render fica só com o Node.
const BROWSER_WS = process.env.BROWSER_WS || '';
let browserIsRemote = false;

async function launchBrowser() {
  if (BROWSER_WS) {
    console.log(`[Chromium] Conectando ao navegador remoto: ${BROWSER_WS}`);
    browserIsRemote = true;
    return puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
      protocolTimeout: 300000,
    });
  }

  browserIsRemote = false;
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  // 'shell' usa o chrome-headless-shell (bem mais leve) quando o binário está
  // disponível. Com um Chromium de sistema o flag cai no headless novo, sem
  // prejuízo.
  const headlessEnv = (process.env.CHROMIUM_HEADLESS || 'shell').toLowerCase();
  const headless = headlessEnv === 'false' ? false : headlessEnv === 'shell' ? 'shell' : true;

  return puppeteer.launch({
    headless,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    userDataDir: SESSION_DIR,
    timeout: 120000,
    // Envio de mídia grande por CDP pode passar do default de 180s numa
    // instância pequena.
    protocolTimeout: 300000,
    args: buildChromiumArgs(),
  });
}

/**
 * Encerra cliente e browser. Idempotente e seguro para chamadas concorrentes.
 */
async function closeBrowser() {
  if (closing) return;
  closing = true;

  const client = wppClient;
  const browser = browserRef;
  wppClient = null;
  browserRef = null;

  try {
    if (client) {
      await client.close().catch(() => {});
    }
    if (browser) {
      if (browserIsRemote) {
        // Navegador remoto pode ser compartilhado: desconecta sem matá-lo.
        await browser.disconnect().catch(() => {});
      } else {
        await browser.close().catch(() => {});
        // Se o close educado não resolver, mata o processo. Um Chromium
        // pendurado custa centenas de MB e impede a próxima conexão.
        try {
          const proc = typeof browser.process === 'function' ? browser.process() : null;
          if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
        } catch (e) {
          /* noop */
        }
      }
    }
  } finally {
    closing = false;
    forceGc();
  }
}

function handleSessionLost(reason) {
  if (shuttingDown || closing) return;
  console.warn(`[WPPConnect] Sessão perdida (${reason}). Liberando o browser.`);
  io.emit('status', {
    code: 'DISCONNECTED',
    message: 'Sessão desconectada. Clique em "Conectar Celular" para gerar um novo QR Code.',
  });
  closeBrowser().catch(() => {});
}

/**
 * Inicialização da sessão do WhatsApp.
 *
 * Guarda de chamada única: enquanto uma inicialização estiver em andamento,
 * toda chamada nova recebe a mesma promise. Antes, um booleano `isInitializing`
 * era zerado pelo callback statusFind enquanto o create() ainda estava
 * pendente, e o próximo clique em "Conectar" subia um segundo Chromium —
 * dois browsers completos em 512MB é OOM imediato.
 */
function initWppSession(forceFresh = false) {
  if (wppClient && !forceFresh) {
    io.emit('status', { code: 'CONNECTED', message: 'Sessão já está ativa e conectada.' });
    if (validContacts.length > 0) {
      io.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
    }
    return Promise.resolve(wppClient);
  }

  if (initPromise) {
    io.emit('status', { code: 'INITIALIZING', message: 'A inicialização já está em andamento...' });
    return initPromise;
  }

  initPromise = doInitSession(forceFresh).finally(() => {
    initPromise = null;
  });

  return initPromise;
}

async function doInitSession(forceFresh) {
  if (forceFresh) {
    await closeBrowser();
    for (const target of [SESSION_DIR, SESSION_TOKEN_FILE]) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[WPPConnect] Aviso ao limpar ${target}:`, e.message);
      }
    }
    console.log('[WPPConnect] Sessão anterior removida.');
    io.emit('status', { code: 'STARTING', message: 'Sessão resetada! Gerando novo QR Code...' });
  }

  const mem = memorySnapshot();
  console.log(`[WPPConnect] Iniciando Chromium. RAM antes: ${mem.usedMB}MB / ${mem.limitMB}MB.`);
  io.emit('status', { code: 'STARTING', message: 'Iniciando o navegador...' });

  try {
    browserRef = await launchBrowser();

    browserRef.on('disconnected', () => {
      if (shuttingDown || closing) return;
      handleSessionLost('browser desconectado');
    });

    const client = await wppconnect.create({
      session: SESSION_NAME,
      // Passamos o browser já aberto para manter a referência e poder fechá-lo
      // em qualquer caminho de erro.
      browser: browserRef,
      catchQR: (base64Qr, asciiQR, attempts) => {
        console.log(`[WPPConnect] QR Code gerado (tentativa ${attempts})`);
        const formattedQr =
          base64Qr && !base64Qr.startsWith('data:') && !base64Qr.startsWith('http')
            ? `data:image/png;base64,${base64Qr}`
            : base64Qr;

        io.emit('qr', { qrCode: formattedQr, attempts });
        io.emit('status', {
          code: 'QR_READY',
          message: 'QR Code pronto! Abra o WhatsApp no celular e escaneie.',
        });
      },
      statusFind: (statusSession) => {
        console.log(`[WPPConnect] Status da sessão: ${statusSession}`);

        if (['isLogged', 'inChat', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession)) {
          io.emit('status', { code: 'CONNECTED', message: 'WhatsApp conectado com sucesso!' });
        } else if (statusSession === 'notLogged') {
          io.emit('status', {
            code: 'QR_READY',
            message: 'Aguardando leitura do QR Code pelo seu celular...',
          });
        } else if (
          ['desconnectedMobile', 'browserClose', 'browserClosed', 'autocloseCalled', 'serverClose', 'deviceNotConnected'].includes(
            statusSession
          )
        ) {
          // Antes este ramo zerava o estado de inicialização, abrindo a porta
          // para um segundo Chromium. Agora apenas libera os recursos.
          handleSessionLost(statusSession);
        } else {
          io.emit('status', { code: 'SESSION_STATUS', message: `Status: ${statusSession}` });
        }
      },
      updatesLog: false,
      autoClose: false,
      tokenStore: 'file',
      folderNameToken: TOKEN_FOLDER,
    });

    wppClient = client;

    // Nota: não registramos page.setRequestInterception() aqui.
    // 1) O wppconnect já registra o seu próprio handler quando a opção
    //    whatsappVersion (default '2.3000.10305x') existe no pacote wa-version
    //    instalado; um segundo handler gera "Request is already handled!".
    // 2) Interceptar faz o Puppeteer enviar Network.setCacheDisabled, o que
    //    desliga o cache do browser e obriga o WhatsApp Web a rebaixar dezenas
    //    de MB de bundle a cada reload.
    // 3) Rodando depois do create(), o pico de memória do login já passou.

    const after = memorySnapshot();
    console.log(`[WPPConnect] Cliente autenticado. RAM depois: ${after.usedMB}MB / ${after.limitMB}MB (${after.pct}%).`);

    io.emit('status', {
      code: 'CONNECTED',
      message:
        'WhatsApp conectado com sucesso! Cole os números ou carregue um arquivo (TXT/CSV/VCF) na Etapa 2.',
    });

    return client;
  } catch (error) {
    console.error('[WPPConnect] Erro ao iniciar a sessão:', error);
    // Sem isto o Chromium aberto acima ficaria rodando para sempre.
    await closeBrowser();
    io.emit('status', { code: 'ERROR', message: `Falha na inicialização: ${error.message}` });
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Upload de mídia
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `media-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MEDIA_BYTES, files: MAX_MEDIA_FILES },
});

/**
 * Garante que um caminho vindo do cliente aponte para dentro de uploads/.
 * O cliente envia `mediaFiles` de volta pelo socket, então sem esta checagem um
 * payload forjado poderia ler ou apagar arquivos arbitrários do servidor.
 */
function resolveUploadPath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return null;
  const resolved = path.resolve(candidate);
  const base = path.resolve(uploadsDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    connected: Boolean(wppClient),
    initializing: Boolean(initPromise),
    contacts: validContacts.length,
    dispatching: isDispatching,
    memory: memorySnapshot(),
  });
});

app.post('/api/upload', (req, res) => {
  upload.array('mediaFiles', MAX_MEDIA_FILES)(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Arquivo acima do limite de ${MAX_MEDIA_MB}MB.`
          : err.code === 'LIMIT_FILE_COUNT'
            ? `Máximo de ${MAX_MEDIA_FILES} arquivos por disparo.`
            : err.message;
      console.error('[Upload] Erro:', message);
      return res.status(400).json({ success: false, error: message });
    }

    const files = (req.files || []).map((file) => ({
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      path: file.path,
      size: file.size,
    }));

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
      files.forEach((f) => {
        try {
          fs.unlinkSync(f.path);
        } catch (e) {
          /* noop */
        }
      });
      return res.status(400).json({
        success: false,
        error: `Soma das mídias (${(totalBytes / 1024 / 1024).toFixed(1)}MB) acima do limite de ${MAX_TOTAL_MEDIA_MB}MB.`,
      });
    }

    console.log(`[Upload] ${files.length} arquivo(s) recebidos (${(totalBytes / 1024 / 1024).toFixed(1)}MB).`);
    res.json({ success: true, files });
  });
});

app.delete('/api/upload/:filename', (req, res) => {
  const filePath = resolveUploadPath(path.join(uploadsDir, req.params.filename));
  if (!filePath) {
    return res.status(400).json({ success: false, error: 'Caminho inválido.' });
  }
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Upload] Arquivo removido: ${req.params.filename}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 5. Contatos
// ---------------------------------------------------------------------------

async function extractAndFilterContacts() {
  if (!wppClient) return;

  try {
    io.emit('status', { code: 'LOADING_CONTACTS', message: 'Buscando contatos e chats ativos...' });

    const contactMap = new Map();

    const addEntry = (raw) => {
      const id = raw && raw.id && raw.id._serialized;
      if (!id) return;
      const isGroup = raw.isGroup || id.includes('@g.us');
      if (isGroup || !id.includes('@c.us')) return;
      if (contactMap.has(id)) return;
      contactMap.set(id, {
        id,
        name:
          raw.name ||
          raw.formattedTitle ||
          raw.pushname ||
          raw.formattedName ||
          (raw.contact && (raw.contact.name || raw.contact.pushname)) ||
          id.split('@')[0],
        isUser: true,
      });
    };

    // Sequencial e com liberação explícita: rodar as duas buscas em Promise.all
    // mantinha as duas listas completas vivas ao mesmo tempo, dobrando o pico.
    let chats = await wppClient.listChats({ onlyUsers: true }).catch(() => null);
    if (!chats) chats = await wppClient.getAllChats().catch(() => []);
    chats.forEach(addEntry);
    chats = null;
    forceGc();

    let contacts = await wppClient.getAllContacts().catch(() => []);
    contacts.forEach(addEntry);
    contacts = null;
    forceGc();

    validContacts = Array.from(contactMap.values());
    contactMap.clear();

    console.log(`[WPPConnect] Contatos válidos (sem grupos): ${validContacts.length}`);

    io.emit('status', {
      code: 'READY',
      message: `Conectado com sucesso! Total de ${validContacts.length} contatos carregados.`,
    });
    io.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
  } catch (error) {
    console.error('[WPPConnect] Erro ao extrair contatos:', error);
    io.emit('status', { code: 'ERROR', message: `Erro ao extrair contatos: ${error.message}` });
  }
}

function parseRawContacts(text) {
  if (!text || typeof text !== 'string') return [];
  const map = new Map();

  const register = (rawNumber, name) => {
    let finalNum = String(rawNumber || '').replace(/\D/g, '');
    if (finalNum.length === 10 || finalNum.length === 11) finalNum = `55${finalNum}`;
    if (finalNum.length < 10) return;
    const id = `${finalNum}@c.us`;
    map.set(id, { id, name: name || finalNum, isUser: true });
  };

  // Suporte a VCF (vCard)
  if (text.includes('BEGIN:VCARD')) {
    text.split(/END:VCARD/i).forEach((card) => {
      let name = '';
      const numbers = [];

      card.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        const upper = trimmed.toUpperCase();
        if (upper.startsWith('FN:') || upper.startsWith('FN;')) {
          name = trimmed.substring(trimmed.indexOf(':') + 1).trim();
        } else if (!name && (upper.startsWith('N:') || upper.startsWith('N;'))) {
          const rawN = trimmed.substring(trimmed.indexOf(':') + 1).trim();
          name = rawN.split(';').filter(Boolean).reverse().join(' ').trim();
        } else if (upper.startsWith('TEL') || upper.includes('TEL;')) {
          const digits = trimmed.substring(trimmed.indexOf(':') + 1).replace(/\D/g, '');
          if (digits) numbers.push(digits);
        }
      });

      numbers.forEach((n) => register(n, name));
    });

    return Array.from(map.values());
  }

  // TXT / CSV
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parts = trimmed.split(/[,;\t]/).map((p) => p.trim());
    if (parts.length >= 2) {
      const digits0 = parts[0].replace(/\D/g, '');
      const digits1 = parts[1].replace(/\D/g, '');

      if (digits0.length >= 10) register(digits0, parts[1] || digits0);
      else if (digits1.length >= 10) register(digits1, parts[0] || digits1);
      else register(parts[0], parts[1]);
    } else {
      const digits = trimmed.replace(/\D/g, '');
      const nameCandidate = trimmed.replace(/[\d+\-()\s,;]/g, '').trim();
      register(digits, nameCandidate || digits);
    }
  });

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// 6. Disparo
// ---------------------------------------------------------------------------

/**
 * Converte as mídias para data URI UMA única vez por disparo.
 *
 * Antes, sendFile() recebia um caminho e o wppconnect fazia
 * fs.readFileSync(path, {encoding:'base64'}) para CADA contato — ou seja, N
 * leituras completas do arquivo e N strings base64 gigantes no heap. Agora o
 * custo é pago uma vez só e a mesma string é reaproveitada.
 */
function prepareMediaPayloads(mediaFiles) {
  const payloads = [];
  let totalBytes = 0;

  for (const media of mediaFiles) {
    const absPath = resolveUploadPath(media && media.path);
    if (!absPath) {
      throw new Error(`Caminho de mídia inválido: ${media && media.path}`);
    }
    if (!fs.existsSync(absPath)) {
      throw new Error(`Arquivo de mídia não encontrado: ${media.originalname || media.path}`);
    }

    const { size } = fs.statSync(absPath);
    if (size > MAX_MEDIA_BYTES) {
      throw new Error(
        `"${media.originalname}" tem ${(size / 1024 / 1024).toFixed(1)}MB, acima do limite de ${MAX_MEDIA_MB}MB.`
      );
    }

    totalBytes += size;
    if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
      throw new Error(`Soma das mídias acima do limite de ${MAX_TOTAL_MEDIA_MB}MB.`);
    }

    const mimetype = media.mimetype || 'application/octet-stream';
    const base64 = fs.readFileSync(absPath, { encoding: 'base64' });
    payloads.push({
      dataUri: `data:${mimetype};base64,${base64}`,
      filename: media.originalname || path.basename(absPath),
      absPath,
    });
  }

  forceGc();
  return payloads;
}

/**
 * Espera a memória do container voltar a um patamar seguro. Sem isso o disparo
 * simplesmente continua empurrando mídia até o OOM killer derrubar tudo.
 */
async function waitForMemoryHeadroom() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const mem = memorySnapshot();
    if (mem.pct < MEMORY_CRITICAL_PCT) return true;

    // Sem limite real vindo do cgroup a porcentagem é chute em cima de
    // MEMORY_LIMIT_MB. Pausar o disparo por causa disso só atrasaria o envio.
    if (mem.limitSource !== 'cgroup') return true;

    console.warn(`[RAM] ${mem.pct}% em uso. Pausando o disparo para liberar memória...`);
    io.emit('dispatch_log', {
      type: 'warning',
      message: `Memória em ${mem.pct}% (${mem.usedMB}MB/${mem.limitMB}MB). Pausando alguns segundos...`,
    });

    forceGc();
    await sleep(5000);
  }

  return memorySnapshot().pct < MEMORY_CRITICAL_PCT;
}

async function startBulkDispatch(messageText, mediaFiles = []) {
  if (!wppClient) {
    io.emit('dispatch_error', { message: 'WhatsApp não está conectado.' });
    return;
  }
  if (!validContacts || validContacts.length === 0) {
    io.emit('dispatch_error', { message: 'Nenhum contato disponível para disparo.' });
    return;
  }
  if (isDispatching) {
    io.emit('dispatch_error', { message: 'Um disparo já está em andamento.' });
    return;
  }

  const requestedMedia = Array.isArray(mediaFiles) ? mediaFiles : [];
  const hasMedia = requestedMedia.length > 0;
  const hasText = Boolean(messageText && messageText.trim() !== '');

  if (!hasMedia && !hasText) {
    io.emit('dispatch_error', {
      message: 'Digite uma mensagem de texto ou anexe fotos/vídeos para iniciar o envio.',
    });
    return;
  }

  let payloads = [];
  if (hasMedia) {
    try {
      payloads = prepareMediaPayloads(requestedMedia);
    } catch (err) {
      console.error('[Disparo] Mídia rejeitada:', err.message);
      io.emit('dispatch_error', { message: err.message });
      return;
    }
  }

  isDispatching = true;
  stopDispatchRequested = false;
  const total = validContacts.length;
  const contacts = validContacts.slice();

  console.log(
    `[Disparo] Iniciando envio para ${total} contatos. Mídias: ${payloads.length}. Intervalo: ${DISPATCH_INTERVAL_MS / 1000}s.`
  );
  io.emit('dispatch_started', { total });

  try {
    for (let i = 0; i < total; i++) {
      if (stopDispatchRequested) {
        console.log('[Disparo] Interrompido pelo usuário.');
        io.emit('status', { code: 'STOPPED', message: 'Envios interrompidos pelo usuário.' });
        io.emit('dispatch_stopped', { current: i, total });
        break;
      }

      if (!wppClient) {
        io.emit('dispatch_error', { message: 'A sessão do WhatsApp caiu durante o disparo.' });
        break;
      }

      await waitForMemoryHeadroom();

      const contact = contacts[i];
      const currentNumber = i + 1;

      io.emit('dispatch_progress', {
        current: currentNumber,
        total,
        progressText: `Enviando: ${currentNumber} de ${total}...`,
        contactName: contact.name,
        percentage: Math.round((currentNumber / total) * 100),
      });

      console.log(`[Disparo] (${currentNumber}/${total}) Enviando para ${contact.name} (${contact.id})...`);

      try {
        if (payloads.length > 0) {
          for (let m = 0; m < payloads.length; m++) {
            const payload = payloads[m];
            const caption = m === 0 && hasText ? messageText : '';

            await wppClient.sendFile(contact.id, payload.dataUri, {
              filename: payload.filename,
              caption,
            });

            if (m < payloads.length - 1) await sleep(MEDIA_INTERVAL_MS);
          }
        } else {
          await wppClient.sendText(contact.id, messageText);
        }
        console.log(`[Disparo] (${currentNumber}/${total}) Enviado com sucesso.`);
      } catch (err) {
        console.error(`[Disparo] Erro ao enviar para ${contact.id}:`, err.message);
        io.emit('dispatch_log', {
          type: 'error',
          message: `Falha no envio para ${contact.name} (${contact.id}): ${err.message}`,
        });
      }

      forceGc();

      if (i < total - 1 && !stopDispatchRequested) {
        console.log(`[Anti-Banimento] Aguardando ${DISPATCH_INTERVAL_MS / 1000}s antes do próximo envio...`);
        await sleep(DISPATCH_INTERVAL_MS);
      }
    }

    if (!stopDispatchRequested) {
      console.log('[Disparo] Envio concluído para todos os contatos!');
      io.emit('dispatch_completed', { total });
      io.emit('status', {
        code: 'COMPLETED',
        message: `Envio concluído! Total: ${total} contatos processados.`,
      });
    }
  } catch (err) {
    console.error('[Disparo] Erro inesperado:', err);
    io.emit('dispatch_error', { message: `Erro inesperado no disparo: ${err.message}` });
  } finally {
    // Em finally: antes, um erro no meio do loop deixava isDispatching travado
    // em true e os arquivos temporários no disco para sempre.
    isDispatching = false;
    stopDispatchRequested = false;

    payloads.forEach((payload) => {
      payload.dataUri = null; // libera as strings base64 imediatamente
      try {
        if (fs.existsSync(payload.absPath)) fs.unlinkSync(payload.absPath);
      } catch (e) {
        console.warn(`[Cleanup] Não foi possível apagar ${payload.absPath}:`, e.message);
      }
    });
    payloads = [];
    forceGc();
  }
}

// ---------------------------------------------------------------------------
// 7. Socket.io
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`[Socket.io] Novo cliente conectado: ${socket.id}`);

  socket.emit('config', {
    maxMediaMB: MAX_MEDIA_MB,
    maxTotalMediaMB: MAX_TOTAL_MEDIA_MB,
    maxMediaFiles: MAX_MEDIA_FILES,
    dispatchIntervalSeconds: DISPATCH_INTERVAL_MS / 1000,
  });

  if (wppClient && validContacts.length > 0) {
    socket.emit('status', {
      code: 'READY',
      message: `WhatsApp conectado! Total de ${validContacts.length} contatos.`,
    });
    socket.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
  } else if (validContacts.length > 0) {
    socket.emit('status', {
      code: 'READY',
      message: `${validContacts.length} contatos carregados manualmente.`,
    });
    socket.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
  } else if (initPromise) {
    socket.emit('status', { code: 'INITIALIZING', message: 'Aguardando inicialização do WhatsApp...' });
  } else if (wppClient) {
    socket.emit('status', { code: 'CONNECTED', message: 'WhatsApp conectado.' });
  } else {
    socket.emit('status', {
      code: 'DISCONNECTED',
      message: 'Desconectado. Conecte o celular ou importe contatos.',
    });
  }

  socket.on('start_session', () => {
    initWppSession(false).catch((err) => console.error('[WPPConnect]', err));
  });

  socket.on('reset_session', () => {
    console.log('[WPPConnect] Reset de sessão solicitado pelo usuário.');
    if (initPromise) {
      // Não dá para resetar no meio de um create() sem arriscar deixar um
      // Chromium órfão; o usuário é avisado em vez de receber falso sucesso.
      socket.emit('status', {
        code: 'INITIALIZING',
        message: 'Já existe uma inicialização em andamento. Aguarde ela terminar para resetar.',
      });
      return;
    }
    initWppSession(true).catch((err) => console.error('[WPPConnect]', err));
  });

  socket.on('reload_contacts', () => {
    if (wppClient) {
      extractAndFilterContacts();
    } else {
      socket.emit('status', {
        code: 'WARNING',
        message: 'WhatsApp não está conectado para puxar da agenda. Conecte primeiro.',
      });
    }
  });

  socket.on('set_custom_contacts', (data) => {
    const { contactsText, mode } = data || {};
    const parsed = parseRawContacts(contactsText);

    if (parsed.length === 0) {
      socket.emit('dispatch_error', {
        message: 'Nenhum número válido foi encontrado no texto/arquivo fornecido.',
      });
      return;
    }

    if (mode === 'append') {
      const map = new Map();
      validContacts.forEach((c) => map.set(c.id, c));
      parsed.forEach((c) => map.set(c.id, c));
      validContacts = Array.from(map.values());
    } else {
      validContacts = parsed;
    }

    console.log(`[Contatos] Lista atualizada: ${validContacts.length} contatos.`);
    io.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
    io.emit('status', {
      code: 'READY',
      message: `Sucesso! Total de ${validContacts.length} contatos prontos para envio.`,
    });
  });

  socket.on('clear_contacts', () => {
    validContacts = [];
    io.emit('contacts_loaded', { count: 0, contacts: [] });
    io.emit('status', { code: 'READY', message: 'Lista de contatos limpa.' });
  });

  socket.on('remove_contact', (data) => {
    const { contactId } = data || {};
    if (!contactId) return;
    validContacts = validContacts.filter((c) => c.id !== contactId);
    io.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
    io.emit('status', {
      code: 'READY',
      message: `Contato removido. Total restante: ${validContacts.length} contatos.`,
    });
  });

  socket.on('start_dispatch', (data) => {
    const { message, mediaFiles } = data || {};
    startBulkDispatch(message, mediaFiles).catch((err) => {
      console.error('[Disparo] Erro não tratado:', err);
      io.emit('dispatch_error', { message: err.message });
    });
  });

  socket.on('stop_dispatch', () => {
    if (isDispatching) {
      stopDispatchRequested = true;
      socket.emit('status', { code: 'STOPPING', message: 'Parando disparos após a mensagem atual...' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Cliente desconectado: ${socket.id}`);
  });
});

// ---------------------------------------------------------------------------
// 8. Encerramento limpo
// ---------------------------------------------------------------------------
//
// O Render manda SIGTERM a cada deploy. Sem este handler o Chromium fica órfão
// e continua ocupando a RAM que a nova instância precisa para subir.

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} recebido. Fechando o navegador...`);

  const forceExit = setTimeout(() => process.exit(1), 15000);
  forceExit.unref();

  try {
    await closeBrowser();
    await new Promise((resolve) => server.close(resolve));
  } catch (e) {
    /* noop */
  }

  console.log('[Shutdown] Finalizado.');
  process.exit(0);
}

['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => {
    gracefulShutdown(signal);
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Promise rejeitada sem tratamento:', reason);
});

server.listen(PORT, () => {
  const mem = memorySnapshot();
  console.log('===================================================');
  console.log(`🚀 Servidor rodando na porta: ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(
    `💾 Memória do container: ${mem.usedMB}MB (${mem.usageSource})` +
      ` / ${mem.limitMB}MB (${mem.limitSource})`
  );
  console.log(`📎 Mídia: até ${MAX_MEDIA_MB}MB por arquivo, ${MAX_TOTAL_MEDIA_MB}MB no total`);
  console.log('===================================================');

  if (BROWSER_WS) {
    console.log(`🔗 Navegador remoto: ${BROWSER_WS} (este processo não abre Chromium)`);
  } else if (mem.limitMB < 1024) {
    console.warn(
      `⚠️  ${mem.limitMB}MB de RAM. O Chromium + WhatsApp Web precisa de ~700MB-1GB no pico.\n` +
        '    Use uma instância de 2GB, ou aponte BROWSER_WS para um Chromium externo.'
    );
  }
});
