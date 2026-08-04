const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const wppconnect = require('@wppconnect-team/wppconnect');

// 1. Configuração do Servidor e Nuvem
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// Criar diretório de uploads se não existir
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configuração do Multer para salvamento de mídias (fotos e vídeos)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'media-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // limite de 100MB por arquivo
});

// Servir arquivos estáticos do frontend e pasta de uploads
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

// Endpoints da API REST para Upload de Mídias
app.post('/api/upload', upload.array('mediaFiles', 5), (req, res) => {
  try {
    const files = (req.files || []).map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      path: file.path,
      size: file.size
    }));
    console.log(`[Upload] ${files.length} arquivo(s) de mídia recebidos com sucesso.`);
    res.json({ success: true, files });
  } catch (err) {
    console.error('[Upload] Erro ao fazer upload de mídias:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/upload/:filename', (req, res) => {
  try {
    const filePath = path.join(uploadsDir, req.params.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Upload] Arquivo removido: ${req.params.filename}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Porta configurada dinamicamente para o ambiente de nuvem (Render, Heroku, Railway, etc.)
const PORT = process.env.PORT || 3000;

// Estado em memória
let wppClient = null;
let isInitializing = false;
let validContacts = [];
let isDispatching = false;
let stopDispatchRequested = false;

// Monitoramento periódico de RAM e Coleta de Lixo (Garbage Collection) para o plano 512MB do Render
setInterval(() => {
  const memory = process.memoryUsage();
  const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
  const rssMB = Math.round(memory.rss / 1024 / 1024);

  if (rssMB > 350) {
    console.warn(`[RAM Render] Uso de memória: RSS ${rssMB}MB | Heap ${heapUsedMB}MB. Forçando liberação de RAM...`);
    if (global.gc) {
      try {
        global.gc();
      } catch (e) {}
    }
  }
}, 25000);

// 3. Função utilitária de Sleep / Delay baseada em Promise e setTimeout (Requisito Crítico Anti-Banimento)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inicialização da sessão do WhatsApp via WPPConnect
 */
async function initWppSession(forceFresh = false) {
  if (wppClient) {
    io.emit('status', { code: 'CONNECTED', message: 'Sessão já está ativa e conectada.' });
    if (validContacts.length > 0) {
      io.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
    }
    return;
  }

  if (isInitializing) {
    io.emit('status', { code: 'INITIALIZING', message: 'A inicialização já está em andamento...' });
    return;
  }

  // Se forceFresh for true, apaga a pasta de tokens anterior para forçar um QR Code novo
  const sessionPath = path.join(__dirname, 'tokens', 'disparo-esporadico-session');
  if (forceFresh && fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log('[WPPConnect] Pasta de sessão anterior removida.');
    } catch (e) {
      console.warn('[WPPConnect] Aviso ao limpar sessão:', e.message);
    }
  }

  isInitializing = true;
  io.emit('status', { code: 'STARTING', message: 'Iniciando o navegador Puppeteer...' });

  try {
    const client = await wppconnect.create({
      session: 'disparo-esporadico-session',
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`[WPPConnect] QR Code gerado (Tentativa ${attempts})`);
        
        let formattedQr = base64Qr;
        if (base64Qr && !base64Qr.startsWith('data:') && !base64Qr.startsWith('http')) {
          formattedQr = `data:image/png;base64,${base64Qr}`;
        }

        io.emit('qr', { qrCode: formattedQr, attempts });
        io.emit('status', { code: 'QR_READY', message: 'QR Code pronto! Abra o WhatsApp no celular e escaneie.' });
      },
      statusFind: (statusSession, session) => {
        console.log(`[WPPConnect] Status da sessão: ${statusSession}`);
        
        if (statusSession === 'isLogged' || statusSession === 'inChat' || statusSession === 'qrReadSuccess') {
          io.emit('status', { code: 'CONNECTED', message: 'WhatsApp Conectado com Sucesso!' });
        } else if (statusSession === 'notLogged') {
          io.emit('status', { code: 'QR_READY', message: 'Aguardando leitura do QR Code pelo seu celular...' });
        } else if (statusSession === 'desconnectedMobile' || statusSession === 'browserClosed' || statusSession === 'autocloseCalled') {
          wppClient = null;
          isInitializing = false;
          io.emit('status', { code: 'DISCONNECTED', message: 'Sessão desconectada. Clique em "Conectar Celular".' });
        } else {
          io.emit('status', { code: 'SESSION_STATUS', message: `Status: ${statusSession}` });
        }
      },
      // Otimizações de Velocidade e Conexão Rápida
      updatesLog: false, // Desativa busca externa por atualizações no startup (economiza 3-8s!)
      autoClose: false,
      tokenStore: 'file', // Mantém os tokens em arquivo para não perder o login no restart do container
      folderNameToken: 'tokens',
      puppeteerOptions: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // Usa /tmp em vez de /dev/shm
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
          '--disable-default-apps',
          '--mute-audio',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
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
          '--disable-renderer-backgrounding',
          '--disable-speech-api',
          '--disable-sync',
          '--hide-scrollbars',
          '--ignore-certificate-errors',
          '--metrics-recording-only',
          '--no-pings',
          '--password-store=basic'
        ]
      }
    });

    wppClient = client;
    isInitializing = false;

    // Ativa Bloqueio de Imagens/Estilos/Fontes em segundo plano na página do Chromium para economizar 250MB+ de RAM
    if (client && client.page) {
      try {
        await client.page.setRequestInterception(true);
        client.page.on('request', (req) => {
          const resourceType = req.resourceType();
          // Bloqueia estilos CSS, fontes e mídias visuais pesadas do WhatsApp Web que consomem RAM à toa
          if (['stylesheet', 'font', 'media'].includes(resourceType)) {
            req.abort().catch(() => {});
          } else {
            req.continue().catch(() => {});
          }
        });
        console.log('[RAM Optimization] Interceptador ativado. Folhas de estilo e fontes bloqueadas no Chromium.');
      } catch (err) {
        console.warn('[RAM Optimization] Aviso ao ativar interceptação:', err.message);
      }
    }

    io.emit('status', { code: 'CONNECTED', message: 'Autenticado com sucesso! Extraindo contatos da agenda...' });
    console.log('[WPPConnect] Cliente autenticado com sucesso.');

    // Extração e Filtragem de Contatos
    await extractAndFilterContacts();

  } catch (error) {
    isInitializing = false;
    wppClient = null;
    console.error('[WPPConnect] Erro ao iniciar a sessão:', error);
    io.emit('status', { code: 'ERROR', message: `Falha na inicialização: ${error.message}` });
  }
}

/**
 * Extração de contatos da agenda do chip nativo do WhatsApp e filtragem de Grupos
 */
async function extractAndFilterContacts() {
  if (!wppClient) return;

  try {
    io.emit('status', { code: 'LOADING_CONTACTS', message: 'Buscando contatos e chats ativos...' });

    // Busca contatos e conversas da agenda
    const [allChats, allContacts] = await Promise.all([
      wppClient.getAllChats().catch(() => []),
      wppClient.getAllContacts().catch(() => [])
    ]);

    const contactMap = new Map();

    // Processa chats para encontrar conversas diretas
    allChats.forEach(chat => {
      // Requisito 2: Filtrar estritamente para remover qualquer grupo (isGroup: false)
      const isGroup = chat.isGroup || chat.id?._serialized?.includes('@g.us');
      if (!isGroup && chat.id?._serialized) {
        const id = chat.id._serialized;
        contactMap.set(id, {
          id: id,
          name: chat.name || chat.formattedTitle || chat.contact?.name || chat.contact?.pushname || id.split('@')[0],
          isUser: true
        });
      }
    });

    // Processa lista de contatos para incluir contatos salvos da agenda
    allContacts.forEach(contact => {
      const isGroup = contact.isGroup || contact.id?._serialized?.includes('@g.us');
      const isUser = contact.isUser || contact.id?._serialized?.includes('@c.us');
      
      if (!isGroup && isUser && contact.id?._serialized) {
        const id = contact.id._serialized;
        if (!contactMap.has(id)) {
          contactMap.set(id, {
            id: id,
            name: contact.name || contact.pushname || contact.formattedName || id.split('@')[0],
            isUser: true
          });
        }
      }
    });

    validContacts = Array.from(contactMap.values());
    console.log(`[WPPConnect] Total de contatos válidos (sem grupos): ${validContacts.length}`);

    io.emit('status', { 
      code: 'READY', 
      message: `Conectado com sucesso! Total de ${validContacts.length} contatos carregados.` 
    });

    // Emite o número total de contatos válidos e a lista completa para o frontend
    io.emit('contacts_loaded', { 
      count: validContacts.length,
      contacts: validContacts
    });

  } catch (error) {
    console.error('[WPPConnect] Erro ao extrair contatos:', error);
    io.emit('status', { code: 'ERROR', message: `Erro ao extrair contatos: ${error.message}` });
  }
}

/**
 * Lógica de Disparo em Lote com Suporte a Texto, Foto e Vídeo e Intervalo Fixo de Segurança (Anti-Banimento)
 */
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

  const hasMedia = Array.isArray(mediaFiles) && mediaFiles.length > 0;
  const hasText = messageText && messageText.trim() !== '';

  if (!hasMedia && !hasText) {
    io.emit('dispatch_error', { message: 'Digite uma mensagem de texto ou anexe fotos/vídeos para iniciar o envio.' });
    return;
  }

  isDispatching = true;
  stopDispatchRequested = false;
  const total = validContacts.length;

  console.log(`[Disparo] Iniciando envio para ${total} contatos. Mídias: ${hasMedia ? mediaFiles.length : 0}. Intervalo: 12s.`);
  io.emit('dispatch_started', { total });

  for (let i = 0; i < total; i++) {
    if (stopDispatchRequested) {
      console.log('[Disparo] Disparo interrompido pelo usuário.');
      io.emit('status', { code: 'STOPPED', message: 'Envios interrompidos pelo usuário.' });
      io.emit('dispatch_stopped', { current: i, total });
      break;
    }

    const contact = validContacts[i];
    const currentNumber = i + 1;
    const progressText = `Enviando: ${currentNumber} de ${total}...`;

    console.log(`[Disparo] (${currentNumber}/${total}) Enviando para ${contact.name} (${contact.id})...`);

    // Atualiza o frontend com o progresso exato antes do envio
    io.emit('dispatch_progress', {
      current: currentNumber,
      total: total,
      progressText: progressText,
      contactName: contact.name,
      percentage: Math.round((currentNumber / total) * 100)
    });

    try {
      if (hasMedia) {
        // Envio de Mídia(s) (Foto e/ou Vídeo)
        for (let m = 0; m < mediaFiles.length; m++) {
          const media = mediaFiles[m];
          // Apenas a primeira mídia leva o texto como legenda (caption)
          const caption = (m === 0 && hasText) ? messageText : '';
          const absPath = path.resolve(media.path);

          console.log(`[Disparo] Enviando mídia (${m + 1}/${mediaFiles.length}) "${media.originalname}" para ${contact.name}...`);
          
          await wppClient.sendFile(contact.id, absPath, media.originalname, caption);

          if (m < mediaFiles.length - 1) {
            await sleep(2000); // 2 segundos de pausa entre mídias para o mesmo contato
          }
        }
      } else {
        // Envio apenas de texto
        await wppClient.sendText(contact.id, messageText);
      }
      console.log(`[Disparo] (${currentNumber}/${total}) Enviado com sucesso.`);
    } catch (err) {
      console.error(`[Disparo] Erro ao enviar para ${contact.id}:`, err.message);
      io.emit('dispatch_log', { 
        type: 'error', 
        message: `Falha no envio para ${contact.name} (${contact.id}): ${err.message}` 
      });
    }

    // Força liberação imediata de memória RAM após cada envio (Crítico para Render Free 512MB)
    if (global.gc) {
      try {
        global.gc();
      } catch (e) {}
    }

    // Requisito 3 (Crítico): Intervalo fixo e exato de 12 segundos entre o envio de cada mensagem
    if (i < total - 1 && !stopDispatchRequested) {
      console.log(`[Anti-Banimento] Aguardando exatamente 12 segundos antes do próximo envio...`);
      await sleep(12000);
    }
  }

  isDispatching = false;
  if (!stopDispatchRequested) {
    console.log('[Disparo] Envio concluído para todos os contatos!');
    io.emit('dispatch_completed', { total });
    io.emit('status', { code: 'COMPLETED', message: `Envio concluído! Total: ${total} contatos processados.` });
  }

  // Limpar arquivos temporários após o disparo
  if (hasMedia) {
    mediaFiles.forEach(media => {
      try {
        if (fs.existsSync(media.path)) {
          fs.unlinkSync(media.path);
        }
      } catch (e) {
        console.warn(`[Cleanup] Não foi possível apagar ${media.path}:`, e.message);
      }
    });
  }

  stopDispatchRequested = false;
}


/**
 * Utilitário para interpretar e normalizar contatos a partir de texto (manual, CSV/TXT ou VCF/vCard)
 */
function parseRawContacts(text) {
  if (!text || typeof text !== 'string') return [];
  const map = new Map();

  // Verificação de suporte a arquivos VCF (vCard)
  if (text.includes('BEGIN:VCARD')) {
    const vcards = text.split(/END:VCARD/i);
    vcards.forEach((card) => {
      let name = '';
      const numbers = [];

      const lines = card.split(/\r?\n/);
      lines.forEach((line) => {
        const trimmed = line.trim();
        const upper = trimmed.toUpperCase();
        if (upper.startsWith('FN:') || upper.startsWith('FN;')) {
          name = trimmed.substring(trimmed.indexOf(':') + 1).trim();
        } else if (!name && (upper.startsWith('N:') || upper.startsWith('N;'))) {
          const rawN = trimmed.substring(trimmed.indexOf(':') + 1).trim();
          name = rawN.split(';').filter(Boolean).reverse().join(' ').trim();
        } else if (upper.startsWith('TEL') || upper.includes('TEL;')) {
          const numPart = trimmed.substring(trimmed.indexOf(':') + 1).trim();
          const digits = numPart.replace(/\D/g, '');
          if (digits) numbers.push(digits);
        }
      });

      numbers.forEach((rawNumber) => {
        let finalNum = rawNumber;
        if (finalNum.length === 10 || finalNum.length === 11) {
          finalNum = '55' + finalNum;
        }
        if (finalNum.length >= 10) {
          const id = `${finalNum}@c.us`;
          if (!map.has(id)) {
            map.set(id, {
              id: id,
              name: name || finalNum,
              isUser: true
            });
          }
        }
      });
    });

    return Array.from(map.values());
  }

  // Caso padrão: Leitura de linhas TXT / CSV
  const lines = text.split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let name = '';
    let rawNumber = '';

    const parts = trimmed.split(/[,;\t]/).map(p => p.trim());
    if (parts.length >= 2) {
      const digits0 = parts[0].replace(/\D/g, '');
      const digits1 = parts[1].replace(/\D/g, '');

      if (digits0.length >= 10) {
        rawNumber = digits0;
        name = parts[1] || digits0;
      } else if (digits1.length >= 10) {
        rawNumber = digits1;
        name = parts[0] || digits1;
      } else {
        rawNumber = parts[0].replace(/\D/g, '');
        name = parts[1] || rawNumber;
      }
    } else {
      const digits = trimmed.replace(/\D/g, '');
      rawNumber = digits;
      const nameCandidate = trimmed.replace(/[\d\+\-\(\)\s,;]/g, '').trim();
      name = nameCandidate || digits;
    }

    if (rawNumber) {
      if (rawNumber.length === 10 || rawNumber.length === 11) {
        rawNumber = '55' + rawNumber;
      }

      if (rawNumber.length >= 10) {
        const id = `${rawNumber}@c.us`;
        map.set(id, {
          id: id,
          name: name || rawNumber,
          isUser: true
        });
      }
    }
  });

  return Array.from(map.values());
}

// 4. Comunicação Socket.io em Tempo Real
io.on('connection', (socket) => {
  console.log(`[Socket.io] Novo cliente conectado: ${socket.id}`);

  // Envia estado atual ao reconectar
  if (wppClient && validContacts.length > 0) {
    socket.emit('status', { code: 'READY', message: `WhatsApp Conectado! Total de ${validContacts.length} contatos.` });
    socket.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
  } else if (validContacts.length > 0) {
    socket.emit('status', { code: 'READY', message: `${validContacts.length} contatos carregados manualmente.` });
    socket.emit('contacts_loaded', { count: validContacts.length, contacts: validContacts });
  } else if (isInitializing) {
    socket.emit('status', { code: 'INITIALIZING', message: 'Aguardando inicialização do WhatsApp...' });
  } else {
    socket.emit('status', { code: 'DISCONNECTED', message: 'Desconectado. Conecte o celular ou importe contatos.' });
  }

  // Evento: Solicitação de Conexão
  socket.on('start_session', () => {
    initWppSession(false);
  });

  // Evento: Resetar Sessão e Forçar Gerar Novo QR Code
  socket.on('reset_session', async () => {
    try {
      if (wppClient) {
        await wppClient.logout().catch(() => {});
        await wppClient.close().catch(() => {});
        wppClient = null;
      }
      isInitializing = false;
      
      const tokenDir = path.join(__dirname, 'tokens', 'disparo-esporadico-session');
      if (fs.existsSync(tokenDir)) {
        fs.rmSync(tokenDir, { recursive: true, force: true });
      }
      
      console.log('[WPPConnect] Sessão resetada pelo usuário. Gerando novo QR Code...');
      io.emit('status', { code: 'STARTING', message: 'Sessão resetada! Gerando novo QR Code...' });
      initWppSession(true);
    } catch (err) {
      console.error('[WPPConnect] Erro ao resetar sessão:', err);
      io.emit('status', { code: 'ERROR', message: `Erro ao resetar: ${err.message}` });
    }
  });

  // Evento: Recarregar Contatos da Agenda
  socket.on('reload_contacts', () => {
    if (wppClient) {
      extractAndFilterContacts();
    } else {
      socket.emit('status', { code: 'WARNING', message: 'WhatsApp não está conectado para puxar da agenda. Conecte primeiro.' });
    }
  });

  // Evento: Definir/Adicionar Contatos Manuais ou Importados
  socket.on('set_custom_contacts', (data) => {
    const { contactsText, mode } = data || {};
    const parsed = parseRawContacts(contactsText);

    if (parsed.length === 0) {
      socket.emit('dispatch_error', { message: 'Nenhum número válido foi encontrado no texto/arquivo fornecido.' });
      return;
    }

    if (mode === 'append') {
      const map = new Map();
      validContacts.forEach(c => map.set(c.id, c));
      parsed.forEach(c => map.set(c.id, c));
      validContacts = Array.from(map.values());
    } else {
      validContacts = parsed;
    }

    console.log(`[Contatos] Lista de contatos atualizada: ${validContacts.length} contatos.`);
    io.emit('contacts_loaded', { 
      count: validContacts.length,
      contacts: validContacts
    });
    io.emit('status', { 
      code: 'READY', 
      message: `Sucesso! Total de ${validContacts.length} contatos prontos para envio.` 
    });
  });

  // Evento: Limpar Contatos
  socket.on('clear_contacts', () => {
    validContacts = [];
    io.emit('contacts_loaded', { count: 0, contacts: [] });
    io.emit('status', { code: 'READY', message: 'Lista de contatos limpa.' });
  });

  // Evento: Remover Contato Único
  socket.on('remove_contact', (data) => {
    const { contactId } = data || {};
    if (contactId) {
      validContacts = validContacts.filter(c => c.id !== contactId);
      io.emit('contacts_loaded', { 
        count: validContacts.length,
        contacts: validContacts
      });
      io.emit('status', { 
        code: 'READY', 
        message: `Contato removido. Total restante: ${validContacts.length} contatos.` 
      });
    }
  });

  // Evento: Solicitação de Disparo
  socket.on('start_dispatch', (data) => {
    const { message, mediaFiles } = data || {};
    startBulkDispatch(message, mediaFiles);
  });

  // Evento: Cancelar Disparo
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

// Inicialização do Servidor Express
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Servidor rodando na porta: ${PORT}`);
  console.log(`🌐 Acesse localmente: http://localhost:${PORT}`);
  console.log(`===================================================`);
});
