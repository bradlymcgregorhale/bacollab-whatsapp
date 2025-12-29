import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, NoAuth } = pkg;
import qrcode from 'qrcode-terminal';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { postToX, initXPoster, closeXBrowser } from './x-poster.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Setup file logging
const LOG_FILE = path.join(__dirname, 'whatsapp-bot.log');

const originalLog = console.log;
const originalError = console.error;

function formatLog(...args) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
}

console.log = (...args) => {
  originalLog(...args);
  fs.appendFileSync(LOG_FILE, formatLog(...args));
};

console.error = (...args) => {
  originalError(...args);
  fs.appendFileSync(LOG_FILE, formatLog('ERROR:', ...args));
};

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
  fs.writeFileSync(REPORTS_LOG, 'numero,fecha,direccion,reportType,patente,link,timestamp\n');
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

// In-memory tracker to prevent duplicate submissions within same session
// Key: address (normalized), Value: timestamp when queued/submitted
const recentlyQueuedAddresses = new Map();
const QUEUE_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Per-user processing lock to prevent concurrent batch processing
// Key: senderId, Value: Promise that resolves when processing completes
const userProcessingLocks = new Map();

// Pending messages buffer - collects messages before processing
// Key: senderId, Value: { messages: [], timer: null, senderName: string }
// messages format: { text: string|null, photo: string|null, timestamp: Date }
const pendingMessages = new Map();

// Queue for vehicle reports awaiting patente confirmation (startup only)
// Key: senderId, Value: array of vehicle report objects
const vehiclePatenteQueue = new Map();

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
    // Determine platform-specific settings
    const isMac = process.platform === 'darwin';

    // Mac-specific: use puppeteer's bundled Chromium, show browser, no single-process
    // Linux: use original settings that work
    const puppeteerConfig = isMac
      ? {
          headless: false, // Show browser on Mac for debugging
          timeout: 60000,
          executablePath: puppeteer.executablePath(), // Use puppeteer's Chromium
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage'
          ]
        }
      : {
          // Original Linux config - don't change what works
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
            '--single-process'
          ]
        };

    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: puppeteerConfig
    });

    this.chatCache = new Map();
    this.scheduledRetries = new Map(); // Map of timeoutId -> request
    this.setupEventHandlers();
  }

  // Schedule a retry with exponential backoff
  // Retry 1: 5 minutes, Retry 2: 50 minutes, Retry 3: 500 minutes
  scheduleRetry(request) {
    const retryCount = request.retryCount || 0;
    const retryDelays = [5, 50, 500]; // minutes

    if (retryCount >= 3) {
      // Max retries reached - notify user of final failure
      console.log(`[Retry] Max retries (3) reached for ${request.address}`);
      this.notifyFinalFailure(request);
      return;
    }

    const delayMinutes = retryDelays[retryCount];
    const delayMs = delayMinutes * 60 * 1000;

    console.log(`[Retry] Scheduling retry ${retryCount + 1}/3 for ${request.address} in ${delayMinutes} minutes`);

    const timeoutId = setTimeout(async () => {
      this.scheduledRetries.delete(timeoutId);
      console.log(`\n[Retry] Executing retry ${retryCount + 1}/3 for ${request.address}`);
      await this.submitRequest({ ...request, retryCount: retryCount + 1 }, true);
    }, delayMs);

    this.scheduledRetries.set(timeoutId, request);
  }

  async notifyFinalFailure(request) {
    const { address, chat, senderId } = request;
    const senderInfo = this.senderIdCache?.get(senderId);
    const mentions = senderInfo ? [senderInfo.senderId] : [senderId];
    const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : `@${senderId.split('@')[0]}`;

    try {
      await chat.sendMessage(
        `${mentionText} No pude mandar la solicitud para ${address} después de 3 intentos. Por favor, intentá de nuevo más tarde o hacelo manualmente en https://bacolaborativa.buenosaires.gob.ar`,
        { mentions }
      );
    } catch (e) {
      console.error('[Retry] Error notifying final failure:', e.message);
    }

    // Clean up photo
    if (request.photo) {
      try { fs.unlinkSync(request.photo); } catch (e) {}
    }
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
      // Skip bot's own messages
      if (msg.fromMe) return;

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
        timestamp: new Date(),
        msgId: msg.id._serialized  // Store message ID for quote replies
      };

      // Handle photo or video
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (!media) {
            console.log(`  ⚠️ Media download returned null`);
          } else if (media.mimetype.startsWith('image/')) {
            const photoPath = await this.savePhoto(media, senderId);
            messageObj.photo = photoPath;
            console.log(`  Foto guardada: ${photoPath}`);
          } else if (media.mimetype.startsWith('video/')) {
            // Extract first frame from video using ffmpeg
            console.log(`  Video detectado, extrayendo frame...`);
            const photoPath = await this.extractVideoFrame(media, senderId);
            if (photoPath) {
              messageObj.photo = photoPath;
              console.log(`  Frame extraído: ${photoPath}`);
            } else {
              console.log(`  No se pudo extraer frame del video`);
            }
          } else {
            console.log(`  ⚠️ Unsupported media type: ${media.mimetype}`);
          }
        } catch (mediaError) {
          console.log(`  ⚠️ Error downloading media: ${mediaError.message}`);
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
    // Acquire per-user processing lock to prevent concurrent batch processing
    const existingLock = userProcessingLocks.get(senderId);
    if (existingLock) {
      console.log(`  [Lock] Waiting for previous processing to complete for ${senderId.split('@')[0]}...`);
      await existingLock;
    }

    // Create a new lock for this processing session
    let releaseLock;
    const lockPromise = new Promise(resolve => { releaseLock = resolve; });
    userProcessingLocks.set(senderId, lockPromise);

    try {
      await this._processPendingMessagesImpl(senderId);
    } finally {
      // Release the lock
      userProcessingLocks.delete(senderId);
      releaseLock();
    }
  }

  async _processPendingMessagesImpl(senderId) {
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

    // Check if there's a pending info request waiting for user response
    if (this.pendingInfoRequests?.has(senderId)) {
      const pendingRequest = this.pendingInfoRequests.get(senderId);
      const lastMessage = pending.messages[pending.messages.length - 1];
      const awaitingField = pendingRequest.awaitingField;

      console.log(`\n[Pending Info] Checking response for field: ${awaitingField}`);

      // Check if this looks like a NEW, DIFFERENT report (not a response to pending question)
      // This prevents old pending requests from interfering with new reports
      const hasNewPhotos = pending.messages.some(m => m.photo);
      const messageText = lastMessage?.text?.toLowerCase() || '';

      // Detect if message contains a new address (different from pending)
      const addressPattern = /\b(\d+|\w+\.?\s+\w+)\s+\d{2,5}\b|^\s*\w+\.?\s+\w*\s+\d{2,5}/i;
      const hasNewAddress = lastMessage?.text && addressPattern.test(lastMessage.text);
      const pendingAddress = pendingRequest.address?.toLowerCase() || '';
      const isDifferentAddress = hasNewAddress && !messageText.includes(pendingAddress.toLowerCase().split(' ')[0]);

      // Detect clear new report patterns (photo + address, or different problem type)
      const newReportPatterns = /basura|residuos|contenedor|barrido|obstruc|ocupaci|mantero|puesto|vehículo|estacionad/i;
      const looksLikeNewReport = (hasNewPhotos && hasNewAddress) ||
                                  (isDifferentAddress && newReportPatterns.test(messageText));

      if (looksLikeNewReport) {
        console.log(`[Pending Info] Detected NEW report (different from pending request for ${awaitingField})`);
        console.log(`  - Pending address: ${pendingRequest.address}, new has photos: ${hasNewPhotos}, different address: ${isDifferentAddress}`);
        console.log(`  - Clearing pending request and processing as new report`);
        this.pendingInfoRequests.delete(senderId);
        // Continue to normal flow below (don't return)
      } else {
        // Handle based on what field we're waiting for
        if (awaitingField === 'photo') {
        // Looking for a photo - first check new messages
        let photoMsg = pending.messages.find(m => m.photo);

        if (!photoMsg?.photo && lastMessage?.text) {
          // User responded with text - check if they're saying they already sent it
          const alreadySentPhrases = /ya (la |lo |te |se )?(mand[eéó]|envi[eéó])|se envi[oó]|est[aá] (arriba|antes|ah[ií])|la foto.*(arriba|antes)|mand[eéó].*(antes|arriba|foto)/i;

          if (alreadySentPhrases.test(lastMessage.text)) {
            console.log(`[Pending Info] User says photo was already sent, checking history...`);

            // Look for photos in userMessageHistory
            const userHistory = userMessageHistory.get(senderId) || [];
            const historyPhoto = [...userHistory].reverse().find(m => m.photo && fs.existsSync(m.photo));

            if (historyPhoto?.photo) {
              console.log(`[Pending Info] Found photo in history: ${historyPhoto.photo}`);
              photoMsg = historyPhoto;
            }
          }
        }

        if (photoMsg?.photo) {
          console.log(`[Pending Info] Using photo: ${photoMsg.photo}`);
          pendingRequest.photo = photoMsg.photo;

          this.pendingInfoRequests.delete(senderId);
          pendingMessages.delete(senderId);

          console.log(`[Pending Info] Resubmitting with photo`);
          await this.submitRequest(pendingRequest);
          return;
        }

        // If user said they already sent it but we couldn't find it, tell them
        if (lastMessage?.text && /ya|envi|mand|arriba|antes/i.test(lastMessage.text)) {
          const chat = pendingRequest.chat;
          const senderInfo = this.senderIdCache?.get(senderId);
          const mentions = senderInfo ? [senderInfo.senderId] : [];
          const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

          console.log(`[Pending Info] Photo not found in history, asking for new one`);
          await chat.sendMessage(`${mentionText} No encontré la foto anterior (puede que ya se haya usado). ¿Podés mandarla de nuevo?`.trim(), { mentions });
          // Keep waiting for photo
          return;
        }
      } else if (awaitingField === 'photos' && pendingRequest.reportType === 'vehiculo_mal_estacionado') {
        // Looking for additional photos for vehicle report
        const newPhotos = pending.messages.filter(m => m.photo).map(m => m.photo);
        if (newPhotos.length > 0) {
          // Combine with existing photos
          const existingPhotos = pendingRequest.photos || [];
          pendingRequest.photos = [...existingPhotos, ...newPhotos];
          console.log(`[Pending Info] Vehicle report now has ${pendingRequest.photos.length} photo(s)`);

          if (pendingRequest.photos.length >= 2) {
            // We have enough photos now, check for other missing fields
            if (!pendingRequest.patente) {
              // Still need patente
              const patenteQuestion = `No puedo leer la patente en las fotos. ¿Podés decirme cuál es la patente del vehículo? (ej: ABC123 o AB123CD)`;
              const chat = pendingRequest.chat;
              const senderInfo = this.senderIdCache?.get(senderId);
              const mentions = senderInfo ? [senderInfo.senderId] : [];
              const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

              await chat.sendMessage(`${mentionText} ${patenteQuestion}`.trim(), { mentions });
              pendingRequest.awaitingField = 'patente';
              pendingRequest.awaitingQuestion = patenteQuestion;
              pendingMessages.delete(senderId);
              return;
            } else if (!pendingRequest.infractionTime) {
              // Still need time
              const timeQuestion = `¿A qué hora viste el vehículo mal estacionado en ${pendingRequest.address}? (ej: 14:30)`;
              const chat = pendingRequest.chat;
              const senderInfo = this.senderIdCache?.get(senderId);
              const mentions = senderInfo ? [senderInfo.senderId] : [];
              const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

              await chat.sendMessage(`${mentionText} ${timeQuestion}`.trim(), { mentions });
              pendingRequest.awaitingField = 'infractionTime';
              pendingRequest.awaitingQuestion = timeQuestion;
              pendingMessages.delete(senderId);
              return;
            }

            // We have all the info, submit
            this.pendingInfoRequests.delete(senderId);
            pendingMessages.delete(senderId);

            // Remove from vehiclePatenteQueue if present
            if (vehiclePatenteQueue.has(senderId)) {
              const vehicles = vehiclePatenteQueue.get(senderId);
              vehicles.shift(); // Remove the first (submitted) vehicle
              if (vehicles.length === 0) {
                vehiclePatenteQueue.delete(senderId);
              }
              console.log(`[Pending Info] Removed submitted vehicle from queue (${vehicles.length} remaining)`);
            }

            console.log(`[Pending Info] Vehicle report ready with ${pendingRequest.photos.length} photos, submitting`);
            await this.submitRequest(pendingRequest);
            return;
          } else {
            // Still need more photos
            const chat = pendingRequest.chat;
            const senderInfo = this.senderIdCache?.get(senderId);
            const mentions = senderInfo ? [senderInfo.senderId] : [];
            const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

            await chat.sendMessage(`${mentionText} Necesito una foto más para el reporte. ¿Podés mandar otra donde se vea la patente?`.trim(), { mentions });
            pendingMessages.delete(senderId);
            return;
          }
        }
        // No new photos, keep waiting
        return;
      } else if (awaitingField === 'address' && lastMessage?.text) {
        // Looking for address - extract clean address from user's response
        console.log(`[Pending Info] User provided address response: "${lastMessage.text}"`);
        const cleanAddress = await this.extractCleanAddress(lastMessage.text);
        pendingRequest.address = cleanAddress;

        this.pendingInfoRequests.delete(senderId);
        pendingMessages.delete(senderId);

        const photoCount = pendingRequest.photos?.length || (pendingRequest.photo ? 1 : 0);
        console.log(`[Pending Info] Resubmitting with cleaned address: "${cleanAddress}" (${photoCount} photo(s))`);
        await this.submitRequest(pendingRequest);
        return;
      } else if (awaitingField === 'reportType' && lastMessage?.text) {
        // Looking for report type clarification - use Claude to interpret natural language
        console.log(`[Pending Info] User provided report type: "${lastMessage.text}"`);

        const reportType = await this.extractReportType(lastMessage.text);
        pendingRequest.reportType = reportType;
        console.log(`[Pending Info] Claude mapped to reportType: ${reportType}`);

        const chat = pendingRequest.chat;
        const senderInfo = this.senderIdCache?.get(senderId);
        const mentions = senderInfo ? [senderInfo.senderId] : [];
        const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

        // If manteros, we need to ask for schedule before submitting
        if (reportType === 'manteros' && !pendingRequest.schedule) {
          const scheduleQuestion = `¿Qué días y horarios están los vendedores ambulantes en ${pendingRequest.address}?`;

          // Try to find and quote the original photo message from history
          const userHistory = userMessageHistory.get(senderId) || [];
          const photoMsgToQuote = userHistory.find(m => m.photo && m.photo === pendingRequest.photo);
          const quoteOptions = photoMsgToQuote?.msgId
            ? { mentions, quotedMessageId: photoMsgToQuote.msgId }
            : { mentions };

          console.log(`[Pending Info] Manteros confirmed, now asking for schedule...`);
          await chat.sendMessage(`${mentionText} ${scheduleQuestion}`.trim(), quoteOptions);

          // Update pending request to now await schedule
          pendingRequest.awaitingField = 'schedule';
          pendingRequest.awaitingQuestion = scheduleQuestion;
          // Keep it in pendingInfoRequests (don't delete)
          pendingMessages.delete(senderId);
          return;
        }

        this.pendingInfoRequests.delete(senderId);
        pendingMessages.delete(senderId);

        const reportLabels = {
          recoleccion: 'recolección de residuos',
          barrido: 'mejora de barrido',
          obstruccion: 'obstrucción de vereda',
          ocupacion_comercial: 'ocupación por local comercial',
          ocupacion_gastronomica: 'ocupación gastronómica',
          manteros: 'vendedores ambulantes',
          puesto_diarios: 'irregularidades en puesto de diarios',
          puesto_flores: 'irregularidades en puesto de flores',
          vehiculo_mal_estacionado: 'vehículo mal estacionado'
        };

        await chat.sendMessage(`${mentionText} Ya mando la solicitud de ${reportLabels[reportType]} en ${pendingRequest.address}...`.trim(), { mentions });
        console.log(`[Pending Info] Submitting with reportType: ${reportType}`);
        await this.submitRequest(pendingRequest);
        return;
      } else if (lastMessage?.text) {
        // Generic text response - could be schedule, situationType, patente, infractionTime, or other info
        console.log(`[Pending Info] User responded: "${lastMessage.text}"`);

        if (awaitingField === 'situationType' || pendingRequest.awaitingQuestion?.includes('Obstruye') || pendingRequest.awaitingQuestion?.includes('abandonado')) {
          // Extract situation type from user response
          const responseText = lastMessage.text.toLowerCase();
          let situationType = null;
          if (responseText.includes('obstruy') || responseText.includes('tapa') || responseText.includes('bloquea') || responseText.includes('no se puede pasar')) {
            situationType = 'obstruccion';
          } else if (responseText.includes('abandon') || responseText.includes('cerrad') || responseText.includes('vací') || responseText.includes('obsolet')) {
            situationType = 'abandono';
          } else if (responseText.includes('deterior') || responseText.includes('rot') || responseText.includes('dañ') || responseText.includes('mal estado')) {
            situationType = 'deterioro';
          } else {
            // Default to obstruccion if unclear
            situationType = 'obstruccion';
          }
          pendingRequest.situationType = situationType;
          console.log(`[Pending Info] Set situationType: "${situationType}" from "${lastMessage.text}"`);
        } else if (awaitingField === 'patente') {
          // Extract patente from user response (format: ABC123 or AB123CD, max 7 chars)
          const patenteMatch = lastMessage.text.toUpperCase().match(/[A-Z0-9]{6,7}/);
          if (patenteMatch) {
            pendingRequest.patente = patenteMatch[0];
            console.log(`[Pending Info] Set patente: "${pendingRequest.patente}" from "${lastMessage.text}"`);
          } else {
            // Use the text as-is if it looks like a patente
            pendingRequest.patente = lastMessage.text.toUpperCase().replace(/\s/g, '').substring(0, 7);
            console.log(`[Pending Info] Set patente (raw): "${pendingRequest.patente}" from "${lastMessage.text}"`);
          }
        } else if (awaitingField === 'infractionTime') {
          // Extract time from user response (format: HH:MM)
          const timeMatch = lastMessage.text.match(/(\d{1,2})[:\.]?(\d{2})?/);
          if (timeMatch) {
            const hours = timeMatch[1].padStart(2, '0');
            const minutes = timeMatch[2] ? timeMatch[2] : '00';
            pendingRequest.infractionTime = `${hours}:${minutes}`;
            console.log(`[Pending Info] Set infractionTime: "${pendingRequest.infractionTime}" from "${lastMessage.text}"`);
          } else if (lastMessage.text.toLowerCase().includes('ahora') || lastMessage.text.toLowerCase().includes('recién')) {
            // Use current time
            const now = new Date();
            pendingRequest.infractionTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            console.log(`[Pending Info] Set infractionTime (now): "${pendingRequest.infractionTime}"`);
          } else {
            // Use raw text
            pendingRequest.infractionTime = lastMessage.text;
            console.log(`[Pending Info] Set infractionTime (raw): "${pendingRequest.infractionTime}"`);
          }
        } else if (awaitingField === 'patenteConfirmation') {
          // User confirming or correcting the patente we read
          const responseText = lastMessage.text.toLowerCase().trim();
          const confirmPhrases = /^(si|sí|ok|dale|correcto|correcta|bien|esa|sep|sip|yes|y)$/i;

          if (confirmPhrases.test(responseText)) {
            // User confirmed - keep the patente as-is
            console.log(`[Pending Info] Patente confirmed: "${pendingRequest.patente}"`);
          } else {
            // User provided correction - extract new patente
            const patenteMatch = lastMessage.text.toUpperCase().match(/[A-Z0-9]{6,7}/);
            if (patenteMatch) {
              const oldPatente = pendingRequest.patente;
              pendingRequest.patente = patenteMatch[0];
              console.log(`[Pending Info] Patente corrected: "${oldPatente}" → "${pendingRequest.patente}"`);
            } else {
              // Try to use the whole response as patente
              const cleanedPatente = lastMessage.text.toUpperCase().replace(/\s/g, '').substring(0, 7);
              if (cleanedPatente.length >= 6) {
                const oldPatente = pendingRequest.patente;
                pendingRequest.patente = cleanedPatente;
                console.log(`[Pending Info] Patente corrected (raw): "${oldPatente}" → "${pendingRequest.patente}"`);
              } else {
                console.log(`[Pending Info] Could not parse patente correction, keeping original: "${pendingRequest.patente}"`);
              }
            }
          }
        } else if (awaitingField === 'schedule' || pendingRequest.awaitingQuestion?.includes('horario') || pendingRequest.awaitingQuestion?.includes('días')) {
          pendingRequest.schedule = lastMessage.text;
          console.log(`[Pending Info] Set schedule: "${lastMessage.text}"`);
        } else {
          // Default: use as schedule
          pendingRequest.schedule = lastMessage.text;
        }

        this.pendingInfoRequests.delete(senderId);
        pendingMessages.delete(senderId);

        const photoCount = pendingRequest.photos?.length || (pendingRequest.photo ? 1 : 0);
        console.log(`[Pending Info] Resubmitting with: patente="${pendingRequest.patente || 'none'}", infractionTime="${pendingRequest.infractionTime || 'none'}", reportType="${pendingRequest.reportType || 'not set'}", photos=${photoCount}`);
        await this.submitRequest(pendingRequest);

        // Check if there are more vehicles in the patente confirmation queue
        if (awaitingField === 'patenteConfirmation' && vehiclePatenteQueue.has(senderId)) {
          const vehicles = vehiclePatenteQueue.get(senderId);
          // Remove the one we just submitted (first in queue)
          vehicles.shift();

          if (vehicles.length > 0) {
            // Set up the next vehicle
            const nextVehicle = vehicles[0];
            const nextMissingField = nextVehicle.missingField || 'patenteConfirmation';
            console.log(`[Pending Info] ${vehicles.length} more vehicle(s) in queue, asking ${nextMissingField} for ${nextVehicle.patente}`);

            this.pendingInfoRequests.set(senderId, {
              ...nextVehicle,
              awaitingField: nextMissingField,
              timestamp: Date.now()
            });

            // Ask the appropriate question (quote the original photo message)
            try {
              const chat = nextVehicle.chat || pendingRequest.chat;
              const senderPhone = senderId.split('@')[0];
              const mentionText = `@${senderPhone}`;
              const queueInfo = vehicles.length > 1 ? ` (1 de ${vehicles.length} vehículos restantes)` : '';

              let question;
              if (nextMissingField === 'photos') {
                question = `Para reportar el vehículo mal estacionado en ${nextVehicle.address} necesito dos fotos: una de la infracción y otra de la patente.${queueInfo} ¿Podés mandar la otra foto?`;
              } else {
                question = `Leí la patente como ${nextVehicle.patente}. ¿Es correcta?${queueInfo} (respondé "si" o la patente correcta)`;
              }

              const messageOptions = { mentions: [senderId] };
              if (nextVehicle.photoMsgId) {
                messageOptions.quotedMessageId = nextVehicle.photoMsgId;
              }
              await chat.sendMessage(`${mentionText} ${question}`, messageOptions);
              console.log(`[Pending Info] Asked ${nextMissingField} for next vehicle: ${nextVehicle.patente}${nextVehicle.photoMsgId ? ' (quoted)' : ''}`);
            } catch (e) {
              console.log(`[Pending Info] Error sending next vehicle question: ${e.message}`);
            }
          } else {
            // No more vehicles, clear the queue
            vehiclePatenteQueue.delete(senderId);
            console.log(`[Pending Info] All vehicles processed for ${senderId.split('@')[0]}`);
          }
        }

        return;
      }

      // If we get here, user responded but not with what we needed
      // Let the normal flow continue to re-analyze
      console.log(`[Pending Info] Response didn't match expected field ${awaitingField}, continuing normal flow`);
      } // Close the else block for looksLikeNewReport check
    }

    const photoCount = pending.messages.filter(m => m.photo).length;
    console.log(`\n[Processing] ${pending.senderName}: ${pending.messages.length} mensajes, ${photoCount} fotos`);

    try {
      // Use Claude to extract requests
      const extraction = await this.extractRequests(pending, senderId);

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
        // Only respond if Claude says we should (e.g., asking for address or report type)
        if (extraction.shouldRespond && extraction.response) {
          const senderInfo = this.senderIdCache?.get(senderId);
          const mentions = senderInfo ? [senderInfo.senderId] : [];
          const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

          // Find the most relevant message to quote (prefer photo message)
          const photoMsg = pending.messages.find(m => m.photo);
          const msgToQuote = photoMsg || pending.messages[pending.messages.length - 1];
          const quoteOptions = msgToQuote?.msgId
            ? { mentions, quotedMessageId: msgToQuote.msgId }
            : { mentions };

          await chat.sendMessage(`${mentionText} ${extraction.response}`.trim(), quoteOptions);
          console.log(`  [Bot] @${pending.senderName} ${extraction.response}${msgToQuote?.msgId ? ' (quoted)' : ''}`);

          // Check if we have an address in the messages - if so, save partial request
          // so we don't re-extract old messages when user responds
          const hasPhotos = pending.messages.some(m => m.photo);
          const textWithAddress = pending.messages.find(m => m.text && /\d+/.test(m.text));

          if (hasPhotos && textWithAddress) {
            // Extract address from the message text
            const addressMatch = textWithAddress.text.match(/([A-ZÁÉÍÓÚÑa-záéíóúñ\.\s]+)\s+(\d+)/);
            if (addressMatch) {
              const partialAddress = `${addressMatch[1].trim()} ${addressMatch[2]}`;
              const photo = pending.messages.find(m => m.photo)?.photo;

              // Use Claude's awaitingField if provided, otherwise default to 'reportType'
              const awaitingField = extraction.awaitingField || 'reportType';
              // Use partialRequest from Claude if available, which includes reportType already identified
              const partialInfo = extraction.partialRequest || {};
              // Save as pending info request - include all photos for vehicle reports
              const allPhotos = pending.messages.filter(m => m.photo).map(m => m.photo);
              console.log(`  [Partial] Saving partial request: ${partialInfo.address || partialAddress} (awaiting ${awaitingField}, reportType: ${partialInfo.reportType || 'unknown'}, patente: ${partialInfo.patente || 'none'}, photos: ${allPhotos.length})`);
              if (!this.pendingInfoRequests) {
                this.pendingInfoRequests = new Map();
              }
              this.pendingInfoRequests.set(senderId, {
                senderId,
                senderName: pending.senderName,
                address: partialInfo.address || partialAddress,
                photo,
                photos: allPhotos.length > 0 ? allPhotos : null,  // Save all photos for vehicle reports
                chat,
                reportType: partialInfo.reportType || null,  // Save reportType if Claude already identified it
                patente: partialInfo.patente || null,  // Save patente if Claude extracted it
                infractionTime: partialInfo.infractionTime || null,  // Save time if Claude extracted it
                awaitingField,
                awaitingQuestion: extraction.response
              });

              // Clear pending messages since we saved the context
              pendingMessages.delete(senderId);
              return;
            }
          }

          // No partial request to save - keep messages for follow-up
          pending.timer = null;
          pending.askedQuestion = true;
          return;
        }
        console.log('  [Bot] Nada actionable, ignorando');
        pendingMessages.delete(senderId);
        return;
      }

      // We have valid requests - queue them directly (ignore shouldRespond if we have requests)
      if (extraction.requests && extraction.requests.length > 0) {
        const senderInfo = this.senderIdCache?.get(senderId);
        const mentions = senderInfo ? [senderInfo.senderId] : [];
        const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

        // Check for duplicates in last 12 hours (per address + report type)
        const processedAddresses = this.getProcessedSolicitudes();
        const newRequests = [];
        const duplicates = [];
        const invalidAddresses = [];

        // Helper to validate addresses
        const isValidAddress = (address) => {
          if (!address || typeof address !== 'string') return false;
          // Must have at least one number (street number)
          if (!/\d+/.test(address)) return false;
          // Must not be placeholder text
          const invalidPatterns = [
            /pendiente/i,
            /no proporcionada/i,
            /información/i,
            /no especificad/i,
            /sin dirección/i,
            /falta dirección/i
          ];
          if (invalidPatterns.some(p => p.test(address))) return false;
          // Must be reasonable length (at least "X 1" = 3 chars, max reasonable address)
          if (address.length < 3 || address.length > 100) return false;
          return true;
        };

        const needsSchedule = []; // Manteros requests that need schedule info
        const needsSituationType = []; // Puesto requests that need situation type
        const needsVehicleInfo = []; // Vehicle requests that need patente or infractionTime
        const photoCount = pending.messages.filter(m => m.photo).length;

        // Log what Claude returned
        console.log(`  [Claude Requests] ${extraction.requests.length} request(s) extracted:`);
        for (const r of extraction.requests) {
          const xFlag = r.postToX ? ' | POST TO X' : '';
          console.log(`    - ${r.address} | ${r.reportType} | patente: ${r.patente || 'none'} | time: ${r.infractionTime || 'none'} | msgIndex: ${r.msgIndex || 'auto'}${xFlag}`);
        }

        for (const req of extraction.requests) {
          // Validate address first
          if (!isValidAddress(req.address)) {
            console.log(`  [Invalid] Skipping invalid address: "${req.address}"`);
            invalidAddresses.push(req);
            continue;
          }

          const recentDupe = this.isRecentDuplicate(req.address, req.reportType, processedAddresses, req.patente);
          if (recentDupe) {
            duplicates.push({ address: req.address, reportType: req.reportType, solicitudNumber: recentDupe.solicitudNumber, patente: req.patente });
          } else if (req.reportType === 'manteros' && (!req.schedule || req.schedule === 'No especificado')) {
            // Manteros requests need a schedule - ask for it instead of queueing
            needsSchedule.push(req);
          } else if ((req.reportType === 'puesto_diarios' || req.reportType === 'puesto_flores') && !req.situationType) {
            // Puesto requests need a situation type - ask for it instead of queueing
            needsSituationType.push(req);
          } else if (req.reportType === 'vehiculo_mal_estacionado') {
            // Vehicle reports need: 2 photos, patente, infractionTime, AND patente confirmation
            if (photoCount < 2) {
              console.log(`  [Vehicle] Only ${photoCount} photo(s), need 2`);
              needsVehicleInfo.push({ ...req, missingField: 'photos' });
            } else if (!req.patente) {
              console.log(`  [Vehicle] Missing patente`);
              needsVehicleInfo.push({ ...req, missingField: 'patente' });
            } else if (!req.infractionTime) {
              console.log(`  [Vehicle] Missing infractionTime`);
              needsVehicleInfo.push({ ...req, missingField: 'infractionTime' });
            } else {
              // All info present - but need to confirm patente before submitting
              console.log(`  [Vehicle] Complete, needs patente confirmation: ${req.patente}`);
              needsVehicleInfo.push({ ...req, missingField: 'patenteConfirmation' });
            }
          } else {
            newRequests.push(req);
          }
        }

        // Handle manteros requests that need schedule info
        if (needsSchedule.length > 0 && newRequests.length === 0 && duplicates.length === 0) {
          const req = needsSchedule[0]; // Handle first one
          const photoMsg = pending.messages.find(m => m.photo);
          const photo = photoMsg?.photo || null;
          const scheduleQuestion = `¿Qué días y horarios están los vendedores ambulantes en ${req.address}?`;

          // Quote the photo message if available
          const msgToQuote = photoMsg || pending.messages.find(m => m.text?.toLowerCase().includes('mantero'));
          const quoteOptions = msgToQuote?.msgId
            ? { mentions, quotedMessageId: msgToQuote.msgId }
            : { mentions };

          console.log(`  [Manteros] Need schedule for ${req.address}, asking user...`);
          await chat.sendMessage(`${mentionText} ${scheduleQuestion}`.trim(), quoteOptions);

          // Save as pending info request awaiting schedule
          if (!this.pendingInfoRequests) {
            this.pendingInfoRequests = new Map();
          }
          this.pendingInfoRequests.set(senderId, {
            senderId,
            senderName: pending.senderName,
            address: req.address,
            photo,
            chat,
            reportType: 'manteros',
            awaitingField: 'schedule',
            awaitingQuestion: scheduleQuestion
          });

          pendingMessages.delete(senderId);
          return;
        }

        // Handle puesto_diarios/puesto_flores requests that need situation type
        if (needsSituationType.length > 0 && newRequests.length === 0 && duplicates.length === 0) {
          const req = needsSituationType[0]; // Handle first one
          const photoMsg = pending.messages.find(m => m.photo);
          const photo = photoMsg?.photo || null;
          const typeLabel = req.reportType === 'puesto_diarios' ? 'puesto de diarios' : 'puesto de flores';
          const situationQuestion = `¿Cuál es el problema con el ${typeLabel} en ${req.address}? ¿Obstruye la vereda, está abandonado, o está deteriorado?`;

          // Quote the photo message if available
          const msgToQuote = photoMsg || pending.messages[pending.messages.length - 1];
          const quoteOptions = msgToQuote?.msgId
            ? { mentions, quotedMessageId: msgToQuote.msgId }
            : { mentions };

          console.log(`  [Puesto] Need situationType for ${req.address}, asking user...`);
          await chat.sendMessage(`${mentionText} ${situationQuestion}`.trim(), quoteOptions);

          // Save as pending info request awaiting situationType
          if (!this.pendingInfoRequests) {
            this.pendingInfoRequests = new Map();
          }
          this.pendingInfoRequests.set(senderId, {
            senderId,
            senderName: pending.senderName,
            address: req.address,
            photo,
            chat,
            reportType: req.reportType,
            awaitingField: 'situationType',
            awaitingQuestion: situationQuestion
          });

          pendingMessages.delete(senderId);
          return;
        }

        // Handle vehiculo_mal_estacionado requests that need info
        // If there are NO other requests, handle immediately; otherwise queue for later
        if (needsVehicleInfo.length > 0) {
          // Get ALL request msgIndex values to know boundaries for photo collection
          // This includes vehicles AND other reports to avoid mixing photos
          const allRequestMsgIndexes = [
            ...needsVehicleInfo.filter(r => r.msgIndex).map(r => r.msgIndex),
            ...newRequests.filter(r => r.msgIndex).map(r => r.msgIndex)
          ].sort((a, b) => a - b);

          for (const req of needsVehicleInfo) {
            // Collect photos for THIS specific vehicle (respect boundaries)
            const startIdx = req.msgIndex ? req.msgIndex - 1 : 0;
            const nextReportIdx = allRequestMsgIndexes.find(idx => idx > (req.msgIndex || 1));
            const endIdx = nextReportIdx ? nextReportIdx - 1 : pending.messages.length;

            console.log(`  [Vehicle] Photo collection for ${req.patente}: startIdx=${startIdx}, endIdx=${endIdx}, nextReportIdx=${nextReportIdx || 'none'}`);

            const vehiclePhotos = [];
            let primaryPhotoMsgId = null;
            for (let i = startIdx; i < endIdx; i++) {
              const msg = pending.messages[i];
              console.log(`    [Vehicle] Checking msg ${i + 1}: photo=${msg?.photo ? 'yes' : 'no'}, text="${msg?.text || '(none)'}"`);
              if (msg?.photo) {
                vehiclePhotos.push(msg.photo);
                if (!primaryPhotoMsgId) primaryPhotoMsgId = msg.msgId;
              }
            }
            console.log(`  [Vehicle] Collected ${vehiclePhotos.length} photo(s) for ${req.patente}`);

            // Vehicle reports require at least 2 photos (infraction + patente)
            // If we don't have 2 photos, override missingField to ask for more
            let effectiveMissingField = req.missingField;
            if (vehiclePhotos.length < 2) {
              console.log(`  [Vehicle] ⚠️ Only ${vehiclePhotos.length} photo(s), need at least 2. Setting missingField to 'photos'`);
              effectiveMissingField = 'photos';
            }

            const vehicleReport = {
              senderId,
              senderName: pending.senderName,
              address: req.address,
              photos: vehiclePhotos,
              chat,
              reportType: 'vehiculo_mal_estacionado',
              patente: req.patente || null,
              infractionTime: req.infractionTime || null,
              missingField: effectiveMissingField,
              photoMsgId: primaryPhotoMsgId,
              postToX: req.postToX || false
            };

            // Add to vehicle patente queue
            if (!vehiclePatenteQueue.has(senderId)) {
              vehiclePatenteQueue.set(senderId, []);
            }
            vehiclePatenteQueue.get(senderId).push(vehicleReport);
            console.log(`  [Vehicle] Queued ${req.patente || 'unknown'} for ${req.missingField} (${vehiclePatenteQueue.get(senderId).length} in queue)`);
          }

          // If there are NO other requests, start asking immediately
          if (newRequests.length === 0 && duplicates.length === 0) {
            const vehicles = vehiclePatenteQueue.get(senderId);
            const firstVehicle = vehicles[0];

            let question = '';
            if (firstVehicle.missingField === 'photos') {
              question = `Para reportar un vehículo mal estacionado necesito dos fotos: una de la infracción y otra de la patente. ¿Podés mandar la otra foto?`;
            } else if (firstVehicle.missingField === 'patente') {
              question = `No puedo leer la patente en las fotos. ¿Podés decirme cuál es la patente del vehículo? (ej: ABC123 o AB123CD)`;
            } else if (firstVehicle.missingField === 'infractionTime') {
              question = `¿A qué hora viste el vehículo mal estacionado en ${firstVehicle.address}? (ej: 14:30)`;
            } else if (firstVehicle.missingField === 'patenteConfirmation') {
              const queueInfo = vehicles.length > 1 ? ` (1 de ${vehicles.length} vehículos)` : '';
              question = `Leí la patente como ${firstVehicle.patente}. ¿Es correcta?${queueInfo} (respondé "si" o la patente correcta)`;
            }

            const messageOptions = { mentions };
            if (firstVehicle.photoMsgId) {
              messageOptions.quotedMessageId = firstVehicle.photoMsgId;
            }

            console.log(`  [Vehicle] Need ${firstVehicle.missingField} for ${firstVehicle.address}, asking user...`);
            await chat.sendMessage(`${mentionText} ${question}`.trim(), messageOptions);

            // Save as pending info request
            if (!this.pendingInfoRequests) {
              this.pendingInfoRequests = new Map();
            }
            this.pendingInfoRequests.set(senderId, {
              ...firstVehicle,
              awaitingField: firstVehicle.missingField,
              awaitingQuestion: question
            });

            pendingMessages.delete(senderId);
            return;
          }
          // If there ARE other requests, continue processing them below
          // Vehicle patente confirmation will happen after other requests are queued
        }

        // Notify about duplicates
        if (duplicates.length > 0) {
          const reportLabelsForDupe = {
            recoleccion: 'recolección',
            barrido: 'barrido',
            obstruccion: 'obstrucción',
            ocupacion_comercial: 'ocupación comercial',
            ocupacion_gastronomica: 'ocupación gastronómica',
            manteros: 'manteros',
            puesto_diarios: 'puesto de diarios',
            puesto_flores: 'puesto de flores',
            vehiculo_mal_estacionado: 'vehículo mal estacionado'
          };
          for (const dupe of duplicates) {
            const dupeUrl = `https://bacolaborativa.buenosaires.gob.ar/detalleSolicitud/${dupe.solicitudNumber.replace(/\//g, '&')}?vieneDeMisSolicitudes=false`;
            const typeLabel = reportLabelsForDupe[dupe.reportType] || 'recolección';
            await chat.sendMessage(
              `${mentionText} Ya mandé una solicitud de ${typeLabel} para ${dupe.address} en las últimas 12 horas (#${dupe.solicitudNumber}).\n${dupeUrl}`.trim(),
              { mentions }
            );
            console.log(`  [Bot] Duplicado detectado: ${dupe.address} [${dupe.reportType}] (#${dupe.solicitudNumber})`);
          }
        }

        // Process new (non-duplicate) requests
        if (newRequests.length > 0) {
          // Build descriptive message for each request type
          const reportLabels = {
            recoleccion: 'recolección de residuos',
            barrido: 'mejora de barrido',
            obstruccion: 'obstrucción de vereda',
            ocupacion_comercial: 'ocupación por local comercial',
            ocupacion_gastronomica: 'ocupación gastronómica',
            manteros: 'vendedores ambulantes',
            puesto_diarios: 'irregularidades en puesto de diarios',
            puesto_flores: 'irregularidades en puesto de flores',
            vehiculo_mal_estacionado: 'vehículo mal estacionado'
          };
          const requestDescriptions = newRequests.map(r => {
            const addr = r.address;
            const label = reportLabels[r.reportType] || 'recolección de residuos';
            return `${label} en ${addr}`;
          });

          const descriptionText = requestDescriptions.length === 1
            ? requestDescriptions[0]
            : requestDescriptions.join(' y ');

          await chat.sendMessage(`${mentionText} Ya mando la solicitud de ${descriptionText}...`.trim(), { mentions });
          console.log(`  [Bot] Procesando: ${descriptionText}`);

          // Get all vehicle request msgIndex values to know boundaries (avoid mixing photos)
          const vehicleMsgIndexes = newRequests
            .filter(r => r.reportType === 'vehiculo_mal_estacionado' && r.msgIndex)
            .map(r => r.msgIndex)
            .sort((a, b) => a - b);

          let queuedCount = 0;
          for (const req of newRequests) {
            // In-memory dedup: skip if this address was queued recently
            // Use normalizeAddressForComparison for consistent key generation
            // For vehicle reports, include patente in the key (different vehicles at same address are different reports)
            let addrKey = this.normalizeAddressForComparison(req.address);
            if (req.reportType === 'vehiculo_mal_estacionado' && req.patente) {
              addrKey = `${addrKey}|${req.patente.toUpperCase()}`;
            }
            const recentlyQueued = recentlyQueuedAddresses.get(addrKey);
            if (recentlyQueued && (Date.now() - recentlyQueued) < QUEUE_DEDUP_WINDOW_MS) {
              console.log(`  [Dedup] Skipping ${req.address} (key: ${addrKey}) - queued ${Math.round((Date.now() - recentlyQueued) / 1000)}s ago`);
              continue;
            }

            let photo = null;
            let photos = null; // For vehiculo_mal_estacionado: related photos only

            // Use msgIndex if provided (1-indexed) to find the primary photo
            const primaryMsgIndex = req.msgIndex ? req.msgIndex - 1 : null;
            if (primaryMsgIndex !== null && pending.messages[primaryMsgIndex]?.photo) {
              photo = pending.messages[primaryMsgIndex].photo;
            } else {
              // Fallback: find by address match or use most recent photo
              const matchingMsg = [...pending.messages].reverse().find(m =>
                m.photo && m.text && m.text.toLowerCase().includes(req.address.toLowerCase().split(' ')[0])
              );
              photo = matchingMsg?.photo || [...pending.messages].reverse().find(m => m.photo)?.photo || null;
            }

            // For vehiculo_mal_estacionado, collect photos that belong to THIS report only
            // Stop before the next vehicle's msgIndex to avoid mixing photos
            if (req.reportType === 'vehiculo_mal_estacionado') {
              photos = [];
              const startIdx = primaryMsgIndex !== null ? primaryMsgIndex : 0;

              // Find where the NEXT vehicle starts (so we don't take its photos)
              const nextVehicleIdx = vehicleMsgIndexes.find(idx => idx > (req.msgIndex || 1));
              const endIdx = nextVehicleIdx ? nextVehicleIdx - 1 : pending.messages.length;

              for (let i = startIdx; i < endIdx; i++) {
                const msg = pending.messages[i];
                if (!msg.photo) continue;

                if (i === startIdx) {
                  // Always include the primary photo
                  photos.push(msg.photo);
                } else if (!msg.text || msg.text.trim() === '') {
                  // Include photos without text (likely continuation of same vehicle)
                  photos.push(msg.photo);
                } else {
                  // Photo has different text - might be a different report, stop collecting
                  break;
                }
              }
              console.log(`  [Vehicle] Collected ${photos.length} photo(s) for ${req.patente} at ${req.address} (msgs ${startIdx + 1}-${endIdx})`);
            }

            // Mark as queued with normalized key
            recentlyQueuedAddresses.set(addrKey, Date.now());
            console.log(`  [Dedup] Added ${req.address} (key: ${addrKey}) to dedup map`);

            // Use Claude's determination for postToX (per-request, not global)
            const shouldPostToX = req.postToX === true;
            if (shouldPostToX) {
              console.log(`  [X] Request marked for X/Twitter posting: ${req.address}`);
            }

            requestQueue.push({
              senderId,
              senderName: pending.senderName,
              address: req.address,
              reportType: req.reportType || 'recoleccion',
              containerType: req.containerType || 'negro',
              schedule: req.schedule || null, // For manteros: days/times
              situationType: req.situationType || null, // For puesto_diarios/puesto_flores: obstruccion/abandono/deterioro
              patente: req.patente || null, // For vehiculo_mal_estacionado: license plate
              infractionTime: req.infractionTime || null, // For vehiculo_mal_estacionado: time of infraction
              photo,
              photos, // For vehiculo_mal_estacionado: all photos
              chat,
              postToX: shouldPostToX
            });
            queuedCount++;
          }

          if (queuedCount > 0) {
            console.log(`  Queued ${queuedCount} request(s)`);
          } else {
            console.log(`  All requests were duplicates, nothing queued`);
          }
        }

        // Log request details
        for (const req of newRequests) {
          console.log(`    - ${req.address} (tipo: ${req.reportType}, msgIndex: ${req.msgIndex || 'auto'})`);
        }
        for (const dupe of duplicates) {
          console.log(`    - ${dupe.address} (DUPLICADO - #${dupe.solicitudNumber})`);
        }

        // After queueing other requests, start vehicle patente confirmation if any
        if (vehiclePatenteQueue.has(senderId) && vehiclePatenteQueue.get(senderId).length > 0) {
          const vehicles = vehiclePatenteQueue.get(senderId);
          const firstVehicle = vehicles[0];

          let question = '';
          if (firstVehicle.missingField === 'photos') {
            question = `Para reportar un vehículo mal estacionado necesito dos fotos: una de la infracción y otra de la patente. ¿Podés mandar la otra foto?`;
          } else if (firstVehicle.missingField === 'patente') {
            question = `No puedo leer la patente en las fotos. ¿Podés decirme cuál es la patente del vehículo? (ej: ABC123 o AB123CD)`;
          } else if (firstVehicle.missingField === 'infractionTime') {
            question = `¿A qué hora viste el vehículo mal estacionado en ${firstVehicle.address}? (ej: 14:30)`;
          } else if (firstVehicle.missingField === 'patenteConfirmation') {
            const queueInfo = vehicles.length > 1 ? ` (1 de ${vehicles.length} vehículos)` : '';
            question = `Leí la patente como ${firstVehicle.patente}. ¿Es correcta?${queueInfo} (respondé "si" o la patente correcta)`;
          }

          const messageOptions = { mentions };
          if (firstVehicle.photoMsgId) {
            messageOptions.quotedMessageId = firstVehicle.photoMsgId;
          }

          console.log(`  [Vehicle] Starting patente confirmation for ${firstVehicle.patente} at ${firstVehicle.address}`);
          await chat.sendMessage(`${mentionText} ${question}`.trim(), messageOptions);

          // Save as pending info request
          if (!this.pendingInfoRequests) {
            this.pendingInfoRequests = new Map();
          }
          this.pendingInfoRequests.set(senderId, {
            ...firstVehicle,
            awaitingField: firstVehicle.missingField,
            awaitingQuestion: question
          });
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

  async extractRequests(pending, senderId, includeBotContext = false) {
      // Always include recent context so Claude understands the full picture
      // This ensures different issues from the same user are properly distinguished

      const hasPendingInfoRequest = this.pendingInfoRequests?.has(senderId);
      const askedQuestionRecently = pending.askedQuestion === true;
      const userHistory = senderId ? (userMessageHistory.get(senderId) || []) : [];

      // Always provide context from last 10 messages, but mark which are NEW vs HISTORY
      const historyMessages = userHistory.slice(-10);
      const newMessageIds = new Set(pending.messages.map(m => m.timestamp?.getTime()));

      // Build context summary of recent history (excluding current batch)
      const historyContext = historyMessages
        .filter(m => !newMessageIds.has(m.timestamp?.getTime()))
        .map(m => {
          let desc = m.text || '';
          if (m.photo) {
            if (m.photoDescription) {
              desc += desc ? ` [FOTO: ${m.photoDescription}]` : `[FOTO: ${m.photoDescription}]`;
            } else {
              desc += desc ? ' [FOTO]' : '[FOTO]';
            }
          }
          return desc;
        })
        .filter(d => d.length > 0);

      // Messages to actually process (with images) - use history if needed, otherwise just new
      let messagesToProcess;
      if (hasPendingInfoRequest || askedQuestionRecently) {
        // Use recent history for full context when waiting for info
        messagesToProcess = historyMessages.slice(-5);
        const reason = hasPendingInfoRequest ? 'pending info request' : 'asked question recently';
        console.log(`  [Context] Using history (${reason}) - ${messagesToProcess.length} messages`);

        if (askedQuestionRecently) {
          pending.askedQuestion = false;
        }
      } else {
        // Normal mode: process NEW messages, but Claude sees history context
        messagesToProcess = pending.messages;
        console.log(`  [Context] Processing ${messagesToProcess.length} NEW message(s) from ${senderId?.split('@')[0] || 'unknown'}`);
        if (historyContext.length > 0) {
          console.log(`  [Context] Including ${historyContext.length} recent history messages as context`);
        }
      }

      // Build bot context if provided (for startup recovery)
      let botContextText = '';
      if (includeBotContext && pending.botContext && pending.botContext.length > 0) {
        botContextText = '\nMENSAJES ANTERIORES DEL BOT (ya preguntaste esto, NO repitas):\n' +
          pending.botContext.map(b => `- Bot: ${b.text}`).join('\n') + '\n';
        console.log(`  [Context] Including ${pending.botContext.length} bot message(s) as context`);
      }

      // Build message list with text and photo indicators
      const messagesWithPhotos = messagesToProcess.map((m, i) => {
        let desc = '';
        if (m.text) desc += m.text;
        if (m.photo) desc += desc ? ' [+FOTO]' : '[FOTO sin texto]';
        return `Msg${i + 1}: ${desc}`;
      }).join('\n');

      const photos = messagesToProcess.filter(m => m.photo).map(m => m.photo);
      const hasPhotos = photos.length > 0;

      // Build history context string if we have previous messages
      let historyText = '';
      if (historyContext.length > 0) {
        historyText = `\nMENSAJES RECIENTES (ya procesados, solo para contexto):\n${historyContext.map((h, i) => `- ${h}`).join('\n')}\n`;
      }

      const prompt = `${botContextText}${historyText}MENSAJES NUEVOS DE ${pending.senderName}:
${messagesWithPhotos}

${hasPhotos ? `[Envió ${photos.length} foto(s) NUEVA(s) - analizalas. Cada foto corresponde al mensaje marcado con [+FOTO]]` : '[No envió fotos nuevas]'}

¿Hay algo actionable en los mensajes NUEVOS? Recordá que DEBE verse un contenedor de CABA en la foto para ser válido.${botContextText ? '\n\nIMPORTANTE: Si ya preguntaste algo arriba, NO vuelvas a preguntar lo mismo.' : ''}`;

      // Build message content with images if available
      const content = [];

      // Add photos with labels for vision analysis
      if (hasPhotos) {
        for (let i = 0; i < messagesToProcess.length; i++) {
          const m = messagesToProcess[i];
          if (m.photo) {
            // Check if photo file exists (it may have been deleted after previous submission)
            if (!fs.existsSync(m.photo)) {
              console.log(`  [Photo] File no longer exists (already submitted?): ${path.basename(m.photo)}`);
              m.photo = null; // Clear the reference
              continue;
            }

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
              m.photo = null; // Clear the reference on error
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
          // Use Sonnet 4 for better image analysis (3x cost of Haiku but much better vision)
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000, // Increased to prevent truncation
            system: getSystemPrompt(),
            messages: [{ role: 'user', content }]
          });

          const responseText = response.content[0].text;
          console.log('  [Claude raw]', responseText.substring(0, 200));

          // Parse JSON response - extract first complete JSON object
          // Find the opening brace and then find the matching closing brace
          const startIdx = responseText.indexOf('{');
          if (startIdx !== -1) {
            let braceCount = 0;
            let endIdx = -1;
            for (let i = startIdx; i < responseText.length; i++) {
              if (responseText[i] === '{') braceCount++;
              if (responseText[i] === '}') braceCount--;
              if (braceCount === 0) {
                endIdx = i;
                break;
              }
            }
            if (endIdx !== -1) {
              const jsonStr = responseText.substring(startIdx, endIdx + 1);
              try {
                const result = JSON.parse(jsonStr);

                // FALLBACK: If Claude returned empty requests but marked photo as invalid,
                // and the text clearly mentions trash + has an address, create a default request
                if (result.requests?.length === 0 && result.photoValid === false) {
                  const fullText = pending.messages.map(m => m.text || '').join(' ').toLowerCase();
                  const hasTrashKeywords = /basura|residuos|mugre|suciedad|contenedor|barrido/.test(fullText);
                  const addressMatch = fullText.match(/([a-záéíóúñ]+\s+\d+)/i);

                  if (hasTrashKeywords && addressMatch) {
                    console.log('  [Claude] FALLBACK: Photo marked invalid but text has trash keywords + address');
                    console.log(`  [Claude] Creating default "barrido" request for: ${addressMatch[1]}`);
                    result.requests = [{
                      address: addressMatch[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
                      reportType: 'barrido', // Default to barrido when photo unclear
                      containerType: 'negro',
                      msgIndex: 1
                    }];
                    result.photoValid = true; // Override
                  }
                }

                // Store image analysis descriptions in message history for future context
                // This helps Claude understand what previous images contained
                if (result.requests?.length > 0 || result.photoValid !== undefined) {
                  const reportTypeLabels = {
                    recoleccion: 'basura/residuos cerca de contenedor',
                    barrido: 'calle sucia, necesita barrido',
                    obstruccion: 'obstrucción en vereda',
                    ocupacion_comercial: 'ocupación por comercio',
                    ocupacion_gastronomica: 'ocupación gastronómica',
                    manteros: 'vendedores ambulantes/manteros',
                    puesto_diarios: 'puesto de diarios con irregularidades',
                    puesto_flores: 'puesto de flores con irregularidades',
                    vehiculo_mal_estacionado: 'vehículo mal estacionado'
                  };

                  for (const m of messagesToProcess) {
                    if (m.photo && !m.photoDescription) {
                      // Find the request that matches this message
                      const matchingReq = result.requests?.find(r => r.msgIndex && messagesToProcess[r.msgIndex - 1] === m);
                      if (matchingReq) {
                        m.photoDescription = `${reportTypeLabels[matchingReq.reportType] || matchingReq.reportType} en ${matchingReq.address}`;
                        console.log(`  [PhotoDesc] ${path.basename(m.photo)} → "${m.photoDescription}"`);
                      } else if (result.photoValid === false) {
                        m.photoDescription = 'foto no válida para reporte';
                        console.log(`  [PhotoDesc] ${path.basename(m.photo)} → "foto no válida"`);
                      } else if (result.response) {
                        // Claude asked a question, mark as pending analysis
                        m.photoDescription = 'pendiente de más info';
                        console.log(`  [PhotoDesc] ${path.basename(m.photo)} → "pendiente de más info"`);
                      }
                    }
                  }
                }

                return result;
              } catch (parseErr) {
                console.error('  [Claude] JSON parse error:', parseErr.message);
                console.error('  [Claude] Attempted to parse:', jsonStr.substring(0, 200));
              }
            }
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

  // Helper to check if messages contain a request to post to X/Twitter
  shouldPostToX(messages) {
    const xPatterns = [
      /subi(r|lo)?\s*(a\s*)?(x|twitter)/i,  // "subi a twitter", "subir a X", "subilo a twitter"
      /postea(r|lo)?\s*(a\s*)?(x|twitter)/i,
      /publica(r|lo)?\s*(en\s*)?(x|twitter)/i,
      /twittea(r|lo)?/i,
      /manda(r|lo)?\s*(a\s*)?(x|twitter)/i,
      /\bx\b.*\btwitter\b|\btwitter\b.*\bx\b/i,  // mentions both X and Twitter
    ];

    for (const msg of messages) {
      if (msg.text) {
        for (const pattern of xPatterns) {
          if (pattern.test(msg.text)) {
            console.log(`  [X] Detected post request in: "${msg.text}"`);
            return true;
          }
        }
      }
    }
    return false;
  }

  // Helper to extract report type from user's natural language response using Claude
  async extractReportType(rawText) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 50,
        system: `Clasificá la respuesta del usuario en UNO de estos tipos de reporte:
- recoleccion: basura, residuos, contenedor desbordando, bolsas en la vereda
- barrido: calle sucia, mugre, tierra, hojas, necesita barrer
- obstruccion: algo bloqueando la vereda o calle, caños, fierros
- ocupacion_comercial: local/negocio/kiosco/comercio poniendo cosas en la vereda, ocupación indebida
- ocupacion_gastronomica: restaurant/bar/café con mesas en la vereda
- manteros: vendedores ambulantes, manteros, venta ilegal en la calle
- puesto_diarios: kiosco de diarios, puesto de periódicos, diarios
- puesto_flores: puesto de flores, florería, plantas
- vehiculo_mal_estacionado: auto mal estacionado, vehículo en la vereda, estacionamiento indebido, doble fila, auto en rampa

IMPORTANTE: Si el usuario dice "NO es X" o "no manteros", entonces NO es ese tipo.
Si dice "local" u "ocupación indebida" → ocupacion_comercial

Respondé SOLO con una de estas palabras: recoleccion, barrido, obstruccion, ocupacion_comercial, ocupacion_gastronomica, manteros, puesto_diarios, puesto_flores, vehiculo_mal_estacionado`,
        messages: [{ role: 'user', content: rawText }]
      });

      const result = response.content[0].text.trim().toLowerCase();
      const validTypes = ['recoleccion', 'barrido', 'obstruccion', 'ocupacion_comercial', 'ocupacion_gastronomica', 'manteros', 'puesto_diarios', 'puesto_flores', 'vehiculo_mal_estacionado'];

      if (validTypes.includes(result)) {
        console.log(`  [ReportType] Extracted: "${rawText}" → "${result}"`);
        return result;
      }

      // If Claude returned something unexpected, default to recoleccion
      console.log(`  [ReportType] Unexpected response "${result}", defaulting to recoleccion`);
      return 'recoleccion';
    } catch (e) {
      console.error('  [ReportType] Error extracting type:', e.message);
      return 'recoleccion'; // Safe default
    }
  }

  // Helper to extract clean address from user's text response using Claude
  async extractCleanAddress(rawText) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 100,
        system: `Extraé SOLO la dirección (calle + número) del texto del usuario.
Eliminá texto conversacional como "es", "no", "al", "quise decir", "perdón", etc.
Aplicá estos alias:
- "Irigoyen" / "Hipolito Irigoyen" → "Hipólito Yrigoyen"
- "Corrientes" → "Av. Corrientes"
- "Callao" → "Av. Callao"
Respondé SOLO con la dirección limpia, nada más.`,
        messages: [{ role: 'user', content: rawText }]
      });

      const cleanAddress = response.content[0].text.trim();
      console.log(`  [Address] Extracted: "${rawText}" → "${cleanAddress}"`);
      return cleanAddress;
    } catch (e) {
      console.error('  [Address] Error extracting address:', e.message);
      // Fallback: try simple regex extraction
      const match = rawText.match(/([A-ZÁÉÍÓÚÑa-záéíóúñ\s\.]+)\s+(\d+)/);
      if (match) {
        return `${match[1].trim()} ${match[2]}`;
      }
      return rawText; // Last resort: use raw text
    }
  }

  // Helper to remove address from dedup map (allows manual retry after failure)
  clearFromDedup(address) {
    const addrKey = address.toLowerCase();
    if (recentlyQueuedAddresses.has(addrKey)) {
      recentlyQueuedAddresses.delete(addrKey);
      console.log(`  [Dedup] Cleared ${address} from dedup map (allowing retry)`);
    }
  }

  async submitRequest(request, isRetry = false) {
    const { senderId, senderName, address, reportType = 'recoleccion', containerType, schedule, situationType, patente, infractionTime, photo, photos: multiplePhotos, chat, postToX: shouldPostToX } = request;
    const senderInfo = this.senderIdCache?.get(senderId);
    const mentions = senderInfo ? [senderInfo.senderId] : [senderId];
    const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : `@${senderId.split('@')[0]}`;

    const REPORT_TYPE_LABELS = {
      recoleccion: 'Recolección de residuos',
      barrido: 'Mejora de barrido',
      obstruccion: 'Obstrucción de calle/vereda',
      ocupacion_comercial: 'Ocupación por local comercial',
      ocupacion_gastronomica: 'Ocupación por área gastronómica',
      manteros: 'Manteros/vendedores ambulantes',
      puesto_diarios: 'Irregularidades en puesto de diarios',
      puesto_flores: 'Irregularidades en puesto de flores',
      vehiculo_mal_estacionado: 'Vehículo mal estacionado'
    };
    const reportTypeName = REPORT_TYPE_LABELS[reportType] || 'Recolección de residuos';

    console.log('\n========================================');
    console.log(`  ${isRetry ? 'REINTENTANDO' : 'ENVIANDO'} SOLICITUD`);
    console.log(`  Vecino: ${senderName}`);
    console.log(`  Dirección: ${address}`);
    console.log(`  Tipo de reporte: ${reportTypeName}`);
    console.log(`  Foto: ${photo ? 'Sí' : 'No'}`);
    if (reportType === 'recoleccion') {
      console.log(`  Contenedor: ${containerType}`);
    }
    if (reportType === 'manteros' && schedule) {
      console.log(`  Horario: ${schedule}`);
    }
    if ((reportType === 'puesto_diarios' || reportType === 'puesto_flores') && request.situationType) {
      console.log(`  Situación: ${request.situationType}`);
    }
    if (reportType === 'vehiculo_mal_estacionado') {
      if (request.patente) console.log(`  Patente: ${request.patente}`);
      if (request.infractionTime) console.log(`  Hora infracción: ${request.infractionTime}`);
      if (multiplePhotos && multiplePhotos.length > 0) {
        console.log(`  Fotos: ${multiplePhotos.length} (${multiplePhotos.map(p => p.split('/').pop()).join(', ')})`);
      } else if (photo) {
        console.log(`  Fotos: 1 (${photo.split('/').pop()})`);
      }
    }
    console.log('========================================\n');

    try {
      // For vehiculo_mal_estacionado, require at least 2 photos
      const photosToSend = multiplePhotos && multiplePhotos.length > 0 ? multiplePhotos : (photo ? [photo] : []);

      if (reportType === 'vehiculo_mal_estacionado' && photosToSend.length < 2) {
        console.log(`  [API] ⚠️ Vehicle report requires 2 photos, only have ${photosToSend.length}. Asking for more.`);

        // Notify user and set up pending request for more photos
        const question = `Para reportar un vehículo mal estacionado necesito dos fotos: una de la infracción y otra de la patente. ¿Podés mandar la otra foto?`;
        await chat.sendMessage(`${mentionText} ${question}`, { mentions });

        if (!this.pendingInfoRequests) {
          this.pendingInfoRequests = new Map();
        }
        this.pendingInfoRequests.set(senderId, {
          senderId,
          senderName,
          address,
          photos: photosToSend,
          chat,
          reportType: 'vehiculo_mal_estacionado',
          patente: patente || null,
          infractionTime: infractionTime || null,
          awaitingField: 'photo',
          postToX: shouldPostToX
        });
        return;
      }

      console.log(`  [API] Sending ${photosToSend.length} photo(s) to API`);
      const response = await fetch(`${API_URL}/solicitud`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          reportType,
          containerType,
          schedule, // For manteros: days/times when vendors are present
          situationType, // For puesto_diarios/puesto_flores: obstruccion/abandono/deterioro
          patente, // For vehiculo_mal_estacionado: license plate
          infractionTime, // For vehiculo_mal_estacionado: time of infraction (HH:MM)
          photos: photosToSend
        })
      });

      const result = await response.json();

      if (result.success && result.solicitudNumber) {
        // Format solicitud number for URL (replace / with &)
        const solicitudUrl = `https://bacolaborativa.buenosaires.gob.ar/detalleSolicitud/${result.solicitudNumber.replace(/\//g, '&')}?vieneDeMisSolicitudes=false`;

        // Log to CSV file (with reportType for per-type deduplication, and patente for vehicles)
        const today = new Date();
        const dateStr = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;
        const timestamp = Date.now();
        // Include patente for vehicle reports (allows multiple vehicles at same address)
        const patenteField = reportType === 'vehiculo_mal_estacionado' && patente ? patente.toUpperCase() : '';
        const csvLine = `${result.solicitudNumber},${dateStr},"${address}",${reportType},${patenteField},${solicitudUrl},${timestamp}\n`;
        fs.appendFileSync(REPORTS_LOG, csvLine);
        console.log(`  [Log] Guardado en reports.csv (${reportType})`);

        const successMsg = `${mentionText} Listo, mandé la solicitud de ${reportTypeName.toLowerCase()} para ${address}. #${result.solicitudNumber}\n${solicitudUrl}`;
        await chat.sendMessage(successMsg, { mentions });
        console.log(`  [Bot] Solicitud enviada: #${result.solicitudNumber} (${reportTypeName})`);

        // Post to X/Twitter only if user requested it (before cleaning up photo)
        if (shouldPostToX) {
          try {
            const xResult = await postToX({
              address,
              reportType,
              solicitudNumber: result.solicitudNumber,
              photoPath: photo
            });
            if (xResult.skipped) {
              console.log(`  [X] Omitido (duplicado): ${result.solicitudNumber}`);
            } else if (xResult.success) {
              console.log(`  [X] Publicado en X/Twitter`);
            } else {
              console.log(`  [X] Error publicando en X: ${xResult.error}`);
            }
          } catch (xError) {
            console.error(`  [X] Error publicando en X:`, xError.message);
          }
        }

        // Clean up photos after successful submission and X posting
        // For vehicle reports, clean up all photos in the array
        if (multiplePhotos && multiplePhotos.length > 0) {
          for (const p of multiplePhotos) {
            try { fs.unlinkSync(p); } catch (e) {}
          }
        } else if (photo) {
          try { fs.unlinkSync(photo); } catch (e) {}
        }
      } else if (result.success) {
        const successMsg = `${mentionText} Listo, mandé la solicitud de ${reportTypeName.toLowerCase()} para ${address}.`;
        await chat.sendMessage(successMsg, { mentions });
        console.log(`  [Bot] Solicitud enviada (sin número) (${reportTypeName})`);

        // Post to X/Twitter only if user requested it (even without solicitud number)
        if (shouldPostToX) {
          try {
            const xResult = await postToX({
              address,
              reportType,
              solicitudNumber: 'sin número',
              photoPath: photo
            });
            if (xResult.skipped) {
              console.log(`  [X] Omitido (duplicado)`);
            } else if (xResult.success) {
              console.log(`  [X] Publicado en X/Twitter`);
            } else {
              console.log(`  [X] Error publicando en X: ${xResult.error}`);
            }
          } catch (xError) {
            console.error(`  [X] Error publicando en X:`, xError.message);
          }
        }

        // Clean up photo after successful submission and X posting
        if (photo) {
          try { fs.unlinkSync(photo); } catch (e) {}
        }
      } else if (result.needsInfo) {
        // Form needs more information from user - ask them
        console.log(`  [Bot] Form needs info: ${result.question}`);
        await chat.sendMessage(`${mentionText} ${result.question}`, { mentions });

        // Store pending request so we can continue when user responds
        if (!this.pendingInfoRequests) {
          this.pendingInfoRequests = new Map();
        }
        this.pendingInfoRequests.set(senderId, {
          ...request,
          awaitingField: result.field,
          awaitingQuestion: result.question
        });

        // Don't clean up photo - we'll need it when we retry
        return;
      } else {
        // Check if it's an access/login error
        const isAccessError = result.error && (
          result.error.includes('password') ||
          result.error.includes('login') ||
          result.error.includes('selector') ||
          result.error.includes('timeout') ||
          result.error.includes('exceeded')
        );

        if (isAccessError) {
          const retryCount = request.retryCount || 0;
          const retryDelays = [5, 50, 500];
          const nextRetryMinutes = retryDelays[retryCount];

          // Clear from dedup so user can manually retry if they want
          this.clearFromDedup(address);

          if (retryCount < 3) {
            // Schedule retry and notify user
            this.scheduleRetry(request);
            console.log(`  [Bot] Error de acceso, reintento ${retryCount + 1}/3 programado en ${nextRetryMinutes} min`);
            await chat.sendMessage(
              `${mentionText} Hay problemas para acceder a Gestión Colaborativa. Voy a reintentar ${address} en ${nextRetryMinutes} minutos (intento ${retryCount + 1}/3).`,
              { mentions }
            );
          } else {
            // Max retries - handled by scheduleRetry -> notifyFinalFailure
            this.scheduleRetry(request);
          }
        } else {
          // Be agentic - analyze the error and ask for what we need
          const error = result.error || '';
          console.log(`  [Bot] Analyzing error: ${error}`);

          // Try to understand what's missing and ask for it
          let canRecover = false;
          let questionToAsk = null;
          let fieldNeeded = null;

          // Check for specific missing info patterns - BE AGENTIC
          if (error.toLowerCase().includes('foto') || error.toLowerCase().includes('imagen') || error.toLowerCase().includes('photo')) {
            questionToAsk = '¿Podés mandarme una foto del problema?';
            fieldNeeded = 'photo';
            canRecover = true;
          } else if (error.toLowerCase().includes('horario') || error.toLowerCase().includes('días') || error.toLowerCase().includes('schedule') || error.toLowerCase().includes('cuándo')) {
            questionToAsk = '¿Qué días y horarios ocurre el problema?';
            fieldNeeded = 'schedule';
            canRecover = true;
          } else if (error.toLowerCase().includes('dirección') || error.toLowerCase().includes('address') || error.toLowerCase().includes('ubicación')) {
            questionToAsk = '¿Cuál es la dirección exacta?';
            fieldNeeded = 'address';
            canRecover = true;
          } else if (error.toLowerCase().includes('textarea vacío') || error.toLowerCase().includes('campo requerido')) {
            // Form has empty required field - figure out what it is
            if (error.toLowerCase().includes('horario') || error.toLowerCase().includes('días')) {
              questionToAsk = '¿Qué días y horarios ocurre el problema?';
              fieldNeeded = 'schedule';
            } else {
              questionToAsk = '¿Podés darme más detalles sobre el problema?';
              fieldNeeded = 'description';
            }
            canRecover = true;
          } else if (error.toLowerCase().includes('radio sin seleccionar') || error.toLowerCase().includes('opciones')) {
            // This is usually internal form issue - auto retry
            this.clearFromDedup(address); // Allow manual retry
            this.scheduleRetry(request);
            await chat.sendMessage(
              `${mentionText} Hubo un problema con el formulario. Voy a reintentar automáticamente.`,
              { mentions }
            );
            return;
          } else if (error.toLowerCase().includes('confirmar') || error.toLowerCase().includes('button') || error.toLowerCase().includes('atascado') || error.toLowerCase().includes('clickable') || error.toLowerCase().includes('element')) {
            // Form navigation error - can retry
            questionToAsk = null;
            canRecover = false;
            // Clear dedup and schedule retry
            this.clearFromDedup(address); // Allow manual retry
            this.scheduleRetry(request);
            await chat.sendMessage(
              `${mentionText} Hubo un problema técnico con el formulario. Voy a reintentar automáticamente.`,
              { mentions }
            );
            return;
          }

          if (canRecover && questionToAsk) {
            // Ask the user for the missing info
            console.log(`  [Bot] Asking user for: ${fieldNeeded}`);
            await chat.sendMessage(`${mentionText} ${questionToAsk}`, { mentions });

            // Store pending request to continue when user responds
            if (!this.pendingInfoRequests) {
              this.pendingInfoRequests = new Map();
            }
            this.pendingInfoRequests.set(senderId, {
              ...request,
              awaitingField: fieldNeeded,
              awaitingQuestion: questionToAsk,
              originalError: error
            });
            // Don't clean up photo - might need it
            return;
          }

          // Generic error we can't recover from
          await chat.sendMessage(`${mentionText} No pude completar la solicitud: ${error || 'error desconocido'}. ¿Podés darme más detalles?`, { mentions });
          console.log(`  [Bot] Error: ${error}`);

          // Clean up photo on non-retryable error
          if (photo) {
            try { fs.unlinkSync(photo); } catch (e) {}
          }
        }
      }

    } catch (error) {
      console.error('Error submitting solicitud:', error);

      // Clear from dedup so user can manually retry if they want
      this.clearFromDedup(address);

      // Network or other errors - schedule retry
      const retryCount = request.retryCount || 0;
      const retryDelays = [5, 50, 500];
      const nextRetryMinutes = retryDelays[retryCount];

      if (retryCount < 3) {
        this.scheduleRetry(request);
        console.log(`  [Bot] Error de conexión, reintento ${retryCount + 1}/3 programado en ${nextRetryMinutes} min`);
        await chat.sendMessage(
          `${mentionText} Hay problemas para acceder a Gestión Colaborativa. Voy a reintentar ${address} en ${nextRetryMinutes} minutos (intento ${retryCount + 1}/3).`,
          { mentions }
        );
      } else {
        // Max retries reached
        this.scheduleRetry(request);
      }
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

  // Load already processed solicitudes from CSV with timestamps
  // Returns Map with key "normalized_address|reportType" -> { timestamp, solicitudNumber }
  getProcessedSolicitudes() {
    const processed = new Map();
    if (fs.existsSync(REPORTS_LOG)) {
      const content = fs.readFileSync(REPORTS_LOG, 'utf-8');
      const lines = content.split('\n').slice(1); // Skip header
      for (const line of lines) {
        if (line.trim()) {
          // Extract address from CSV line (handles multiple formats)
          // Old format: numero,fecha,"direccion",link,timestamp
          // Previous format: numero,fecha,"direccion",reportType,link,timestamp
          // Current format: numero,fecha,"direccion",reportType,patente,link,timestamp
          const addressMatch = line.match(/"([^"]+)"/);
          const parts = line.split(',');
          const timestamp = parseInt(parts[parts.length - 1]) || 0;
          const solicitudNumber = parts[0];

          if (addressMatch) {
            const address = this.normalizeAddressForComparison(addressMatch[1]);

            // Detect format: if part after address is a known reportType, use new format
            // Find index of closing quote, then check next part
            const quoteEnd = line.indexOf('"', line.indexOf('"') + 1);
            const afterQuote = line.substring(quoteEnd + 2).split(',');
            const knownTypes = ['recoleccion', 'barrido', 'obstruccion', 'ocupacion_comercial', 'ocupacion_gastronomica', 'manteros', 'puesto_diarios', 'puesto_flores', 'vehiculo_mal_estacionado'];
            const reportType = knownTypes.includes(afterQuote[0]) ? afterQuote[0] : 'recoleccion';

            // For vehicle reports, check if there's a patente field (5th field after address)
            // Format: reportType,patente,link,timestamp - so patente is afterQuote[1] if it's not a URL
            let patente = null;
            if (reportType === 'vehiculo_mal_estacionado' && afterQuote[1] && !afterQuote[1].startsWith('http')) {
              patente = afterQuote[1].toUpperCase();
            }

            // Key: normalized_address|reportType or normalized_address|reportType|PATENTE for vehicles
            let key = `${address}|${reportType}`;
            if (patente) {
              key = `${key}|${patente}`;
            }

            // Keep the most recent entry for each address+reportType+patente combo
            if (!processed.has(key) || processed.get(key).timestamp < timestamp) {
              processed.set(key, { timestamp, solicitudNumber });
            }
          }
        }
      }
    }
    return processed;
  }

  // Normalize address for duplicate comparison
  // Strips conversational prefixes, normalizes accents, extracts just "street + number"
  normalizeAddressForComparison(address) {
    if (!address) return '';

    let normalized = address.toLowerCase()
      // Remove accents for comparison
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      // Remove common conversational prefixes/suffixes
      .replace(/^(es |es en |esta en |al |no |no es |quise decir |perdon |por favor |dale )/gi, '')
      .replace(/(, ?no .*$| no .*$)/gi, '') // Remove ", no Irigoyen" etc.
      // Normalize "al" before numbers: "yrigoyen al 3150" -> "yrigoyen 3150"
      .replace(/\s+al\s+(\d)/gi, ' $1')
      .trim();

    // Extract just street name + number pattern
    const match = normalized.match(/([a-z\s\.]+)\s*(\d+)/i);
    if (match) {
      return `${match[1].trim()} ${match[2]}`;
    }

    return normalized;
  }

  // Check if address+reportType (and patente for vehicles) was submitted in last 12 hours
  isRecentDuplicate(address, reportType, processedMap, patente = null) {
    const normalizedNew = this.normalizeAddressForComparison(address);
    const type = reportType || 'recoleccion';

    // Check against all processed addresses (normalized) with matching reportType
    for (const [storedKey, entry] of processedMap) {
      // Key format: "normalized_address|reportType" or "normalized_address|reportType|PATENTE" for vehicles
      const parts = storedKey.split('|');
      const storedAddr = parts[0];
      const storedType = parts[1];
      const storedPatente = parts[2] || null;

      if (normalizedNew === storedAddr && type === storedType) {
        // For vehicle reports, also check patente - different patentes are different reports
        if (type === 'vehiculo_mal_estacionado' && patente && storedPatente) {
          if (patente.toUpperCase() !== storedPatente.toUpperCase()) {
            continue; // Different vehicle, not a duplicate
          }
        }
        const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
        if (entry.timestamp > twelveHoursAgo) {
          return entry;
        }
      }
    }

    return null;
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

      // Build conversation timeline including bot's own messages
      // This allows Claude to see the full context of what was already said
      const conversationTimeline = [];

      for (const msg of messages) {
        // Skip old messages (older than 2 hours)
        const msgAge = Date.now() - msg.timestamp * 1000;
        if (msgAge > MESSAGE_RETENTION_MS) continue;

        const msgTime = msg.timestamp * 1000;
        const senderId = msg.fromMe ? 'BOT' : (msg.author || msg.from);

        const messageObj = {
          text: msg.body || null,
          photo: null,
          timestamp: new Date(msgTime),
          isBot: msg.fromMe,
          senderId,
          msgId: msg.id?._serialized || null  // Store for quote replies
        };

        // Download photo if present (only for user messages)
        if (!msg.fromMe && msg.hasMedia) {
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

        conversationTimeline.push(messageObj);
      }

      // Sort by timestamp
      conversationTimeline.sort((a, b) => a.timestamp - b.timestamp);

      // Group user messages, but include bot messages in context
      const messagesBySender = new Map();
      const botMessages = conversationTimeline.filter(m => m.isBot);

      for (const msg of conversationTimeline) {
        if (msg.isBot) continue;

        const senderId = msg.senderId;
        if (!messagesBySender.has(senderId)) {
          messagesBySender.set(senderId, { messages: [], botContext: [] });
        }

        const userData = messagesBySender.get(senderId);
        userData.messages.push(msg);

        // Add any bot messages that came before this user message as context
        const relevantBotMsgs = botMessages.filter(b =>
          b.timestamp < msg.timestamp &&
          b.timestamp > new Date(msg.timestamp.getTime() - 10 * 60 * 1000) // Within 10 min before
        );
        for (const botMsg of relevantBotMsgs) {
          if (!userData.botContext.find(b => b.text === botMsg.text)) {
            userData.botContext.push(botMsg);
          }
        }
      }

      console.log(`[Startup] ${messagesBySender.size} usuarios con mensajes recientes`);

      // Process each user's messages to find unprocessed requests
      for (const [senderId, userData] of messagesBySender) {
        if (userData.messages.length === 0) continue;

        const senderName = 'Vecino'; // Will be resolved later

        // Check if bot's last message to this user was a question waiting for response
        const lastBotMsg = userData.botContext[userData.botContext.length - 1];
        const lastUserMsg = userData.messages[userData.messages.length - 1];

        if (lastBotMsg && lastUserMsg && lastBotMsg.timestamp > lastUserMsg.timestamp) {
          // Bot asked after user's last message - we're waiting for response, skip
          console.log(`[Startup] Skipping ${senderId.split('@')[0]} - already asked: "${lastBotMsg.text?.substring(0, 40)}..."`);
          continue;
        }

        const pending = {
          messages: userData.messages,
          botContext: userData.botContext, // Include bot's previous messages
          senderName,
          chatId: targetChat.id._serialized
        };

        // Cache the chat
        this.chatCache.set(senderId, targetChat);

        // Use Claude to check for actionable requests
        const extraction = await this.extractRequests(pending, senderId, true); // true = include bot context

        // Send response message if Claude wants to ask something
        if (extraction.shouldRespond && extraction.response) {
          try {
            // Get sender info for mention
            const senderPhone = senderId.split('@')[0];
            const mentionText = `@${senderPhone}`;
            // Find a photo message to quote (most relevant context)
            const photoMsg = userData.messages.find(m => m.photo && m.msgId);
            const messageOptions = { mentions: [senderId] };
            if (photoMsg?.msgId) {
              messageOptions.quotedMessageId = photoMsg.msgId;
            }
            await targetChat.sendMessage(`${mentionText} ${extraction.response}`.trim(), messageOptions);
            console.log(`[Startup] Sent message to ${senderPhone}: ${extraction.response}${photoMsg?.msgId ? ' (quoted)' : ''}`);
          } catch (e) {
            console.log(`[Startup] Error sending message: ${e.message}`);
          }
        }

        if (extraction.requests && extraction.requests.length > 0) {
          // Helper to validate addresses
          const isValidAddress = (address) => {
            if (!address || typeof address !== 'string') return false;
            if (!/\d+/.test(address)) return false; // Must have street number
            const invalidPatterns = [
              /pendiente/i, /no proporcionada/i, /información/i,
              /no especificad/i, /sin dirección/i, /falta dirección/i
            ];
            if (invalidPatterns.some(p => p.test(address))) return false;
            if (address.length < 3 || address.length > 100) return false;
            return true;
          };

          // Get all vehicle request msgIndex values to know boundaries
          const vehicleMsgIndexes = extraction.requests
            .filter(r => r.reportType === 'vehiculo_mal_estacionado' && r.msgIndex)
            .map(r => r.msgIndex)
            .sort((a, b) => a - b);

          for (const req of extraction.requests) {
            // Skip if no address or invalid address
            if (!isValidAddress(req.address)) {
              console.log(`[Startup] Invalid/missing address, ignorando: "${req.address}"`);
              continue;
            }
            // Skip if already processed in last 12 hours (per address + report type + patente for vehicles)
            const recentDupe = this.isRecentDuplicate(req.address, req.reportType, processedAddresses, req.patente);
            if (recentDupe) {
              console.log(`[Startup] Ya procesado en últimas 12h: ${req.address} [${req.reportType || 'recoleccion'}] (#${recentDupe.solicitudNumber})`);
              continue;
            }

            // Find matching photo
            let photo = null;
            if (req.msgIndex && userData.messages[req.msgIndex - 1]?.photo) {
              photo = userData.messages[req.msgIndex - 1].photo;
            } else {
              photo = [...userData.messages].reverse().find(m => m.photo)?.photo || null;
            }

            // Add to in-memory dedup map to prevent duplicate queuing
            // For vehicle reports, include patente in the key
            let addrKey = this.normalizeAddressForComparison(req.address);
            if (req.reportType === 'vehiculo_mal_estacionado' && req.patente) {
              addrKey = `${addrKey}|${req.patente.toUpperCase()}`;
            }
            recentlyQueuedAddresses.set(addrKey, Date.now());

            console.log(`[Startup] Encontrado pendiente: ${req.address} (key: ${addrKey})`);

            // For vehicle reports, collect photos that belong to THIS specific vehicle
            // Use msgIndex to identify the starting photo, and stop before the next vehicle's msgIndex
            let photos = null;
            let primaryPhotoMsgId = null;  // For quoting the original message
            if (req.reportType === 'vehiculo_mal_estacionado') {
              const startIdx = req.msgIndex ? req.msgIndex - 1 : 0;
              photos = [];

              // Find where the NEXT vehicle starts (so we don't take its photos)
              const nextVehicleIdx = vehicleMsgIndexes.find(idx => idx > (req.msgIndex || 1));
              const endIdx = nextVehicleIdx ? nextVehicleIdx - 1 : userData.messages.length;

              console.log(`[Startup] Vehicle ${req.patente}: msgs ${startIdx + 1} to ${endIdx} (next vehicle at msg ${nextVehicleIdx || 'none'})`);

              for (let i = startIdx; i < endIdx; i++) {
                const msg = userData.messages[i];
                if (!msg.photo) continue;

                if (i === startIdx) {
                  // Always include the primary photo
                  photos.push(msg.photo);
                  primaryPhotoMsgId = msg.msgId;  // Store msgId for quoting
                  console.log(`[Startup]   Including primary: ${msg.photo.split('/').pop()} (msgId: ${msg.msgId ? 'yes' : 'no'})`);
                } else if (!msg.text || msg.text.trim() === '') {
                  // Include photos without text (continuation of same vehicle)
                  photos.push(msg.photo);
                  console.log(`[Startup]   Including continuation: ${msg.photo.split('/').pop()}`);
                } else {
                  // Photo has text - might be a different report, stop
                  console.log(`[Startup]   Stopping at msg ${i + 1} (has text: "${msg.text}")`);
                  break;
                }
              }

              console.log(`[Startup] Vehicle ${req.patente}: collected ${photos.length} photo(s)`);

              // Vehicle reports require at least 2 photos (infraction + patente)
              if (photos.length < 2) {
                console.log(`[Startup] ⚠️ Vehicle ${req.patente} only has ${photos.length} photo(s), need at least 2`);
              }
            }

            // Use Claude's per-request determination for postToX
            const shouldPostToX = req.postToX === true;

            // For vehicle reports, need to confirm patente before submission
            if (req.reportType === 'vehiculo_mal_estacionado' && req.patente) {
              // Determine what's missing - photos take priority over patente confirmation
              const effectiveMissingField = (photos && photos.length >= 2) ? 'patenteConfirmation' : 'photos';

              const vehicleReport = {
                address: req.address,
                reportType: 'vehiculo_mal_estacionado',
                patente: req.patente,
                infractionTime: req.infractionTime || null,
                photo: photo,
                photos: photos,
                msgIndex: req.msgIndex,
                postToX: shouldPostToX,
                senderId: senderId,
                senderName: senderName,
                chat: targetChat,
                photoMsgId: primaryPhotoMsgId,  // For quoting the original message
                missingField: effectiveMissingField
              };

              // Add to vehicle patente queue
              if (!vehiclePatenteQueue.has(senderId)) {
                vehiclePatenteQueue.set(senderId, []);
              }
              vehiclePatenteQueue.get(senderId).push(vehicleReport);
              console.log(`[Startup] Queued vehicle ${req.patente} for patente confirmation (${vehiclePatenteQueue.get(senderId).length} in queue)`);
            } else {
              // Non-vehicle reports go directly to queue
              requestQueue.push({
                senderId,
                senderName,
                address: req.address,
                reportType: req.reportType || 'recoleccion',
                containerType: req.containerType || 'negro',
                schedule: req.schedule || null,
                patente: req.patente || null, // For vehiculo_mal_estacionado
                infractionTime: req.infractionTime || null, // For vehiculo_mal_estacionado
                photo,
                photos, // For vehiculo_mal_estacionado: multiple photos
                chat: targetChat,
                postToX: shouldPostToX
              });
            }
          }
        }

        // Small delay to avoid rate limiting
        await this.delay(1000);
      }

      // Process vehicle patente confirmation queue - ask about first vehicle for each sender
      for (const [senderId, vehicles] of vehiclePatenteQueue) {
        if (vehicles.length === 0) continue;

        const firstVehicle = vehicles[0];
        const missingField = firstVehicle.missingField || 'patenteConfirmation';
        console.log(`[Startup] Setting up ${missingField} for ${firstVehicle.patente} (${vehicles.length} vehicles queued for ${senderId.split('@')[0]})`);

        // Set up pending info request for the first vehicle
        if (!this.pendingInfoRequests) {
          this.pendingInfoRequests = new Map();
        }

        this.pendingInfoRequests.set(senderId, {
          ...firstVehicle,
          awaitingField: missingField,
          timestamp: Date.now()
        });

        // Ask the appropriate question based on what's missing
        try {
          const senderPhone = senderId.split('@')[0];
          const mentionText = `@${senderPhone}`;
          const queueInfo = vehicles.length > 1 ? ` (1 de ${vehicles.length} vehículos)` : '';

          let question;
          if (missingField === 'photos') {
            question = `Para reportar el vehículo mal estacionado en ${firstVehicle.address} necesito dos fotos: una de la infracción y otra de la patente.${queueInfo} ¿Podés mandar la otra foto?`;
          } else {
            question = `Leí la patente como ${firstVehicle.patente}. ¿Es correcta?${queueInfo} (respondé "si" o la patente correcta)`;
          }

          const messageOptions = { mentions: [senderId] };
          if (firstVehicle.photoMsgId) {
            messageOptions.quotedMessageId = firstVehicle.photoMsgId;
          }
          await firstVehicle.chat.sendMessage(`${mentionText} ${question}`, messageOptions);
          console.log(`[Startup] Asked ${missingField} for ${firstVehicle.patente} to ${senderPhone}${firstVehicle.photoMsgId ? ' (quoted)' : ''}`);
        } catch (e) {
          console.log(`[Startup] Error sending ${missingField} question: ${e.message}`);
        }
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

      console.log('[Retry] Sistema de reintentos activado (5min, 50min, 500min)');

      // Initialize X poster (login to X/Twitter)
      console.log('[X] Inicializando publicador de X/Twitter...');
      initXPoster().then(success => {
        if (success) {
          console.log('[X] Publicador de X listo!');
        } else {
          console.log('[X] Publicador de X no disponible - las publicaciones fallarán');
        }
      }).catch(err => {
        console.error('[X] Error inicializando publicador de X:', err.message);
      });
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
  await closeXBrowser();
  process.exit(0);
});
