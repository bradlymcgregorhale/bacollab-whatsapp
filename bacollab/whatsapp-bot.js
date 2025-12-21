import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, NoAuth } = pkg;
import qrcode from 'qrcode-terminal';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || 'Trash';
const API_URL = process.env.API_URL || 'http://localhost:3000';
const PHOTOS_DIR = path.join(__dirname, 'photos');

// Ensure photos directory exists
if (!fs.existsSync(PHOTOS_DIR)) {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
}

// Reports log file
const REPORTS_LOG = path.join(__dirname, 'reports.csv');

// Initialize reports log with header if it doesn't exist
if (!fs.existsSync(REPORTS_LOG)) {
  fs.writeFileSync(REPORTS_LOG, 'numero,fecha,direccion,link\n');
}

// Errors log file
const ERRORS_LOG = path.join(__dirname, 'errors.log');

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY
});

// Request queue - processes one solicitud at a time
const requestQueue = [];
let isProcessingQueue = false;

// Pending messages buffer - collects messages before processing
// Key: senderId, Value: { messages: [], timer: null, senderName: string }
// messages format: { text: string|null, photo: string|null, timestamp: Date }
const pendingMessages = new Map();

// Group message history - per user, kept for 2 hours
// Key: senderId, Value: [{ text, photo, timestamp }]
const userMessageHistory = new Map();
const MAX_HISTORY_PER_USER = 100;
const MESSAGE_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours

// Debounce time - wait for user to finish sending messages
const DEBOUNCE_MS = 3000;
// Longer debounce when we have photos but no address yet
const DEBOUNCE_PHOTO_MS = 8000;
// Max messages to wait before asking for address
const MAX_MESSAGES_BEFORE_ASK = 5;

// System prompt file path - loaded on each request for hot-reload
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'system-prompt.txt');

// Function to load system prompt from file (allows hot-reload without restart)
function getSystemPrompt() {
  try {
    return fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf-8');
  } catch (e) {
    console.error('Error loading system-prompt.txt:', e.message);
    return 'Extract addresses from messages and respond in JSON format.';
  }
}

class TrashReportBot {
  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        timeout: 60000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--no-first-run',
          '--single-process' // Important for low-resource servers
        ]
      }
    });

    this.chatCache = new Map();
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    // Debug events to track initialization
    this.client.on('auth_failure', msg => {
      console.log('[DEBUG] Auth failure:', msg);
    });

    this.client.on('change_state', state => {
      console.log('[DEBUG] State changed:', state);
    });

    this.client.on('qr', qr => {
      console.log('\n========================================');
      console.log('  Escaneá este código QR con WhatsApp');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('ready', async () => {
      console.log('\n========================================');
      console.log('  Bot de WhatsApp listo!');
      console.log(`  Monitoreando grupo: "${GROUP_NAME}"`);
      console.log('========================================\n');

      // Check past 50 messages for any unprocessed requests
      await this.checkPastMessages();
    });

    this.client.on('authenticated', () => {
      console.log('[3/4] Autenticación exitosa');
    });

    this.client.on('auth_failure', msg => {
      console.error('Error de autenticación:', msg);
    });

    this.client.on('message', async msg => {
      await this.handleMessage(msg);
    });
  }

  async handleMessage(msg) {
    try {
      const chat = await msg.getChat();

      // Only respond to messages in the target group
      if (!chat.isGroup || chat.name !== GROUP_NAME) {
        return;
      }

      const senderId = msg.author || msg.from;
      let senderName = 'Vecino';
      // Extract phone number from senderId for mentions (e.g., "5491123456789" from "5491123456789@c.us")
      const senderPhone = senderId.split('@')[0];

      try {
        const contact = await msg.getContact();
        senderName = contact.pushname || contact.name || senderPhone;
      } catch (e) {
        // Use phone number as fallback name
        senderName = senderPhone;
      }

      // Cache the chat and senderId for later use (for mentions)
      this.chatCache.set(senderId, chat);
      this.senderIdCache = this.senderIdCache || new Map();
      this.senderIdCache.set(senderId, { senderId, senderPhone, senderName });

      console.log(`\n[${new Date().toLocaleTimeString()}] Mensaje de ${senderName}:`);
      console.log(`  Texto: ${msg.body || '(sin texto)'}`);
      console.log(`  Tiene media: ${msg.hasMedia}`);

      // Create message object with text and/or photo
      const messageObj = {
        text: msg.body || null,
        photo: null,
        timestamp: new Date()
      };

      // Handle photo or video
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media && media.mimetype.startsWith('image/')) {
          const photoPath = await this.savePhoto(media, senderId);
          messageObj.photo = photoPath;
          console.log(`  Foto guardada: ${photoPath}`);
        } else if (media && media.mimetype.startsWith('video/')) {
          // Extract first frame from video using ffmpeg
          console.log(`  Video detectado, extrayendo frame...`);
          const photoPath = await this.extractVideoFrame(media, senderId);
          if (photoPath) {
            messageObj.photo = photoPath;
            console.log(`  Frame extraído: ${photoPath}`);
          } else {
            console.log(`  No se pudo extraer frame del video`);
          }
        }
      }

      // Add to user's message history
      let userHistory = userMessageHistory.get(senderId);
      if (!userHistory) {
        userHistory = [];
        userMessageHistory.set(senderId, userHistory);
      }
      userHistory.push(messageObj);

      // Clean up messages older than 2 hours or if over max count
      const now = Date.now();
      while (userHistory.length > 0) {
        const oldest = userHistory[0];
        const age = now - oldest.timestamp.getTime();
        if (age > MESSAGE_RETENTION_MS || userHistory.length > MAX_HISTORY_PER_USER) {
          const removed = userHistory.shift();
          if (removed.photo) {
            try { fs.unlinkSync(removed.photo); } catch (e) {}
          }
        } else {
          break;
        }
      }

      // Get or create pending messages buffer for this user
      let pending = pendingMessages.get(senderId);
      if (!pending) {
        pending = {
          messages: [],
          timer: null,
          senderName,
          chatId: chat.id._serialized,
          hasAskedForAddress: false
        };
        pendingMessages.set(senderId, pending);
      }

      // Clear existing timer
      if (pending.timer) {
        clearTimeout(pending.timer);
      }

      // Add this message to pending
      pending.messages.push(messageObj);

      // Smart debounce: wait longer if we have photos but no text with potential address
      const hasPhotos = pending.messages.some(m => m.photo);
      const hasTextWithNumbers = pending.messages.some(m => m.text && /\d+/.test(m.text));

      // Use longer debounce if we have photos but no address-like text yet
      const debounceTime = (hasPhotos && !hasTextWithNumbers) ? DEBOUNCE_PHOTO_MS : DEBOUNCE_MS;

      if (hasPhotos && !hasTextWithNumbers) {
        console.log(`  [Debounce] Foto sin dirección detectada, esperando ${debounceTime/1000}s...`);
      }

      // Set debounce timer - wait for more messages before processing
      pending.timer = setTimeout(async () => {
        await this.processPendingMessages(senderId);
      }, debounceTime);

    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  async processPendingMessages(senderId) {
    const pending = pendingMessages.get(senderId);
    if (!pending || pending.messages.length === 0) {
      pendingMessages.delete(senderId);
      return;
    }

    const chat = this.chatCache.get(senderId);
    if (!chat) {
      console.error('Chat not found for sender:', senderId);
      pendingMessages.delete(senderId);
      return;
    }

    const photoCount = pending.messages.filter(m => m.photo).length;
    console.log(`\n[Processing] ${pending.senderName}: ${pending.messages.length} mensajes, ${photoCount} fotos`);

    try {
      // Use Claude to extract requests
      const extraction = await this.extractRequests(pending);

      // Handle address corrections
      if (extraction.isCorrection && extraction.correctedAddress) {
        const senderInfo = this.senderIdCache?.get(senderId);
        const mentions = senderInfo ? [senderInfo.senderId] : [];
        const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

        // Find pending request from this sender in the queue
        const pendingRequestIdx = requestQueue.findIndex(r => r.senderId === senderId);

        if (pendingRequestIdx !== -1 && !isProcessingQueue) {
          // Can cancel - request is still in queue
          const oldAddress = requestQueue[pendingRequestIdx].address;
          requestQueue[pendingRequestIdx].address = extraction.correctedAddress;
          console.log(`  [Bot] Corrección: "${oldAddress}" → "${extraction.correctedAddress}"`);
          await chat.sendMessage(`${mentionText} Dale, cambio la dirección a ${extraction.correctedAddress}.`.trim(), { mentions });
        } else if (pendingRequestIdx !== -1) {
          // Request is being processed, too late
          console.log(`  [Bot] Corrección tarde - solicitud ya procesándose`);
          await chat.sendMessage(`${mentionText} Uy, ya mandé la solicitud anterior. Voy a mandar otra para ${extraction.correctedAddress}.`.trim(), { mentions });

          // Queue the corrected address as a new request
          const existingReq = requestQueue[pendingRequestIdx];
          requestQueue.push({
            ...existingReq,
            address: extraction.correctedAddress
          });
        } else {
          // No pending request found - treat as new request
          console.log(`  [Bot] Corrección pero no hay solicitud pendiente`);
        }

        pending.messages = [];
        pending.timer = null;
        pendingMessages.delete(senderId);
        return;
      }

      // If nothing actionable and no response needed, stay quiet
      if (!extraction.requests || extraction.requests.length === 0) {
        // Only respond if Claude says we should (e.g., asking for address)
        if (extraction.shouldRespond && extraction.response) {
          const senderInfo = this.senderIdCache?.get(senderId);
          const mentions = senderInfo ? [senderInfo.senderId] : [];
          const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';
          await chat.sendMessage(`${mentionText} ${extraction.response}`.trim(), { mentions });
          console.log(`  [Bot] @${pending.senderName} ${extraction.response}`);
          // Reset messages but keep for follow-up
          pending.messages = [];
          pending.timer = null;
          return;
        }
        console.log('  [Bot] Nada actionable, ignorando');
        pendingMessages.delete(senderId);
        return;
      }

      // We have valid requests - queue them directly (ignore shouldRespond if we have requests)
      if (extraction.requests && extraction.requests.length > 0) {
        // Acknowledge the request with report type description
        const senderInfo = this.senderIdCache?.get(senderId);
        const mentions = senderInfo ? [senderInfo.senderId] : [];
        const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

        // Build descriptive message for each request type
        const requestDescriptions = extraction.requests.map(r => {
          const addr = r.address;
          if (r.reportType === 'barrido') {
            return `mejora de barrido en ${addr}`;
          } else {
            return `recolección de residuos en ${addr}`;
          }
        });

        const descriptionText = requestDescriptions.length === 1
          ? requestDescriptions[0]
          : requestDescriptions.join(' y ');

        await chat.sendMessage(`${mentionText} Ya mando la solicitud de ${descriptionText}...`.trim(), { mentions });
        console.log(`  [Bot] Procesando: ${descriptionText}`);

        for (const req of extraction.requests) {
          let photo = null;
          // Use msgIndex if provided (1-indexed)
          if (req.msgIndex && pending.messages[req.msgIndex - 1]?.photo) {
            photo = pending.messages[req.msgIndex - 1].photo;
          } else {
            // Fallback: find by address match or use most recent photo
            const matchingMsg = [...pending.messages].reverse().find(m =>
              m.photo && m.text && m.text.toLowerCase().includes(req.address.toLowerCase().split(' ')[0])
            );
            photo = matchingMsg?.photo || [...pending.messages].reverse().find(m => m.photo)?.photo || null;
          }

          requestQueue.push({
            senderId,
            senderName: pending.senderName,
            address: req.address,
            reportType: req.reportType || 'recoleccion',
            containerType: req.containerType || 'negro',
            photo,
            chat
          });
        }

        console.log(`  Queued ${extraction.requests.length} request(s)`);
        for (const req of extraction.requests) {
          const reportTypeLabel = req.reportType === 'barrido' ? 'barrido' : 'recoleccion';
          console.log(`    - ${req.address} (tipo: ${reportTypeLabel}, msgIndex: ${req.msgIndex || 'auto'}, foto: ${req.photo ? 'sí' : 'no'})`);
        }

        // Clear pending messages for this user
        pendingMessages.delete(senderId);

        // Start processing queue
        this.processQueue();
      }

    } catch (error) {
      console.error('Error processing pending messages:', error);
      pendingMessages.delete(senderId);
    }
  }

  async extractRequests(pending) {
      // Build message list with text and photo indicators
      const messagesWithPhotos = pending.messages.map((m, i) => {
        let desc = '';
        if (m.text) desc += m.text;
        if (m.photo) desc += desc ? ' [+FOTO]' : '[FOTO sin texto]';
        return `Msg${i + 1}: ${desc}`;
      }).join('\n');

      const photos = pending.messages.filter(m => m.photo).map(m => m.photo);
      const hasPhotos = photos.length > 0;

      const prompt = `MENSAJES DE ${pending.senderName}:
${messagesWithPhotos}

${hasPhotos ? `[Envió ${photos.length} foto(s) - analizalas. Cada foto corresponde al mensaje marcado con [+FOTO]]` : '[No envió fotos]'}

¿Hay algo actionable? Recordá que DEBE verse un contenedor de CABA en la foto para ser válido.`;

      // Build message content with images if available
      const content = [];

      // Add photos with labels for vision analysis
      if (hasPhotos) {
        for (let i = 0; i < pending.messages.length; i++) {
          const m = pending.messages[i];
          if (m.photo) {
            try {
              const imageData = fs.readFileSync(m.photo);
              const base64 = imageData.toString('base64');
              const ext = path.extname(m.photo).slice(1).toLowerCase();
              const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

              // Add label before image
              content.push({
                type: 'text',
                text: `[Foto del Msg${i + 1}${m.text ? ': "' + m.text + '"' : ''}]`
              });

              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64
                }
              });
            } catch (e) {
              console.error('Error loading photo:', e);
            }
          }
        }
      }

      // Add text prompt
      content.push({ type: 'text', text: prompt });

      // Retry logic for Claude API
      const MAX_RETRIES = 3;
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await anthropic.messages.create({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 500,
            system: getSystemPrompt(),
            messages: [{ role: 'user', content }]
          });

          const responseText = response.content[0].text;
          console.log('  [Claude raw]', responseText.substring(0, 200));

          // Parse JSON response
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }

          return { shouldRespond: true, requests: [], response: 'No entendí tu mensaje. ¿Podés decirme la dirección?' };

        } catch (error) {
          lastError = error;
          const isOverloaded = error.status === 529 || error.message?.includes('Overloaded');
          const isRetryable = isOverloaded || error.status === 500 || error.status === 503;

          // Log error
          const timestamp = new Date().toISOString();
          const logLine = `[${timestamp}] Attempt ${attempt}/${MAX_RETRIES} - ${error.status || 'unknown'}: ${error.message}\n`;
          fs.appendFileSync(ERRORS_LOG, logLine);
          console.error(`  [Claude] Attempt ${attempt}/${MAX_RETRIES} failed: ${error.status} ${error.message}`);

          if (isRetryable && attempt < MAX_RETRIES) {
            const waitTime = attempt * 5000; // 5s, 10s, 15s
            console.log(`  [Claude] Retrying in ${waitTime / 1000}s...`);
            await this.delay(waitTime);
            continue;
          }

          break;
        }
      }

      // All retries failed
      const timestamp = new Date().toISOString();
      fs.appendFileSync(ERRORS_LOG, `[${timestamp}] All retries failed for user message\n`);
      console.error('  [Claude] All retries failed');
      return { shouldRespond: true, requests: [], response: 'Disculpá, el sistema está saturado. Intentá de nuevo en unos minutos.' };
  }

  async processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) {
      return;
    }

    isProcessingQueue = true;

    while (requestQueue.length > 0) {
      const request = requestQueue.shift();
      await this.submitRequest(request);

      // Small delay between requests
      if (requestQueue.length > 0) {
        await this.delay(2000);
      }
    }

    isProcessingQueue = false;
  }

  async submitRequest(request) {
    const { senderId, senderName, address, reportType = 'recoleccion', containerType, photo, chat } = request;
    const senderInfo = this.senderIdCache?.get(senderId);
    const mentions = senderInfo ? [senderInfo.senderId] : [senderId];
    const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : `@${senderId.split('@')[0]}`;
    const reportTypeName = reportType === 'barrido' ? 'Mejora de barrido' : 'Recolección de residuos';

    console.log('\n========================================');
    console.log('  ENVIANDO SOLICITUD');
    console.log(`  Vecino: ${senderName}`);
    console.log(`  Dirección: ${address}`);
    console.log(`  Tipo de reporte: ${reportTypeName}`);
    console.log(`  Foto: ${photo ? 'Sí' : 'No'}`);
    if (reportType === 'recoleccion') {
      console.log(`  Contenedor: ${containerType}`);
    }
    console.log('========================================\n');

    try {
      // Call the API
      const response = await fetch(`${API_URL}/solicitud`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          reportType,
          containerType,
          photos: photo ? [photo] : []
        })
      });

      const result = await response.json();

      if (result.success && result.solicitudNumber) {
        // Format solicitud number for URL (replace / with &)
        const solicitudUrl = `https://bacolaborativa.buenosaires.gob.ar/detalleSolicitud/${result.solicitudNumber.replace(/\//g, '&')}?vieneDeMisSolicitudes=false`;

        // Log to CSV file
        const today = new Date();
        const dateStr = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;
        const csvLine = `${result.solicitudNumber},${dateStr},"${address}",${solicitudUrl}\n`;
        fs.appendFileSync(REPORTS_LOG, csvLine);
        console.log(`  [Log] Guardado en reports.csv`);

        const successMsg = `${mentionText} Listo, mandé la solicitud para ${address}. #${result.solicitudNumber}\n${solicitudUrl}`;
        await chat.sendMessage(successMsg, { mentions });
        console.log(`  [Bot] Solicitud enviada: #${result.solicitudNumber}`);
      } else if (result.success) {
        const successMsg = `${mentionText} Listo, mandé la solicitud para ${address}.`;
        await chat.sendMessage(successMsg, { mentions });
        console.log(`  [Bot] Solicitud enviada (sin número)`);
      } else {
        await chat.sendMessage(`${mentionText} No pude mandar la solicitud para ${address}. Intentá de nuevo.`, { mentions });
        console.log(`  [Bot] Error: ${result.error}`);
      }

      // Clean up photo after submission
      if (photo) {
        try {
          fs.unlinkSync(photo);
        } catch (e) {}
      }

    } catch (error) {
      console.error('Error submitting solicitud:', error);
      await chat.sendMessage(`No pude mandar la solicitud para ${address}. Intentá de nuevo.`);
    }
  }

  async savePhoto(media, senderId) {
    const timestamp = Date.now();
    const extension = media.mimetype.split('/')[1] || 'jpg';
    const filename = `${senderId.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.${extension}`;
    const filepath = path.join(PHOTOS_DIR, filename);

    const buffer = Buffer.from(media.data, 'base64');
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }

  async extractVideoFrame(media, senderId) {
    const { execSync } = await import('child_process');
    const timestamp = Date.now();
    const videoExt = media.mimetype.split('/')[1] || 'mp4';
    const videoFilename = `${senderId.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.${videoExt}`;
    const videoPath = path.join(PHOTOS_DIR, videoFilename);
    const frameFilename = `${senderId.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}_frame.jpg`;
    const framePath = path.join(PHOTOS_DIR, frameFilename);

    try {
      // Save video temporarily
      const buffer = Buffer.from(media.data, 'base64');
      fs.writeFileSync(videoPath, buffer);

      // Extract first frame using ffmpeg (at 0.5 seconds to avoid black frames)
      execSync(`ffmpeg -y -i "${videoPath}" -ss 00:00:00.5 -vframes 1 -q:v 2 "${framePath}" 2>/dev/null`, {
        timeout: 30000
      });

      // Clean up video file
      try { fs.unlinkSync(videoPath); } catch (e) {}

      // Check if frame was extracted
      if (fs.existsSync(framePath)) {
        return framePath;
      }
      return null;
    } catch (e) {
      console.error('Error extracting video frame:', e.message);
      // Clean up files
      try { fs.unlinkSync(videoPath); } catch (e) {}
      try { fs.unlinkSync(framePath); } catch (e) {}
      return null;
    }
  }

  async getSenderName(msg) {
    try {
      const contact = await msg.getContact();
      return contact.pushname || contact.name || 'Vecino';
    } catch {
      return 'Vecino';
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Load already processed solicitud numbers from CSV
  getProcessedSolicitudes() {
    const processed = new Set();
    if (fs.existsSync(REPORTS_LOG)) {
      const content = fs.readFileSync(REPORTS_LOG, 'utf-8');
      const lines = content.split('\n').slice(1); // Skip header
      for (const line of lines) {
        if (line.trim()) {
          // Extract address from CSV line
          const match = line.match(/"([^"]+)"/);
          if (match) {
            processed.add(match[1].toLowerCase());
          }
        }
      }
    }
    return processed;
  }

  async checkPastMessages() {
    console.log('[Startup] Buscando mensajes anteriores no procesados...');

    try {
      // Find the target group
      const chats = await this.client.getChats();
      const targetChat = chats.find(c => c.isGroup && c.name === GROUP_NAME);

      if (!targetChat) {
        console.log(`[Startup] Grupo "${GROUP_NAME}" no encontrado`);
        return;
      }

      // Get last 5 messages
      const messages = await targetChat.fetchMessages({ limit: 5 });
      console.log(`[Startup] Revisando ${messages.length} mensajes anteriores...`);

      // Get already processed addresses
      const processedAddresses = this.getProcessedSolicitudes();
      console.log(`[Startup] ${processedAddresses.size} direcciones ya procesadas en CSV`);

      // Group messages by sender for processing
      const messagesBySender = new Map();

      for (const msg of messages) {
        // Skip old messages (older than 2 hours)
        const msgAge = Date.now() - msg.timestamp * 1000;
        if (msgAge > MESSAGE_RETENTION_MS) continue;

        const senderId = msg.author || msg.from;
        if (!messagesBySender.has(senderId)) {
          messagesBySender.set(senderId, []);
        }

        const messageObj = {
          text: msg.body || null,
          photo: null,
          timestamp: new Date(msg.timestamp * 1000)
        };

        // Download photo if present
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media && media.mimetype.startsWith('image/')) {
              const photoPath = await this.savePhoto(media, senderId);
              messageObj.photo = photoPath;
            }
          } catch (e) {
            console.log(`[Startup] Error descargando foto: ${e.message}`);
          }
        }

        messagesBySender.get(senderId).push(messageObj);
      }

      console.log(`[Startup] ${messagesBySender.size} usuarios con mensajes recientes`);

      // Process each user's messages to find unprocessed requests
      for (const [senderId, userMessages] of messagesBySender) {
        if (userMessages.length === 0) continue;

        const senderName = 'Vecino'; // Will be resolved later
        const pending = {
          messages: userMessages,
          senderName,
          chatId: targetChat.id._serialized
        };

        // Cache the chat
        this.chatCache.set(senderId, targetChat);

        // Use Claude to check for actionable requests
        const extraction = await this.extractRequests(pending);

        if (extraction.requests && extraction.requests.length > 0) {
          for (const req of extraction.requests) {
            // Skip if no address
            if (!req.address) {
              console.log(`[Startup] Request sin dirección, ignorando`);
              continue;
            }
            // Skip if already processed
            if (processedAddresses.has(req.address.toLowerCase())) {
              console.log(`[Startup] Ya procesado: ${req.address}`);
              continue;
            }

            // Find matching photo
            let photo = null;
            if (req.msgIndex && userMessages[req.msgIndex - 1]?.photo) {
              photo = userMessages[req.msgIndex - 1].photo;
            } else {
              photo = [...userMessages].reverse().find(m => m.photo)?.photo || null;
            }

            console.log(`[Startup] Encontrado pendiente: ${req.address}`);
            requestQueue.push({
              senderId,
              senderName,
              address: req.address,
              reportType: req.reportType || 'recoleccion',
              containerType: req.containerType || 'negro',
              photo,
              chat: targetChat
            });
          }
        }

        // Small delay to avoid rate limiting
        await this.delay(1000);
      }

      if (requestQueue.length > 0) {
        console.log(`[Startup] ${requestQueue.length} solicitudes pendientes encontradas`);
        this.processQueue();
      } else {
        console.log('[Startup] No hay solicitudes pendientes');
      }

    } catch (error) {
      console.error('[Startup] Error revisando mensajes:', error);
    }
  }

  async start() {
    console.log('\n========================================');
    console.log('  Iniciando Bot de WhatsApp...');
    console.log('========================================\n');

    console.log('[DEBUG] Platform:', process.platform);
    console.log('[DEBUG] Node version:', process.version);

    // Kill any existing whatsapp-bot processes and zombie Chrome/Chromium
    console.log('[0/4] Limpiando procesos anteriores...');
    const { execSync } = await import('child_process');

    // Kill zombie Chrome/Chromium processes first
    try {
      execSync('pkill -9 -f "chrome.*whatsapp-web" 2>/dev/null || true', { stdio: 'ignore' });
      execSync('pkill -9 -f "chromium.*whatsapp-web" 2>/dev/null || true', { stdio: 'ignore' });
      // Also kill orphaned chrome processes from previous runs
      execSync('pkill -9 -f ".local-chromium" 2>/dev/null || true', { stdio: 'ignore' });
    } catch (e) {
      // Ignore - no Chrome processes to kill
    }

    // Kill other whatsapp-bot node processes
    try {
      const myPid = process.pid;
      const result = execSync(`ps aux | grep "whatsapp-bot" | grep -v grep | awk '{print $2}'`, { encoding: 'utf-8' });
      const pids = result.trim().split('\n').filter(pid => pid && parseInt(pid) !== myPid);
      if (pids.length > 0) {
        console.log(`  Matando procesos node: ${pids.join(', ')}`);
        execSync(`kill -9 ${pids.join(' ')}`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore errors - no processes to kill
    }

    console.log('[1/4] Iniciando Puppeteer (Chromium)...');
    const startTime = Date.now();

    this.client.on('loading_screen', (percent, message) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[2/4] ${elapsed}s - Cargando WhatsApp: ${percent}% - ${message}`);
    });

    // Add more debug events
    this.client.on('disconnected', (reason) => {
      console.log('[DEBUG] Disconnected:', reason);
    });

    console.log('[DEBUG] Calling client.initialize()...');
    console.log('[DEBUG] This may take 1-2 minutes on first run...');

    // Add timeout
    const initPromise = this.client.initialize();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Initialization timeout after 3 minutes')), 180000)
    );

    try {
      await Promise.race([initPromise, timeoutPromise]);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[4/4] Inicialización completa (${elapsed}s total)`);
    } catch (err) {
      console.error('[DEBUG] Error durante inicialización:', err);
      process.exit(1);
    }
  }
}

// Start the bot
const bot = new TrashReportBot();
bot.start();

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\nCerrando bot...');
  await bot.client.destroy();
  process.exit(0);
});
