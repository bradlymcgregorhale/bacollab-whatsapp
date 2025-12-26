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
  fs.writeFileSync(REPORTS_LOG, 'numero,fecha,direccion,link,timestamp\n');
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
      } else if (awaitingField === 'address' && lastMessage?.text) {
        // Looking for address - extract clean address from user's response
        console.log(`[Pending Info] User provided address response: "${lastMessage.text}"`);
        const cleanAddress = await this.extractCleanAddress(lastMessage.text);
        pendingRequest.address = cleanAddress;

        this.pendingInfoRequests.delete(senderId);
        pendingMessages.delete(senderId);

        console.log(`[Pending Info] Resubmitting with cleaned address: "${cleanAddress}"`);
        await this.submitRequest(pendingRequest);
        return;
      } else if (awaitingField === 'reportType' && lastMessage?.text) {
        // Looking for report type clarification - use Claude to interpret natural language
        console.log(`[Pending Info] User provided report type: "${lastMessage.text}"`);

        const reportType = await this.extractReportType(lastMessage.text);
        pendingRequest.reportType = reportType;
        console.log(`[Pending Info] Claude mapped to reportType: ${reportType}`);

        this.pendingInfoRequests.delete(senderId);
        pendingMessages.delete(senderId);

        // Notify user and queue request
        const chat = pendingRequest.chat;
        const senderInfo = this.senderIdCache?.get(senderId);
        const mentions = senderInfo ? [senderInfo.senderId] : [];
        const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : '';

        const reportLabels = {
          recoleccion: 'recolección de residuos',
          barrido: 'mejora de barrido',
          obstruccion: 'obstrucción de vereda',
          ocupacion_comercial: 'ocupación por local comercial',
          ocupacion_gastronomica: 'ocupación gastronómica',
          manteros: 'vendedores ambulantes'
        };

        await chat.sendMessage(`${mentionText} Ya mando la solicitud de ${reportLabels[reportType]} en ${pendingRequest.address}...`.trim(), { mentions });
        console.log(`[Pending Info] Submitting with reportType: ${reportType}`);
        await this.submitRequest(pendingRequest);
        return;
      } else if (lastMessage?.text) {
        // Generic text response - likely schedule or other info
        console.log(`[Pending Info] User responded: "${lastMessage.text}"`);

        if (awaitingField === 'schedule' || pendingRequest.awaitingQuestion?.includes('horario') || pendingRequest.awaitingQuestion?.includes('días')) {
          pendingRequest.schedule = lastMessage.text;
        } else {
          // Default: use as schedule
          pendingRequest.schedule = lastMessage.text;
        }

        this.pendingInfoRequests.delete(senderId);
        pendingMessages.delete(senderId);

        console.log(`[Pending Info] Resubmitting with: schedule="${pendingRequest.schedule}"`);
        await this.submitRequest(pendingRequest);
        return;
      }

      // If we get here, user responded but not with what we needed
      // Let the normal flow continue to re-analyze
      console.log(`[Pending Info] Response didn't match expected field ${awaitingField}, continuing normal flow`);
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
          await chat.sendMessage(`${mentionText} ${extraction.response}`.trim(), { mentions });
          console.log(`  [Bot] @${pending.senderName} ${extraction.response}`);

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

              console.log(`  [Partial] Saving partial request: ${partialAddress} (awaiting reportType)`);

              // Save as pending info request awaiting reportType
              if (!this.pendingInfoRequests) {
                this.pendingInfoRequests = new Map();
              }
              this.pendingInfoRequests.set(senderId, {
                senderId,
                senderName: pending.senderName,
                address: partialAddress,
                photo,
                chat,
                awaitingField: 'reportType',
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

        // Check for duplicates in last 24 hours
        const processedAddresses = this.getProcessedSolicitudes();
        const newRequests = [];
        const duplicates = [];

        for (const req of extraction.requests) {
          const recentDupe = this.isRecentDuplicate(req.address, processedAddresses);
          if (recentDupe) {
            duplicates.push({ address: req.address, solicitudNumber: recentDupe.solicitudNumber });
          } else {
            newRequests.push(req);
          }
        }

        // Notify about duplicates
        if (duplicates.length > 0) {
          for (const dupe of duplicates) {
            const dupeUrl = `https://bacolaborativa.buenosaires.gob.ar/detalleSolicitud/${dupe.solicitudNumber.replace(/\//g, '&')}?vieneDeMisSolicitudes=false`;
            await chat.sendMessage(
              `${mentionText} Ya mandé una solicitud para ${dupe.address} en las últimas 24 horas (#${dupe.solicitudNumber}).\n${dupeUrl}`.trim(),
              { mentions }
            );
            console.log(`  [Bot] Duplicado detectado: ${dupe.address} (#${dupe.solicitudNumber})`);
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
            manteros: 'vendedores ambulantes'
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

          // Check if user requested posting to X/Twitter
          const shouldPostToX = this.shouldPostToX(pending.messages);

          let queuedCount = 0;
          for (const req of newRequests) {
            // In-memory dedup: skip if this address was queued recently
            // Use normalizeAddressForComparison for consistent key generation
            const addrKey = this.normalizeAddressForComparison(req.address);
            const recentlyQueued = recentlyQueuedAddresses.get(addrKey);
            if (recentlyQueued && (Date.now() - recentlyQueued) < QUEUE_DEDUP_WINDOW_MS) {
              console.log(`  [Dedup] Skipping ${req.address} (key: ${addrKey}) - queued ${Math.round((Date.now() - recentlyQueued) / 1000)}s ago`);
              continue;
            }

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

            // Mark as queued with normalized key
            recentlyQueuedAddresses.set(addrKey, Date.now());
            console.log(`  [Dedup] Added ${req.address} (key: ${addrKey}) to dedup map`);

            requestQueue.push({
              senderId,
              senderName: pending.senderName,
              address: req.address,
              reportType: req.reportType || 'recoleccion',
              containerType: req.containerType || 'negro',
              schedule: req.schedule || null, // For manteros: days/times
              photo,
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
          const reportTypeLabel = req.reportType === 'barrido' ? 'barrido' : 'recoleccion';
          console.log(`    - ${req.address} (tipo: ${reportTypeLabel}, msgIndex: ${req.msgIndex || 'auto'})`);
        }
        for (const dupe of duplicates) {
          console.log(`    - ${dupe.address} (DUPLICADO - #${dupe.solicitudNumber})`);
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
      // IMPORTANT: Balance between not re-processing old messages and maintaining context
      // - If we asked a question (photo without address, etc.), include recent history for context
      // - If this is a fresh interaction, only process new messages

      const hasPendingInfoRequest = this.pendingInfoRequests?.has(senderId);
      const askedQuestionRecently = pending.askedQuestion === true;

      // Check if there are photos in history that might be relevant
      const userHistory = senderId ? (userMessageHistory.get(senderId) || []) : [];
      const recentPhotos = userHistory.slice(-5).filter(m => m.photo);
      const newMessagesHaveNoPhotos = !pending.messages.some(m => m.photo);
      const needsPhotoContext = recentPhotos.length > 0 && newMessagesHaveNoPhotos;

      let messagesToProcess;
      if (hasPendingInfoRequest || askedQuestionRecently || needsPhotoContext) {
        // Use recent history for context when:
        // 1. We're waiting for info (retry flow)
        // 2. We asked a question like "What address?"
        // 3. User sends text but recent history has photos (likely responding to photo)
        messagesToProcess = userHistory.slice(-5); // Last 5 for context
        const reason = hasPendingInfoRequest ? 'pending info request'
                     : askedQuestionRecently ? 'asked question recently'
                     : 'photo in recent history';
        console.log(`  [Context] Using history (${reason}) - ${messagesToProcess.length} messages`);

        // Clear the askedQuestion flag now that we're processing the follow-up
        if (askedQuestionRecently) {
          pending.askedQuestion = false;
        }
      } else {
        // Normal mode: ONLY process the NEW pending messages
        messagesToProcess = pending.messages;
        console.log(`  [Context] Processing ${messagesToProcess.length} NEW message(s) from ${senderId?.split('@')[0] || 'unknown'}`);
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

      const prompt = `${botContextText}MENSAJES DE ${pending.senderName}:
${messagesWithPhotos}

${hasPhotos ? `[Envió ${photos.length} foto(s) - analizalas. Cada foto corresponde al mensaje marcado con [+FOTO]]` : '[No envió fotos]'}

¿Hay algo actionable? Recordá que DEBE verse un contenedor de CABA en la foto para ser válido.${botContextText ? '\n\nIMPORTANTE: Si ya preguntaste algo arriba, NO vuelvas a preguntar lo mismo.' : ''}`;

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
      /subir\s*(a\s*)?(x|twitter)/i,
      /postea(r)?\s*(a\s*)?(x|twitter)/i,
      /publica(r)?\s*(en\s*)?(x|twitter)/i,
      /twittea(r)?/i,
      /manda(r)?\s*(a\s*)?(x|twitter)/i,
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

IMPORTANTE: Si el usuario dice "NO es X" o "no manteros", entonces NO es ese tipo.
Si dice "local" u "ocupación indebida" → ocupacion_comercial

Respondé SOLO con una de estas palabras: recoleccion, barrido, obstruccion, ocupacion_comercial, ocupacion_gastronomica, manteros`,
        messages: [{ role: 'user', content: rawText }]
      });

      const result = response.content[0].text.trim().toLowerCase();
      const validTypes = ['recoleccion', 'barrido', 'obstruccion', 'ocupacion_comercial', 'ocupacion_gastronomica', 'manteros'];

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
    const { senderId, senderName, address, reportType = 'recoleccion', containerType, schedule, photo, chat, postToX: shouldPostToX } = request;
    const senderInfo = this.senderIdCache?.get(senderId);
    const mentions = senderInfo ? [senderInfo.senderId] : [senderId];
    const mentionText = senderInfo ? `@${senderInfo.senderPhone}` : `@${senderId.split('@')[0]}`;

    const REPORT_TYPE_LABELS = {
      recoleccion: 'Recolección de residuos',
      barrido: 'Mejora de barrido',
      obstruccion: 'Obstrucción de calle/vereda',
      ocupacion_comercial: 'Ocupación por local comercial',
      ocupacion_gastronomica: 'Ocupación por área gastronómica',
      manteros: 'Manteros/vendedores ambulantes'
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
          schedule, // For manteros: days/times when vendors are present
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
        const timestamp = Date.now();
        const csvLine = `${result.solicitudNumber},${dateStr},"${address}",${solicitudUrl},${timestamp}\n`;
        fs.appendFileSync(REPORTS_LOG, csvLine);
        console.log(`  [Log] Guardado en reports.csv`);

        const successMsg = `${mentionText} Listo, mandé la solicitud para ${address}. #${result.solicitudNumber}\n${solicitudUrl}`;
        await chat.sendMessage(successMsg, { mentions });
        console.log(`  [Bot] Solicitud enviada: #${result.solicitudNumber}`);

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

        // Clean up photo after successful submission and X posting
        if (photo) {
          try { fs.unlinkSync(photo); } catch (e) {}
        }
      } else if (result.success) {
        const successMsg = `${mentionText} Listo, mandé la solicitud para ${address}.`;
        await chat.sendMessage(successMsg, { mentions });
        console.log(`  [Bot] Solicitud enviada (sin número)`);

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
  getProcessedSolicitudes() {
    const processed = new Map(); // address -> { timestamp, solicitudNumber }
    if (fs.existsSync(REPORTS_LOG)) {
      const content = fs.readFileSync(REPORTS_LOG, 'utf-8');
      const lines = content.split('\n').slice(1); // Skip header
      for (const line of lines) {
        if (line.trim()) {
          // Extract address and timestamp from CSV line
          // Format: numero,fecha,"direccion",link,timestamp
          const addressMatch = line.match(/"([^"]+)"/);
          const parts = line.split(',');
          const timestamp = parseInt(parts[parts.length - 1]) || 0;
          const solicitudNumber = parts[0];

          if (addressMatch) {
            const address = addressMatch[1].toLowerCase();
            // Keep the most recent entry for each address
            if (!processed.has(address) || processed.get(address).timestamp < timestamp) {
              processed.set(address, { timestamp, solicitudNumber });
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

  // Check if address was submitted in last 24 hours
  isRecentDuplicate(address, processedMap) {
    const normalizedNew = this.normalizeAddressForComparison(address);

    // Check against all processed addresses (normalized)
    for (const [storedAddr, entry] of processedMap) {
      const normalizedStored = this.normalizeAddressForComparison(storedAddr);
      if (normalizedNew === normalizedStored) {
        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        if (entry.timestamp > twentyFourHoursAgo) {
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
          senderId
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
            await targetChat.sendMessage(`${mentionText} ${extraction.response}`.trim(), { mentions: [senderId] });
            console.log(`[Startup] Sent message to ${senderPhone}: ${extraction.response}`);
          } catch (e) {
            console.log(`[Startup] Error sending message: ${e.message}`);
          }
        }

        if (extraction.requests && extraction.requests.length > 0) {
          // Check if user requested posting to X/Twitter
          const shouldPostToX = this.shouldPostToX(userData.messages);

          for (const req of extraction.requests) {
            // Skip if no address
            if (!req.address) {
              console.log(`[Startup] Request sin dirección, ignorando`);
              continue;
            }
            // Skip if already processed in last 24 hours
            const recentDupe = this.isRecentDuplicate(req.address, processedAddresses);
            if (recentDupe) {
              console.log(`[Startup] Ya procesado en últimas 24h: ${req.address} (#${recentDupe.solicitudNumber})`);
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
            const addrKey = this.normalizeAddressForComparison(req.address);
            recentlyQueuedAddresses.set(addrKey, Date.now());

            console.log(`[Startup] Encontrado pendiente: ${req.address} (key: ${addrKey})`);
            requestQueue.push({
              senderId,
              senderName,
              address: req.address,
              reportType: req.reportType || 'recoleccion',
              containerType: req.containerType || 'negro',
              schedule: req.schedule || null,
              photo,
              chat: targetChat,
              postToX: shouldPostToX
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
