import puppeteer from 'puppeteer';
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

// Initialize Anthropic client for intelligent form filling
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Setup file logging
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE = path.join(__dirname, 'index.log');

// Override console.log and console.error to also write to file
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

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

// Store browser instance for reuse
let browser = null;
let page = null;
let isLoggedIn = false;

// Deduplication: prevent submitting same address twice within time window
const recentSubmissions = new Map(); // address -> { timestamp, solicitudNumber }
const SUBMISSION_DEDUP_MS = 5 * 60 * 1000; // 5 minutes

// Per-address locks to prevent concurrent submissions
const submissionLocks = new Map(); // address -> Promise

const URLS = {
  prestaciones: 'https://bacolaborativa.buenosaires.gob.ar/prestaciones',
  recoleccion: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/1462821007742',
  barrido: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/096059',
  obstruccion: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/118020',
  ocupacion_comercial: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/118001',
  ocupacion_gastronomica: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/1604407880652',
  manteros: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/1334597891562',
  ubicacion: 'https://bacolaborativa.buenosaires.gob.ar/ubicacion'
};

// Report type labels for logging
const REPORT_TYPE_LABELS = {
  recoleccion: 'Recolección de residuos',
  barrido: 'Mejora de barrido',
  obstruccion: 'Obstrucción de calle/vereda',
  ocupacion_comercial: 'Ocupación por local comercial',
  ocupacion_gastronomica: 'Ocupación por área gastronómica',
  manteros: 'Manteros/vendedores ambulantes'
};

const SELECTORS = {
  // Login selectors
  mibaLoginButton: 'button#login',
  mibaLoginButtonAlt: 'button.btn-primary',
  // User logged in indicator
  userNameDropdown: '.navbar-user .btn-dropdown-text',
  // Solicitud flow selectors
  confirmarButton: 'button.btn-primary',
  addressInput: 'input[placeholder*="Lugar de tu solicitud"]',
  suggestionsList: '#suggestions ul li',
  nuevaSolicitudButton: '#popupButton',
  // Form selectors
  radioContenedorVerde: '#respuesta45731',
  radioContenedorNegro: '#respuesta45732',
  siguienteButton: 'button.btn-primary',
  confirmarFinalButton: 'button.btn-primary'
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Capture network requests during an action to see what's happening
async function captureNetworkDuringAction(page, actionFn, timeout = 5000) {
  const requests = [];
  const responses = [];
  const errors = [];

  const requestHandler = request => {
    const url = request.url();
    if (url.includes('/api/') || url.includes('solicitud') || url.includes('validar') || url.includes('guardar')) {
      requests.push({
        method: request.method(),
        url: url,
        postData: request.postData()
      });
    }
  };

  const responseHandler = async response => {
    const url = response.url();
    if (url.includes('/api/') || url.includes('solicitud') || url.includes('validar') || url.includes('guardar')) {
      let body = null;
      try {
        body = await response.text();
      } catch (e) {}
      responses.push({
        url: url,
        status: response.status(),
        body: body ? body.substring(0, 1000) : null
      });
    }
  };

  const errorHandler = error => {
    errors.push(error.message);
  };

  page.on('request', requestHandler);
  page.on('response', responseHandler);
  page.on('pageerror', errorHandler);

  try {
    // Execute the action
    await actionFn();

    // Wait a bit for network activity
    await delay(timeout);
  } finally {
    page.off('request', requestHandler);
    page.off('response', responseHandler);
    page.off('pageerror', errorHandler);
  }

  return { requests, responses, errors };
}

// Deep inspection of all accordions to find incomplete sections
async function inspectAllAccordions(page) {
  return await page.evaluate(() => {
    const result = {
      accordions: [],
      summary: {
        allComplete: true,
        incompleteSection: null,
        missingFields: []
      }
    };

    // Get all accordion items
    const accordionItems = document.querySelectorAll('.accordion-item, [class*="accordion"]');

    for (const item of accordionItems) {
      const header = item.querySelector('.accordion-header, .accordion-button, button[data-bs-toggle]');
      const collapse = item.querySelector('.accordion-collapse, .collapse');

      if (!collapse) continue;

      const accordionId = collapse.id || 'unknown';
      const headerText = header ? header.textContent.trim().substring(0, 100) : '';
      const isOpen = collapse.classList.contains('show');

      // Check for completion indicators
      const hasCheckmark = item.querySelector('.fa-check, .bi-check, [class*="check"], .completed') !== null;
      const hasWarning = item.querySelector('.fa-warning, .bi-exclamation, [class*="warning"], .incomplete') !== null;

      // If open, inspect contents
      let contents = null;
      if (isOpen) {
        const body = collapse.querySelector('.accordion-body') || collapse;

        // Find all form elements
        const inputs = body.querySelectorAll('input:not([type="hidden"])');
        const textareas = body.querySelectorAll('textarea');
        const selects = body.querySelectorAll('select');
        const radios = body.querySelectorAll('input[type="radio"]');
        const radioGroups = {};

        // Check radio groups
        for (const radio of radios) {
          const name = radio.name || 'unnamed';
          if (!radioGroups[name]) {
            radioGroups[name] = { checked: false, options: [] };
          }
          radioGroups[name].options.push(radio.value);
          if (radio.checked) {
            radioGroups[name].checked = true;
          }
        }

        // Check for empty required fields
        const emptyFields = [];
        for (const input of inputs) {
          if (input.type === 'radio') continue;
          if ((input.required || input.classList.contains('ng-invalid')) && !input.value) {
            emptyFields.push(input.name || input.placeholder || input.id || 'unknown input');
          }
        }
        for (const textarea of textareas) {
          if ((textarea.required || textarea.classList.contains('ng-invalid')) && !textarea.value) {
            emptyFields.push(textarea.name || textarea.placeholder || 'unknown textarea');
          }
        }

        // Check for unselected required radio groups
        for (const [name, group] of Object.entries(radioGroups)) {
          if (!group.checked) {
            emptyFields.push(`radio group: ${name}`);
          }
        }

        // Check for Siguiente button state
        const siguienteBtn = body.querySelector('button');
        const btnState = siguienteBtn ? {
          text: siguienteBtn.textContent.trim(),
          disabled: siguienteBtn.disabled
        } : null;

        contents = {
          inputCount: inputs.length,
          textareaCount: textareas.length,
          radioGroups: Object.keys(radioGroups).length,
          emptyFields,
          buttonState: btnState,
          innerText: body.innerText.substring(0, 300)
        };

        if (emptyFields.length > 0) {
          result.summary.allComplete = false;
          result.summary.incompleteSection = accordionId;
          result.summary.missingFields = emptyFields;
        }
      }

      result.accordions.push({
        id: accordionId,
        header: headerText,
        isOpen,
        hasCheckmark,
        hasWarning,
        contents
      });
    }

    return result;
  });
}

// Intelligent form filling - THINK about what's on screen and act
async function analyzeAndFillForm(page, availableData) {
  const { reportType, address, schedule, containerType, hasPhoto } = availableData;

  // THINK: What's currently visible on the page?
  const formContext = await page.evaluate(() => {
    const questionnaireAccordion = document.querySelector('#collapseCuestionario.show .accordion-body');
    if (!questionnaireAccordion) return null;

    // What's in this accordion?
    const textarea = questionnaireAccordion.querySelector('textarea');
    const radioInputs = questionnaireAccordion.querySelectorAll('input[type="radio"]');
    const allLabels = Array.from(questionnaireAccordion.querySelectorAll('label')).map(l => l.textContent.trim());
    const buttons = questionnaireAccordion.querySelectorAll('button');

    // Is there an enabled Siguiente button?
    let siguienteBtn = null;
    let siguienteDisabled = false;
    for (const btn of buttons) {
      if (btn.textContent.includes('Siguiente')) {
        siguienteBtn = true;
        siguienteDisabled = btn.disabled;
        break;
      }
    }

    // What's the question being asked?
    const questionLabel = questionnaireAccordion.querySelector('label')?.textContent?.trim() || '';

    // Check if this is a container type question
    const isContainerTypeQuestion = questionLabel.toLowerCase().includes('tipo de contenedor') ||
                                     questionLabel.toLowerCase().includes('qué tipo') ||
                                     allLabels.some(l => l.toLowerCase().includes('reciclables') || l.toLowerCase().includes('húmedos'));

    // Get all radio label texts for container type selection
    const radioLabelTexts = allLabels.filter(l =>
      l.toLowerCase().includes('verde') ||
      l.toLowerCase().includes('negro') ||
      l.toLowerCase().includes('gris') ||
      l.toLowerCase().includes('reciclables') ||
      l.toLowerCase().includes('húmedos')
    );

    return {
      hasTextarea: !!textarea,
      textareaValue: textarea?.value || '',
      textareaEmpty: textarea && (!textarea.value || textarea.value.length < 3),
      hasRadio: radioInputs.length > 0,
      radioLabels: allLabels.filter(l => l === 'Sí' || l === 'No'),
      radioLabelTexts, // All container type related labels
      isContainerTypeQuestion,
      radioSelected: !!questionnaireAccordion.querySelector('input[type="radio"]:checked'),
      questionLabel,
      hasSiguiente: !!siguienteBtn,
      siguienteDisabled,
      fullText: questionnaireAccordion.innerText.substring(0, 500)
    };
  });

  if (!formContext) {
    console.log('[Form AI] No questionnaire accordion visible - done');
    return { action: 'done' };
  }

  console.log('[Form AI] THINKING about form state:', JSON.stringify(formContext, null, 2));

  // THINK: What needs to be done based on what we see?

  // Case 0: Container type question - select based on containerType parameter
  if (formContext.isContainerTypeQuestion && formContext.hasRadio && !formContext.radioSelected) {
    console.log(`[Form AI] DECISION: Container type question detected, selecting "${containerType}"`);
    // Map containerType to the correct label text
    const isVerde = containerType === 'verde';
    const targetLabel = isVerde ? 'reciclables' : 'húmedos'; // Match partial text
    return {
      action: 'click_radio_by_text',
      value: targetLabel,
      then: 'click_siguiente'
    };
  }

  // Case 1: There's an empty textarea asking for days/hours
  if (formContext.hasTextarea && formContext.textareaEmpty) {
    console.log('[Form AI] DECISION: Fill textarea with schedule');
    return {
      action: 'fill_textarea',
      value: schedule || 'No especificado',
      then: 'click_siguiente'
    };
  }

  // Case 2: There are radio buttons (Sí/No) and none selected - likely "¿Querés sumar información?"
  if (formContext.hasRadio && !formContext.radioSelected && formContext.radioLabels.length > 0) {
    // THINK: Is this asking if we want to add more info?
    const isAskingForMore = formContext.questionLabel.toLowerCase().includes('sumar') ||
                            formContext.questionLabel.toLowerCase().includes('adicional') ||
                            formContext.questionLabel.toLowerCase().includes('agregar');

    if (isAskingForMore) {
      console.log('[Form AI] DECISION: Answering "No" to add more info question');
      return { action: 'click_radio', value: 'No', then: 'click_siguiente' };
    } else {
      // Some other yes/no question - default to No
      console.log('[Form AI] DECISION: Answering "No" to unknown yes/no question');
      return { action: 'click_radio', value: 'No', then: 'click_siguiente' };
    }
  }

  // Case 3: Textarea is filled and no radios, just need to click Siguiente
  if (formContext.hasTextarea && !formContext.textareaEmpty && formContext.hasSiguiente && !formContext.siguienteDisabled) {
    console.log('[Form AI] DECISION: Textarea filled, clicking Siguiente');
    return { action: 'click_siguiente' };
  }

  // Case 4: Radio is selected, just need to click Siguiente
  if (formContext.hasRadio && formContext.radioSelected && formContext.hasSiguiente && !formContext.siguienteDisabled) {
    console.log('[Form AI] DECISION: Radio selected, clicking Siguiente');
    return { action: 'click_siguiente' };
  }

  // Case 5: Siguiente button exists but is disabled - something not filled
  if (formContext.siguienteDisabled) {
    console.log('[Form AI] WARNING: Siguiente disabled, checking what needs to be filled...');
    // Try to fill whatever is empty
    if (formContext.hasTextarea && formContext.textareaEmpty) {
      return { action: 'fill_textarea', value: schedule || 'No especificado', then: 'wait' };
    }
    if (formContext.hasRadio && !formContext.radioSelected) {
      // If it's container type, select based on containerType
      if (formContext.isContainerTypeQuestion) {
        const isVerde = containerType === 'verde';
        return { action: 'click_radio_by_text', value: isVerde ? 'reciclables' : 'húmedos', then: 'wait' };
      }
      return { action: 'click_radio', value: 'No', then: 'wait' };
    }
  }

  // Default: questionnaire might be done
  if (!formContext.hasSiguiente) {
    console.log('[Form AI] No Siguiente button - questionnaire complete');
    return { action: 'done' };
  }

  console.log('[Form AI] Continuing to next step...');
  return { action: 'continue' };
}

// Execute form action returned by Claude - targets questionnaire accordion specifically
async function executeFormAction(page, action) {
  console.log('[Form Execute] Action:', action);

  if (action.action === 'fill_textarea') {
    await page.evaluate((value) => {
      const textarea = document.querySelector('#collapseCuestionario.show textarea');
      if (textarea) {
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, action.value);
    console.log('[Form Execute] Filled textarea with:', action.value);
  }

  if (action.action === 'click_radio') {
    await page.evaluate((targetValue) => {
      const labels = document.querySelectorAll('#collapseCuestionario.show label.form-radio-label');
      for (const label of labels) {
        const text = label.textContent.trim().toLowerCase();
        if (text.includes(targetValue.toLowerCase())) {
          label.click();
          return true;
        }
      }
      return false;
    }, action.value);
    console.log('[Form Execute] Clicked radio:', action.value);
  }

  // Handle click_radio_by_text - for container type and other radio selections
  if (action.action === 'click_radio_by_text') {
    const clicked = await page.evaluate((targetText) => {
      // Try multiple selectors for radio labels
      const selectors = [
        '#collapseCuestionario.show label.form-radio-label',
        '#collapseCuestionario.show .form-radio label',
        '#collapseCuestionario.show label[for^="respuesta"]',
        '#collapseCuestionario.show label'
      ];

      for (const selector of selectors) {
        const labels = document.querySelectorAll(selector);
        for (const label of labels) {
          const text = label.textContent.trim().toLowerCase();
          if (text.includes(targetText.toLowerCase())) {
            // Click the label
            label.click();
            // Also try clicking the associated radio input directly
            const radioId = label.getAttribute('for');
            if (radioId) {
              const radio = document.getElementById(radioId);
              if (radio) {
                radio.click();
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            return { success: true, text: label.textContent.trim() };
          }
        }
      }
      return { success: false };
    }, action.value);

    if (clicked.success) {
      console.log('[Form Execute] Clicked radio by text:', clicked.text);
    } else {
      console.log('[Form Execute] Could not find radio with text:', action.value);
    }
  }

  // Wait for Angular to update
  await delay(1000);

  if (action.then === 'click_siguiente' || action.action === 'click_siguiente') {
    const clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('#collapseCuestionario.show button');
      for (const btn of buttons) {
        if (btn.textContent.includes('Siguiente') && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      console.log('[Form Execute] Clicked Siguiente');
    } else {
      console.log('[Form Execute] No enabled Siguiente button found');
    }
    await delay(2000);
  }

  return action;
}

async function initBrowser() {
  if (!browser) {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: process.platform === 'linux' ? 'new' : false,  // Headless on Linux, visible on Mac
      slowMo: 30,
      defaultViewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Enable request interception to log API calls
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.includes('/api/') || url.includes('solicitud')) {
        console.log('[API Request]', request.method(), url);
        if (request.postData()) {
          console.log('[API Body]', request.postData());
        }
      }
      request.continue();
    });

    page.on('response', async response => {
      const url = response.url();
      if (url.includes('/api/') || url.includes('solicitud')) {
        console.log('[API Response]', response.status(), url);
        try {
          const text = await response.text();
          if (text && text.length < 2000) {
            console.log('[API Response Body]', text);
          }
        } catch (e) {}
      }
    });

    // Capture browser console messages (errors, warnings, logs)
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        console.log(`[Browser ${type.toUpperCase()}]`, msg.text());
      }
    });

    // Capture page errors (uncaught exceptions)
    page.on('pageerror', error => {
      console.log('[Browser PAGE ERROR]', error.message);
    });
  }
  return { browser, page };
}

async function login() {
  const { page } = await initBrowser();

  console.log('Starting login process...');
  await page.goto(URLS.prestaciones, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);

  // Check if already logged in
  const userName = await page.$eval(SELECTORS.userNameDropdown, el => el.textContent).catch(() => null);
  if (userName) {
    console.log(`Already logged in as: ${userName}`);
    isLoggedIn = true;
    return true;
  }

  // Click "Ingreso con miBA" button
  const clicked = await page.evaluate(() => {
    const elements = document.querySelectorAll('a, button');
    for (const el of elements) {
      if ((el.textContent || '').includes('miBA') || (el.textContent || '').includes('Ingreso')) {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  }

  await delay(3000);

  // Click "Ingresar con CUIL o email"
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, a');
    for (const btn of buttons) {
      if ((btn.textContent || '').includes('CUIL') || (btn.textContent || '').includes('email')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  await delay(2000);

  // Wait for form and fill credentials
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });

  // Fill email
  const emailField = await page.$('input[name="email"]') || await page.$('input[type="email"]') || await page.$('input[type="text"]');
  if (emailField) {
    await emailField.click({ clickCount: 3 });
    await emailField.type(EMAIL, { delay: 30 });
  }

  await delay(500);

  // Fill password
  const passwordField = await page.$('input[type="password"]');
  if (passwordField) {
    await passwordField.click();
    await passwordField.type(PASSWORD, { delay: 30 });
  }

  // Click login button
  const loginBtn = await page.$(SELECTORS.mibaLoginButton) || await page.$(SELECTORS.mibaLoginButtonAlt);
  if (loginBtn) {
    await loginBtn.click();
  }

  await delay(3000);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

  // Verify login
  const postLoginUrl = page.url();
  if (postLoginUrl.includes('bacolaborativa.buenosaires.gob.ar')) {
    console.log('Login successful!');
    isLoggedIn = true;
    return true;
  }

  return false;
}

async function submitSolicitud(data) {
  const { address, containerType = 'negro', description = '', reportType = 'recoleccion', schedule = null } = data;

  if (!isLoggedIn) {
    const loginSuccess = await login();
    if (!loginSuccess) {
      throw new Error('Login failed');
    }
  }

  const { page } = await initBrowser();

  // Determine which URL to use based on report type
  const targetUrl = URLS[reportType] || URLS.recoleccion;
  const reportTypeName = REPORT_TYPE_LABELS[reportType] || 'Recolección de residuos';

  console.log(`Submitting solicitud for address: ${address}`);
  console.log(`Report type: ${reportTypeName}`);

  // Step 1: Go to confirmation page for the appropriate report type
  console.log(`Step 1: Navigating to ${reportTypeName} page...`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);
  console.log('Current URL after Step 1:', page.url());

  // Step 2: Click "Confirmar" button (if present)
  console.log('Step 2: Looking for Confirmar button...');
  const confirmarClicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if ((btn.textContent || '').includes('Confirmar')) {
        console.log('Found Confirmar button, clicking...');
        btn.click();
        return true;
      }
    }
    return false;
  });

  console.log('Confirmar button clicked:', confirmarClicked);

  if (confirmarClicked) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
      console.log('Navigation after Confirmar timed out, continuing...');
    });
    await delay(2000);
  } else {
    // If no Confirmar button, we might already be on ubicacion page or need to navigate directly
    console.log('No Confirmar button found, checking if we need to navigate to ubicacion...');
    const currentUrl = page.url();
    if (!currentUrl.includes('ubicacion')) {
      console.log('Navigating directly to ubicacion page...');
      await page.goto(URLS.ubicacion, { waitUntil: 'networkidle2', timeout: 60000 });
      await delay(2000);
    }
  }

  console.log('Current URL after Step 2:', page.url());

  // Step 3: Enter address
  console.log('Step 3: Entering address...');
  console.log('Current URL:', page.url());

  // Ensure we're on the correct page before typing address
  const currentUrl = page.url();
  if (!currentUrl.includes('/ubicacion')) {
    console.log('Wrong page detected, navigating to /ubicacion...');
    await page.goto('https://bacolaborativa.buenosaires.gob.ar/ubicacion', { waitUntil: 'networkidle0', timeout: 30000 });
    console.log('Navigated to:', page.url());
    await delay(2000);
  }

  // Wait for Angular app to load and the autocomplete component to be ready
  console.log('Waiting for page to fully load...');

  // First, wait for any loading spinner to disappear
  try {
    await page.waitForFunction(() => {
      const spinners = document.querySelectorAll('.spinner, .loading, [class*="spinner"], [class*="loading"]');
      return spinners.length === 0 || Array.from(spinners).every(s => !s.offsetParent);
    }, { timeout: 30000 });
    console.log('No loading spinners detected');
  } catch (e) {
    console.log('Timeout waiting for loading spinner, continuing anyway...');
  }

  await delay(2000); // Extra delay for Angular to finish loading

  console.log('Waiting for address input to appear...');
  try {
    await page.waitForSelector('ng-autocomplete input, input[placeholder*="Lugar"], input[role="combobox"]', {
      timeout: 30000, // Increased from 15s to 30s
      visible: true
    });
    console.log('Address input selector found');
  } catch (e) {
    console.log('Timeout waiting for address input selector');
  }

  await delay(1500); // Brief delay for Angular to finish binding

  // Debug: Take screenshot and log all input elements
  await page.screenshot({ path: 'debug-before-address-input.png', fullPage: true });
  const inputsInfo = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    return Array.from(inputs).map(i => ({
      type: i.type,
      placeholder: i.placeholder,
      ariaLabel: i.getAttribute('aria-label'),
      role: i.role,
      id: i.id,
      className: i.className,
      name: i.name
    }));
  });
  console.log('Available inputs on page:', JSON.stringify(inputsInfo, null, 2));

  const addressInput = await page.$('input[placeholder*="Lugar de tu solicitud"]') ||
                       await page.$('input[aria-label*="Lugar de tu solicitud"]') ||
                       await page.$('input[placeholder*="Uspallata"]') ||
                       await page.$('ng-autocomplete input[type="text"]') ||
                       await page.$('.autocomplete-container input[type="text"]') ||
                       await page.$('input[role="combobox"]') ||
                       await page.$('input[placeholder*="dirección"]') ||
                       await page.$('input[placeholder*="ubicación"]') ||
                       await page.$('input[placeholder*="calle"]');

  if (!addressInput) {
    await page.screenshot({ path: 'debug-no-address-input.png', fullPage: true });
    throw new Error('Address input not found - check debug-before-address-input.png and console logs for available inputs');
  }

  // Clear any existing text and focus the input
  await addressInput.click({ clickCount: 3 }); // Triple-click to select all
  await page.keyboard.press('Backspace');
  await delay(500);

  // Type the address slowly to allow autocomplete to respond
  console.log(`Typing address: ${address}`);
  await addressInput.type(address, { delay: 100 }); // Slower typing

  // Wait for suggestions to appear
  console.log('Step 4: Waiting for suggestions to appear...');
  await delay(1500); // Initial delay for API response

  // Try waiting for suggestions with multiple selectors
  const suggestionSelectors = [
    '#suggestions.is-visible li.item',
    '#suggestions ul li.item',
    '.suggestions-container.is-visible li',
    '#suggestions li'
  ];

  let suggestionsFound = false;
  for (const selector of suggestionSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000, visible: true });
      console.log(`Suggestions found with selector: ${selector}`);
      suggestionsFound = true;
      break;
    } catch (e) {
      // Try next selector
    }
  }

  if (!suggestionsFound) {
    console.log('No suggestions appeared, retrying with backspace...');

    // Retry up to 3 times: backspace and retype last character to re-trigger autocomplete
    for (let retry = 0; retry < 3 && !suggestionsFound; retry++) {
      console.log(`Retry ${retry + 1}: Backspace and retype last character`);
      await page.keyboard.press('Backspace');
      await delay(300);
      await page.keyboard.type(address.slice(-1), { delay: 100 });
      await delay(2000);

      // Check if suggestions appeared
      for (const selector of suggestionSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 3000, visible: true });
          console.log(`Suggestions found on retry ${retry + 1} with selector: ${selector}`);
          suggestionsFound = true;
          break;
        } catch (e) {
          // Try next selector
        }
      }
    }
  }

  // Debug: Check what's in the suggestions container
  const suggestionsDebug = await page.evaluate(() => {
    const container = document.getElementById('suggestions');
    if (container) {
      return {
        className: container.className,
        innerHTML: container.innerHTML.substring(0, 500),
        childCount: container.querySelectorAll('li').length
      };
    }
    return { error: 'No suggestions container found' };
  });
  console.log('Suggestions state:', JSON.stringify(suggestionsDebug, null, 2));

  await page.screenshot({ path: 'debug-suggestions-visible.png', fullPage: true });

  // Click the first suggestion - need to click the li.item element
  console.log('Selecting address from suggestions...');
  const suggestionClicked = await page.evaluate(() => {
    // Try various selectors for the suggestion item
    const selectors = [
      '#suggestions ul li.item',
      '#suggestions li.item',
      '.suggestions-container.is-visible li.item',
      '#suggestions ul li',
      '.suggestions-container li'
    ];

    for (const sel of selectors) {
      const suggestions = document.querySelectorAll(sel);
      if (suggestions.length > 0) {
        // Try clicking the first item
        const firstItem = suggestions[0];
        const text = firstItem.textContent || '';
        console.log('Found suggestion:', text);

        // Try clicking the anchor inside first
        const anchor = firstItem.querySelector('a.titulo-sugerencia');
        if (anchor) {
          anchor.click();
          return { success: true, method: 'anchor click', text };
        }

        // Try clicking the div inside
        const div = firstItem.querySelector('div');
        if (div) {
          div.click();
          return { success: true, method: 'div click', text };
        }

        // Click the li itself
        firstItem.click();
        return { success: true, method: 'li click', text };
      }
    }
    return { success: false, selectors: selectors.map(s => ({s, count: document.querySelectorAll(s).length})) };
  });

  console.log('Suggestion click result:', suggestionClicked);

  if (!suggestionClicked.success) {
    await page.screenshot({ path: 'debug-no-suggestions.png', fullPage: true });
    throw new Error('No address suggestions found');
  }

  // Wait for the popup/panel to appear after selecting address
  console.log('Waiting for address selection to process...');
  await delay(3000);

  await page.screenshot({ path: 'debug-after-suggestion-click.png', fullPage: true });

  // Step 5: Wait for popup panel and click "Nueva Solicitud" button
  console.log('Step 5: Waiting for popup panel...');

  // Wait for the popup to appear (it has id="popupubicacion")
  await page.waitForSelector('#popupubicacion, #popupButton', { timeout: 10000 }).catch(() => {
    console.log('Popup selector timeout, trying anyway...');
  });

  await page.screenshot({ path: 'debug-popup-visible.png', fullPage: true });

  console.log('Clicking Nueva Solicitud...');
  const nuevaSolicitudClicked = await page.evaluate(() => {
    // First try the popup button specifically
    const popupBtn = document.getElementById('popupButton');
    if (popupBtn) {
      console.log('Found popupButton, clicking...');
      popupBtn.click();
      return { success: true, method: 'popupButton' };
    }

    // Try finding button with "Nueva Solicitud" text
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if (text.includes('Nueva Solicitud')) {
        console.log('Found Nueva Solicitud button, clicking...');
        btn.click();
        return { success: true, method: 'button text' };
      }
    }

    // Try button inside the popup panel
    const popup = document.getElementById('popupubicacion');
    if (popup) {
      const btn = popup.querySelector('button');
      if (btn) {
        console.log('Found button in popup, clicking...');
        btn.click();
        return { success: true, method: 'popup button' };
      }
    }

    return { success: false };
  });

  console.log('Nueva Solicitud click result:', nuevaSolicitudClicked);

  if (!nuevaSolicitudClicked.success) {
    await page.screenshot({ path: 'debug-no-nueva-solicitud.png', fullPage: true });
    throw new Error('Could not find Nueva Solicitud button');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await delay(2000);

  await page.screenshot({ path: 'debug-after-nueva-solicitud.png', fullPage: true });

  // Step 6 & 7: Intelligent form filling using Claude AI
  console.log('Step 6: Intelligent form filling...');
  await page.screenshot({ path: 'debug-questionnaire.png', fullPage: true });

  // Prepare available data for Claude
  const availableData = {
    reportType,
    address,
    schedule: schedule || 'No especificado',
    containerType: containerType || 'negro',
    hasPhoto: data.photos && data.photos.length > 0
  };

  // Keep analyzing and filling questionnaire until done or need_info
  for (let step = 0; step < 10; step++) {
    // Check if questionnaire accordion specifically is visible
    const hasQuestionnaire = await page.evaluate(() => {
      const accordion = document.querySelector('#collapseCuestionario.show');
      return !!accordion;
    });

    if (!hasQuestionnaire) {
      console.log(`[Form AI] Step ${step + 1}: Questionnaire complete, moving on`);
      break;
    }

    // Use Claude to analyze the form and decide what to do
    const action = await analyzeAndFillForm(page, availableData);

    if (action.action === 'done') {
      console.log(`[Form AI] Step ${step + 1}: Form complete`);
      break;
    }

    if (action.action === 'need_info') {
      console.log(`[Form AI] Step ${step + 1}: Need info - ${action.question}`);
      // Return special response so WhatsApp bot can ask the user
      return {
        success: false,
        needsInfo: true,
        question: action.question,
        field: action.field || 'unknown'
      };
    }

    if (action.action === 'continue') {
      console.log(`[Form AI] Step ${step + 1}: Continuing...`);
      await delay(1000);
      continue;
    }

    // Execute the action
    await executeFormAction(page, action);
    await page.screenshot({ path: `debug-form-step-${step + 1}.png`, fullPage: true });
  }

  // Dynamic accordion handling - process each accordion in order
  console.log('Processing form accordions dynamically...');
  await page.screenshot({ path: 'debug-accordions.png', fullPage: true });

  // Step A: Handle Description accordion
  console.log('Step A: Description accordion...');
  const descResult = await clickAccordionButton(page, '#collapseDescribirSituacion');
  console.log(`Description accordion: ${JSON.stringify(descResult)}`);
  if (descResult.success) {
    await delay(2000);
  }

  // Step B: Handle Photos accordion (upload photos when it becomes visible)
  console.log('Step B: Photos accordion...');
  await page.waitForSelector('#collapseFotos.show', { timeout: 10000 }).catch(() => {
    console.log('Photos accordion not visible, may not be required');
  });

  const photosVisible = await page.evaluate(() => {
    const el = document.querySelector('#collapseFotos');
    return el && el.classList.contains('show');
  });

  if (photosVisible) {
    console.log('Photos accordion is visible');

    // Check if photos are required (button is disabled)
    const photosRequired = await page.evaluate(() => {
      const btn = document.querySelector('#collapseFotos button.btn-default, #collapseFotos button.btn-primary');
      return btn && btn.disabled;
    });

    if (data.photos && data.photos.length > 0) {
      console.log(`Uploading ${data.photos.length} photo(s)...`);

      for (let i = 0; i < Math.min(data.photos.length, 3); i++) {
        const photoPath = data.photos[i];
        console.log(`  Uploading photo ${i + 1}: ${photoPath}`);

        try {
          const fileInputs = await page.$$('input[type="file"]#file-upload');
          if (fileInputs.length > i) {
            await fileInputs[i].uploadFile(photoPath);
            console.log(`  Photo ${i + 1} uploaded`);
            await delay(2000);
          }
        } catch (uploadError) {
          console.log(`  Failed to upload photo ${i + 1}:`, uploadError.message);
        }
      }
      await page.screenshot({ path: 'debug-after-photo-upload.png', fullPage: true });
    } else if (photosRequired) {
      console.log('WARNING: Photos are required for this report type but none provided');
      throw new Error('Este tipo de reporte requiere foto. Por favor, enviá una foto.');
    }

    // Click Siguiente in photos accordion
    const photosResult = await clickAccordionButton(page, '#collapseFotos');
    console.log(`Photos accordion: ${JSON.stringify(photosResult)}`);
    if (photosResult.success) {
      await delay(2000);
    }
  }

  // Step C: Handle Contact accordion (may need radio selection)
  console.log('Step C: Contact accordion...');

  // Wait a bit for the accordion to open
  await delay(2000);

  // Check what accordions are currently visible
  const accordionState = await page.evaluate(() => {
    const accordions = document.querySelectorAll('.accordion-collapse');
    const states = [];
    for (const acc of accordions) {
      states.push({
        id: acc.id,
        isOpen: acc.classList.contains('show'),
        text: acc.innerText.substring(0, 100)
      });
    }
    return states;
  });
  console.log('Accordion states:', JSON.stringify(accordionState, null, 2));

  // If Contact accordion is open, check if it needs interaction
  const contactVisible = accordionState.find(a => a.id === 'collapseSolicitudContacto' && a.isOpen);
  if (contactVisible) {
    console.log('Contact accordion is open - checking for required selections...');
    await page.screenshot({ path: 'debug-contact-accordion.png', fullPage: true });

    // Check if there are radio buttons that need to be selected (email, phone, etc.)
    const contactInteraction = await page.evaluate(() => {
      const accordion = document.querySelector('#collapseSolicitudContacto');
      if (!accordion) return { action: 'none' };

      // Check for unselected radio buttons
      const radioGroups = accordion.querySelectorAll('input[type="radio"]');
      const radioSelected = accordion.querySelector('input[type="radio"]:checked');

      if (radioGroups.length > 0 && !radioSelected) {
        // Need to select a radio option - prefer "Correo electrónico" (email)
        const labels = accordion.querySelectorAll('label');
        for (const label of labels) {
          const text = label.textContent.trim().toLowerCase();
          if (text.includes('correo') || text.includes('email')) {
            // Find the associated radio input and click
            const radio = label.querySelector('input[type="radio"]') ||
                         document.getElementById(label.getAttribute('for'));
            if (radio) {
              label.click();
              return { action: 'selected_email', text: label.textContent.trim() };
            }
          }
        }
        // If no email option, select the first option
        if (radioGroups[0]) {
          const firstLabel = radioGroups[0].closest('label') ||
                            accordion.querySelector(`label[for="${radioGroups[0].id}"]`);
          if (firstLabel) {
            firstLabel.click();
            return { action: 'selected_first', text: firstLabel.textContent.trim() };
          }
          radioGroups[0].click();
          return { action: 'clicked_radio', text: 'first option' };
        }
      }

      // Check for checkboxes that need to be checked
      const checkboxes = accordion.querySelectorAll('input[type="checkbox"]:not(:checked)');
      for (const checkbox of checkboxes) {
        const label = checkbox.closest('label') ||
                     accordion.querySelector(`label[for="${checkbox.id}"]`);
        if (label) {
          checkbox.click();
          return { action: 'checked_checkbox', text: label.textContent.trim() };
        }
      }

      // Check if Siguiente button is disabled (means something still needs to be done)
      const siguienteBtn = accordion.querySelector('button');
      if (siguienteBtn && siguienteBtn.disabled) {
        // Look for any empty required inputs
        const inputs = accordion.querySelectorAll('input:not([type="radio"]):not([type="checkbox"])');
        for (const input of inputs) {
          if (input.required && !input.value) {
            return { action: 'needs_input', field: input.placeholder || input.name || 'unknown' };
          }
        }
        return { action: 'button_disabled', reason: 'unknown requirement' };
      }

      return { action: 'ready', radioSelected: !!radioSelected };
    });

    console.log('Contact accordion interaction:', JSON.stringify(contactInteraction));

    if (contactInteraction.action === 'needs_input') {
      throw new Error(`Formulario de contacto incompleto: falta ${contactInteraction.field}`);
    }

    if (contactInteraction.action !== 'none') {
      await delay(1000); // Wait for any selection to register
    }
  }

  // Try clicking any Siguiente button in the Contact accordion
  const contactResult = await clickAccordionButton(page, '#collapseSolicitudContacto');
  console.log(`Contact accordion: ${JSON.stringify(contactResult)}`);

  await delay(1000);

  // Now click the main Siguiente/Confirmar button at the bottom
  console.log('Looking for main submit button...');
  await page.screenshot({ path: 'debug-before-submit.png', fullPage: true });

  // First, capture the HTML of the form-actions area for debugging
  const formActionsHTML = await page.evaluate(() => {
    // IMPORTANT: Look for the MAIN form-actions at the bottom (with mt-50 class)
    // NOT the ones inside collapsed accordions
    const mainFormActions = document.querySelector('.form-actions.mt-50');
    if (mainFormActions) return mainFormActions.outerHTML;

    // Fallback: find form-actions that is NOT inside a collapsed accordion
    const allFormActions = document.querySelectorAll('.form-actions');
    for (const fa of allFormActions) {
      const inCollapsedAccordion = fa.closest('.accordion-collapse:not(.show)');
      if (!inCollapsedAccordion) {
        return fa.outerHTML;
      }
    }
    return null;
  });
  console.log('Form-actions HTML:', formActionsHTML);

  // Try to find and click any available submit button with multiple methods
  const submitResult = await page.evaluate(() => {
    const result = { success: false, methods: [], html: null };

    // CRITICAL: Look for the MAIN form-actions at bottom (with mt-50 class) FIRST
    // This is the one that submits the entire form, not the ones inside accordions
    let formActions = document.querySelector('.form-actions.mt-50');

    // If not found, look for form-actions that is NOT inside a collapsed accordion
    if (!formActions) {
      const allFormActions = document.querySelectorAll('.form-actions');
      for (const fa of allFormActions) {
        const inCollapsedAccordion = fa.closest('.accordion-collapse:not(.show)');
        const inOpenAccordion = fa.closest('.accordion-collapse.show');
        // Prefer form-actions that is NOT inside ANY accordion (main page level)
        if (!inCollapsedAccordion && !inOpenAccordion) {
          formActions = fa;
          break;
        }
      }
    }

    if (formActions) {
      const btn = formActions.querySelector('button.btn-primary:not([disabled])');
      if (btn) {
        result.html = btn.outerHTML;

        // Method 1: Standard click
        btn.click();
        result.methods.push('click');

        // Method 2: Dispatch MouseEvent (works better with Angular)
        btn.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window
        }));
        result.methods.push('MouseEvent');

        // Method 3: Focus and trigger
        btn.focus();
        btn.dispatchEvent(new Event('focus', { bubbles: true }));
        result.methods.push('focus');

        result.success = true;
        result.method = 'form-actions';
        result.text = btn.textContent.trim();
        return result;
      }
    }

    // Look for any primary button with Siguiente or Confirmar
    const buttons = document.querySelectorAll('button.btn-primary:not([disabled])');
    for (const btn of buttons) {
      const text = btn.textContent || '';
      const isInAccordion = btn.closest('.accordion-body');
      if (!isInAccordion && (text.includes('Siguiente') || text.includes('Confirmar'))) {
        result.html = btn.outerHTML;
        btn.click();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        result.success = true;
        result.method = 'fallback';
        result.text = text.trim();
        result.methods.push('click', 'MouseEvent');
        return result;
      }
    }

    return result;
  });

  console.log('Submit button result:', submitResult);

  // Also try Puppeteer's native click as backup
  if (submitResult.success) {
    console.log('Also trying Puppeteer native click...');
    try {
      // Use the MAIN form-actions selector (with mt-50 class)
      const btnSelector = '.form-actions.mt-50 button.btn-primary:not([disabled])';
      await page.waitForSelector(btnSelector, { timeout: 2000 });
      await page.click(btnSelector);
      console.log('Puppeteer native click successful');
    } catch (e) {
      console.log('Puppeteer native click skipped:', e.message);
    }
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
    console.log('Navigation timeout after submit');
  });
  await delay(3000);

  await page.screenshot({ path: 'debug-after-form.png', fullPage: true });

  // Step 11: Intelligent final step - analyze page and decide what to do
  console.log('Step 11: Analyzing page for final action...');
  await page.screenshot({ path: 'debug-before-confirm.png', fullPage: true });

  // Use Claude to analyze the full page and decide what to do
  let previousMainText = '';
  let actionsTried = []; // Track what we've tried to avoid repeating
  let stuckCount = 0;

  for (let attempt = 0; attempt < 10; attempt++) {  // Increased to allow recovery attempts
    const pageContext = await page.evaluate(() => {
      // Get FULL body text to see everything
      const bodyText = document.body.innerText;

      // Also get the main content area specifically
      const mainContent = document.querySelector('main, .main-container, [role="main"]');
      const mainText = mainContent ? mainContent.innerText : bodyText;

      // Get visible accordions/sections
      const visibleAccordions = Array.from(document.querySelectorAll('.accordion-collapse.show')).map(a => ({
        id: a.id,
        text: a.innerText.substring(0, 300)
      }));

      // Check for error messages
      const errorElements = document.querySelectorAll('.alert-danger, .error, .invalid-feedback, .text-danger');
      const errors = Array.from(errorElements).map(e => e.innerText.trim()).filter(t => t);

      // Get form actions area
      const formActions = document.querySelector('.form-actions');
      const formActionsText = formActions ? formActions.innerText : '';

      return {
        url: window.location.href,
        title: document.title,
        bodyText: bodyText.substring(0, 5000),
        mainText: mainText.substring(0, 3000),
        visibleAccordions,
        errors,
        formActionsText,
        buttons: Array.from(document.querySelectorAll('button:not([disabled])')).map(b => ({
          text: b.textContent.trim().substring(0, 50),
          classes: b.className
        })),
        hasSuccess: bodyText.includes('éxito') || bodyText.includes('ingresada') || bodyText.includes('solicitud fue'),
        hasConfirmar: bodyText.includes('Confirmar')
      };
    });

    console.log(`[Final Step] Attempt ${attempt + 1}, URL: ${pageContext.url}`);
    console.log(`[Final Step] Visible accordions: ${JSON.stringify(pageContext.visibleAccordions.map(a => a.id))}`);
    console.log(`[Final Step] Errors: ${JSON.stringify(pageContext.errors)}`);
    console.log(`[Final Step] Form actions: ${pageContext.formActionsText}`);
    console.log(`[Final Step] Body text preview: ${pageContext.bodyText.substring(0, 500)}...`);

    // Check if page is stuck (same content as before)
    const isStuck = previousMainText && pageContext.mainText.substring(0, 500) === previousMainText.substring(0, 500);
    if (isStuck) {
      stuckCount++;
      console.log(`[Final Step] Page appears stuck (${stuckCount} times) - DEEP DIAGNOSIS`);

      // FIRST: Do a deep inspection of ALL accordions
      const accordionInspection = await inspectAllAccordions(page);
      console.log('[Final Step] ACCORDION INSPECTION:', JSON.stringify(accordionInspection, null, 2));

      // SECOND: Try clicking the button while capturing network requests
      console.log('[Final Step] Capturing network activity during button click...');
      const networkResult = await captureNetworkDuringAction(page, async () => {
        await page.evaluate(() => {
          // CRITICAL: Click the MAIN form-actions button (with mt-50), not the hidden accordion ones
          let btn = document.querySelector('.form-actions.mt-50 button.btn-primary:not([disabled])');

          // Fallback: find visible button not in accordion
          if (!btn) {
            const allBtns = document.querySelectorAll('.form-actions button.btn-primary:not([disabled])');
            for (const b of allBtns) {
              if (b.offsetParent !== null && !b.closest('.accordion-collapse')) {
                btn = b;
                break;
              }
            }
          }

          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });
      }, 3000);

      if (networkResult.requests.length > 0 || networkResult.responses.length > 0) {
        console.log('[Final Step] NETWORK REQUESTS:', JSON.stringify(networkResult.requests, null, 2));
        console.log('[Final Step] NETWORK RESPONSES:', JSON.stringify(networkResult.responses, null, 2));
      } else {
        console.log('[Final Step] NO NETWORK ACTIVITY - button click may not be triggering form submission');
      }

      if (networkResult.errors.length > 0) {
        console.log('[Final Step] PAGE ERRORS:', networkResult.errors);
      }

      // THIRD: Check if any accordion has incomplete fields
      if (!accordionInspection.summary.allComplete) {
        console.log(`[Final Step] FOUND INCOMPLETE SECTION: ${accordionInspection.summary.incompleteSection}`);
        console.log(`[Final Step] MISSING FIELDS: ${accordionInspection.summary.missingFields.join(', ')}`);
      }

      // Now do the standard diagnostics WITH full HTML capture
      const diagnostics = await page.evaluate(() => {
        const results = {
          formValidation: null,
          requiredFields: [],
          buttonState: null,
          angularErrors: [],
          hiddenErrors: [],
          formActionsHTML: null,
          allButtonsHTML: [],
          pageStructureHTML: null
        };

        // CRITICAL: Capture the actual HTML of the MAIN form-actions (with mt-50)
        // This is the submit button at the bottom, not the ones inside accordions
        let formActionsEl = document.querySelector('.form-actions.mt-50');
        if (!formActionsEl) {
          // Fallback: find form-actions NOT inside an accordion
          const allFormActions = document.querySelectorAll('.form-actions');
          for (const fa of allFormActions) {
            if (!fa.closest('.accordion-collapse')) {
              formActionsEl = fa;
              break;
            }
          }
        }
        if (formActionsEl) {
          results.formActionsHTML = formActionsEl.outerHTML;
        }

        // Capture HTML of all visible buttons, with better detection of which is the main submit
        const allButtons = document.querySelectorAll('button:not([disabled])');
        results.allButtonsHTML = Array.from(allButtons).map(btn => ({
          html: btn.outerHTML.substring(0, 200),
          text: btn.textContent.trim(),
          inFormActions: !!btn.closest('.form-actions'),
          inMainFormActions: !!btn.closest('.form-actions.mt-50'),
          inAccordion: !!btn.closest('.accordion-collapse'),
          isVisible: btn.offsetParent !== null
        }));

        // Capture the overall page structure around form actions
        const mainContainer = document.querySelector('app-solicitud-crear, main, .main-content') || document.body;
        results.pageStructureHTML = mainContainer.innerHTML.substring(0, 3000);

        // Check Angular form validation (ng-invalid classes)
        const invalidFields = document.querySelectorAll('.ng-invalid, [aria-invalid="true"], .is-invalid');
        results.requiredFields = Array.from(invalidFields).map(el => ({
          tag: el.tagName,
          name: el.name || el.id || el.placeholder || 'unknown',
          value: el.value || '',
          classes: el.className
        })).filter(f => f.tag === 'INPUT' || f.tag === 'TEXTAREA' || f.tag === 'SELECT');

        // Check form validity
        const forms = document.querySelectorAll('form');
        for (const form of forms) {
          if (!form.checkValidity()) {
            results.formValidation = 'Form is invalid';
          }
        }

        // Check the Siguiente button state in detail
        const accordions = document.querySelectorAll('.accordion-collapse.show');
        for (const accordion of accordions) {
          const btn = accordion.querySelector('button');
          if (btn && btn.textContent.includes('Siguiente')) {
            results.buttonState = {
              text: btn.textContent.trim(),
              disabled: btn.disabled,
              classes: btn.className,
              type: btn.type,
              form: btn.form ? 'has form' : 'no form',
              onclick: btn.onclick ? 'has onclick' : 'no onclick'
            };
          }
        }

        // Also check MAIN form-actions button (the one with mt-50, not inside accordions)
        let mainFormActions = document.querySelector('.form-actions.mt-50');
        if (!mainFormActions) {
          // Fallback: find form-actions NOT inside an accordion
          const allFormActions = document.querySelectorAll('.form-actions');
          for (const fa of allFormActions) {
            if (!fa.closest('.accordion-collapse')) {
              mainFormActions = fa;
              break;
            }
          }
        }
        if (mainFormActions) {
          const mainBtn = mainFormActions.querySelector('button.btn-primary');
          if (mainBtn) {
            results.mainButtonState = {
              text: mainBtn.textContent.trim(),
              disabled: mainBtn.disabled,
              classes: mainBtn.className,
              isVisible: mainBtn.offsetParent !== null,
              inMainFormActions: true
            };
          }
        }

        // Look for hidden validation errors (not just visible ones)
        const allValidationMsgs = document.querySelectorAll('[class*="invalid"], [class*="error"], [class*="validation"]');
        results.hiddenErrors = Array.from(allValidationMsgs)
          .map(el => el.innerText.trim())
          .filter(t => t && t.length > 0 && t.length < 200);

        // Check for Angular-specific error states
        const ngMessages = document.querySelectorAll('ng-message, [ng-message], .help-block');
        results.angularErrors = Array.from(ngMessages).map(el => el.innerText.trim()).filter(t => t);

        return results;
      });

      console.log('[Final Step] DIAGNOSTICS:', JSON.stringify(diagnostics, null, 2));

      // Log the captured HTML for debugging
      if (diagnostics.formActionsHTML) {
        console.log('[Final Step] FORM ACTIONS HTML:', diagnostics.formActionsHTML);
      } else {
        console.log('[Final Step] WARNING: No .form-actions element found on page!');
      }
      console.log('[Final Step] ALL BUTTONS:', JSON.stringify(diagnostics.allButtonsHTML, null, 2));

      // If we found form validation issues, report them instead of blindly retrying
      if (diagnostics.requiredFields.length > 0) {
        const emptyFields = diagnostics.requiredFields.filter(f => !f.value || f.value.trim() === '');
        if (emptyFields.length > 0) {
          console.log('[Final Step] FOUND EMPTY REQUIRED FIELDS:', emptyFields.map(f => f.name).join(', '));
        }
      }

      if (diagnostics.hiddenErrors.length > 0) {
        console.log('[Final Step] HIDDEN VALIDATION ERRORS:', diagnostics.hiddenErrors);
      }

      // Early termination: if button is clearly disabled, throw error immediately
      if (diagnostics.buttonState?.disabled || diagnostics.mainButtonState?.disabled) {
        const emptyFields = diagnostics.requiredFields.filter(f => !f.value || f.value.trim() === '');
        if (emptyFields.length > 0) {
          throw new Error(`Formulario incompleto: faltan campos obligatorios (${emptyFields.map(f => f.name).join(', ')})`);
        }
        if (diagnostics.hiddenErrors.length > 0) {
          throw new Error(`Error de validación: ${diagnostics.hiddenErrors[0]}`);
        }
      }

      // Use Claude Vision to analyze the situation
      console.log('[Final Step] Using Claude VISION to analyze screenshot...');

      // Take a fresh screenshot
      const screenshotPath = path.join(__dirname, 'debug-vision-analysis.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Read screenshot as base64
      const screenshotBase64 = fs.readFileSync(screenshotPath).toString('base64');

      // Also get HTML context for buttons and page structure
      const htmlContext = await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button:not([disabled])')).map(btn => ({
          text: btn.textContent.trim().substring(0, 50),
          classes: btn.className,
          inModal: !!btn.closest('.modal'),
          inAccordion: !!btn.closest('.accordion-collapse'),
          accordionId: btn.closest('.accordion-collapse')?.id || null
        }));

        const openAccordions = Array.from(document.querySelectorAll('.accordion-collapse.show')).map(a => a.id);

        const mainText = (document.querySelector('main') || document.body).innerText.substring(0, 1500);

        return { allButtons, openAccordions, mainText, url: window.location.href };
      });

      const visionPrompt = `Estás automatizando un formulario del gobierno de Buenos Aires (BA Colaborativa).

MIRÁ LA IMAGEN y también usá el contexto HTML para decirme EXACTAMENTE qué hacer.

URL ACTUAL: ${htmlContext.url}

📋 ESTADO DE TODAS LAS SECCIONES:
${accordionInspection.accordions.map(a => {
  let status = a.isOpen ? '🔓 ABIERTO' : '🔒 CERRADO';
  if (a.hasCheckmark) status += ' ✅';
  if (a.hasWarning) status += ' ⚠️';
  let info = `- ${a.id}: ${status}`;
  if (a.contents) {
    if (a.contents.emptyFields.length > 0) {
      info += `\n  ❌ CAMPOS VACÍOS: ${a.contents.emptyFields.join(', ')}`;
    }
    if (a.contents.buttonState) {
      info += `\n  Botón: "${a.contents.buttonState.text}" (disabled: ${a.contents.buttonState.disabled})`;
    }
  }
  return info;
}).join('\n')}

🌐 ACTIVIDAD DE RED AL CLICKEAR:
- Requests: ${networkResult.requests.length > 0 ? networkResult.requests.map(r => `${r.method} ${r.url.split('/').pop()}`).join(', ') : 'NINGUNA'}
- Responses: ${networkResult.responses.length > 0 ? networkResult.responses.map(r => `${r.status}`).join(', ') : 'NINGUNA'}
- Errores: ${networkResult.errors.length > 0 ? networkResult.errors.join(', ') : 'ninguno'}

⚠️ DIAGNÓSTICO DE FORMULARIO:
- Campos inválidos: ${diagnostics.requiredFields.length > 0 ? diagnostics.requiredFields.map(f => `${f.name}${f.value ? '=' + f.value : ' (VACÍO)'}`).join(', ') : 'ninguno'}
- Estado del botón principal: ${diagnostics.mainButtonState ? JSON.stringify(diagnostics.mainButtonState) : 'no encontrado'}
- Errores ocultos: ${diagnostics.hiddenErrors.length > 0 ? diagnostics.hiddenErrors.join(', ') : 'ninguno'}

📄 HTML DE LOS BOTONES EN LA PÁGINA:
${diagnostics.formActionsHTML ? `FORM-ACTIONS: ${diagnostics.formActionsHTML}` : 'NO HAY .form-actions EN LA PÁGINA'}

TODOS LOS BOTONES VISIBLES:
${diagnostics.allButtonsHTML.filter(b => b.isVisible).map(b => `- "${b.text}" ${b.inFormActions ? '(en form-actions)' : ''}: ${b.html}`).join('\n')}

ANÁLISIS:
- El botón "Siguiente" YA FUE CLICKEADO ${stuckCount} VECES y la página NO AVANZÓ
- Si hubo requests de red pero sin respuesta o con error, hay problema de backend
- Si NO hubo requests de red, el formulario no está validando correctamente
- Revisá las secciones arriba - si alguna tiene "CAMPOS VACÍOS", ESA es la que hay que completar

Respondé SOLO con JSON:
{"action": "fill", "field": "nombre del campo", "value": "qué poner"} - si hay campo vacío que llenar
{"action": "go_back", "section": "cuestionario|fotos|contacto", "reason": "explicación"} - si una sección anterior está incompleta
{"action": "click", "buttonText": "texto exacto", "location": "dónde"} - SOLO si el problema fue resuelto
{"action": "open_accordion", "accordionName": "nombre de la sección"} - si hay que abrir un accordion cerrado
{"action": "done", "reason": "solicitud completada"} - si ya terminamos
{"action": "error", "message": "descripción"} - SOLO si es un error IRRECUPERABLE (ej: sesión expirada)`;

      try {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshotBase64
                }
              },
              {
                type: 'text',
                text: visionPrompt
              }
            ]
          }]
        });

        const responseText = response.content[0].text;
        console.log('[Final Step] Claude VISION response:', responseText);

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const instruction = JSON.parse(jsonMatch[0]);

          if (instruction.action === 'done') {
            console.log('[Final Step] Claude Vision says we are done!');
            break;
          }

          if (instruction.action === 'error') {
            // Only throw for truly unrecoverable errors
            console.log(`[Final Step] Claude Vision reports error: ${instruction.message}`);
            if (instruction.message.toLowerCase().includes('sesión') ||
                instruction.message.toLowerCase().includes('expirad') ||
                instruction.message.toLowerCase().includes('login')) {
              throw new Error(instruction.message);
            }
            // For other "errors", try to recover by going back
            console.log('[Final Step] Attempting recovery by going back...');
            instruction.action = 'go_back';
            instruction.section = 'cuestionario';
            instruction.reason = instruction.message;
          }

          if (instruction.action === 'go_back') {
            console.log(`[Final Step] Going back to complete: ${instruction.section} (${instruction.reason})`);

            // Click "Anterior" button to go back
            const wentBack = await page.evaluate(() => {
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                if (btn.textContent.includes('Anterior') && !btn.disabled) {
                  btn.click();
                  return true;
                }
              }
              return false;
            });

            if (wentBack) {
              console.log('[Final Step] Clicked Anterior, waiting for page update...');
              await delay(3000);

              // Take screenshot to see what happened
              await page.screenshot({ path: 'debug-after-anterior.png', fullPage: true });

              // Do a DEEP inspection of ALL sections to see what we're dealing with
              const deepInspection = await inspectAllAccordions(page);
              console.log('[Final Step] AFTER ANTERIOR - Accordion states:');
              for (const acc of deepInspection.accordions) {
                console.log(`  - ${acc.id}: isOpen=${acc.isOpen}, hasCheckmark=${acc.hasCheckmark}, hasWarning=${acc.hasWarning}`);
                if (acc.contents) {
                  console.log(`    Contents: ${acc.contents.innerText.substring(0, 100)}...`);
                  if (acc.contents.emptyFields.length > 0) {
                    console.log(`    EMPTY FIELDS: ${acc.contents.emptyFields.join(', ')}`);
                  }
                }
              }

              // Map section names to selectors
              const sectionMap = {
                'cuestionario': '#collapseCuestionario',
                'fotos': '#collapseFotos',
                'contacto': '#collapseSolicitudContacto',
                'descripcion': '#collapseDescribirSituacion'
              };

              const targetSelector = sectionMap[instruction.section] || '#collapseCuestionario';

              // Force open the target section if it's not already open
              let isTargetOpen = await page.evaluate((selector) => {
                const el = document.querySelector(selector);
                return el && el.classList.contains('show');
              }, targetSelector);

              if (!isTargetOpen) {
                console.log(`[Final Step] Target section ${targetSelector} is NOT open, forcing open...`);

                // Try multiple ways to open the accordion
                const openResult = await page.evaluate((selector) => {
                  const accordion = document.querySelector(selector);
                  if (!accordion) return { error: 'Accordion not found' };

                  // Method 1: Click the header button
                  const accordionItem = accordion.closest('.accordion-item');
                  if (accordionItem) {
                    const headerBtn = accordionItem.querySelector('.accordion-button, .accordion-header button, button[data-bs-toggle]');
                    if (headerBtn) {
                      headerBtn.click();
                      return { method: 'header button click', success: true };
                    }
                  }

                  // Method 2: Find header by replacing 'collapse' with 'heading' in ID
                  const headerId = selector.replace('#collapse', '#heading');
                  const header = document.querySelector(headerId);
                  if (header) {
                    const btn = header.querySelector('button') || header;
                    btn.click();
                    return { method: 'heading ID click', success: true };
                  }

                  // Method 3: Click previous sibling
                  const prevSibling = accordion.previousElementSibling;
                  if (prevSibling) {
                    const btn = prevSibling.querySelector('button') || prevSibling;
                    btn.click();
                    return { method: 'previous sibling click', success: true };
                  }

                  // Method 4: Directly manipulate Bootstrap collapse
                  accordion.classList.add('show');
                  return { method: 'direct class manipulation', success: true };
                }, targetSelector);

                console.log('[Final Step] Open result:', openResult);
                await delay(2000);

                // Verify it's now open
                isTargetOpen = await page.evaluate((selector) => {
                  const el = document.querySelector(selector);
                  return el && el.classList.contains('show');
                }, targetSelector);

                console.log(`[Final Step] After forcing open: isTargetOpen = ${isTargetOpen}`);
              }

              // Take screenshot after opening
              await page.screenshot({ path: 'debug-after-force-open.png', fullPage: true });

              // Now do a deep inspection of the target section specifically
              const sectionContents = await page.evaluate((selector) => {
                const accordion = document.querySelector(selector);
                if (!accordion) return { error: 'Section not found' };

                const body = accordion.querySelector('.accordion-body') || accordion;
                const text = body.innerText;

                // Get all interactive elements
                const inputs = Array.from(body.querySelectorAll('input:not([type="hidden"])')).map(i => ({
                  type: i.type,
                  name: i.name || i.id || i.placeholder,
                  value: i.value,
                  checked: i.checked,
                  required: i.required,
                  invalid: i.classList.contains('ng-invalid')
                }));

                const textareas = Array.from(body.querySelectorAll('textarea')).map(t => ({
                  name: t.name || t.placeholder,
                  value: t.value,
                  required: t.required,
                  invalid: t.classList.contains('ng-invalid')
                }));

                const buttons = Array.from(body.querySelectorAll('button')).map(b => ({
                  text: b.textContent.trim(),
                  disabled: b.disabled
                }));

                return {
                  isOpen: accordion.classList.contains('show'),
                  text: text.substring(0, 500),
                  inputs,
                  textareas,
                  buttons
                };
              }, targetSelector);

              console.log('[Final Step] Section contents:', JSON.stringify(sectionContents, null, 2));

              // If we went back to questionnaire, try to complete it
              if (instruction.section === 'cuestionario' || targetSelector.includes('Cuestionario')) {
                console.log('[Final Step] Re-running questionnaire completion...');

                // Check what's actually in the questionnaire
                if (sectionContents.inputs.length === 0 && sectionContents.textareas.length === 0) {
                  console.log('[Final Step] WARNING: No form elements found in questionnaire section!');

                  // Maybe it's a different accordion structure - try to find any open form section
                  const anyFormSection = await page.evaluate(() => {
                    const openAccordions = document.querySelectorAll('.accordion-collapse.show');
                    for (const acc of openAccordions) {
                      const body = acc.querySelector('.accordion-body') || acc;
                      const hasInputs = body.querySelectorAll('input, textarea').length > 0;
                      if (hasInputs) {
                        return {
                          id: acc.id,
                          text: body.innerText.substring(0, 200)
                        };
                      }
                    }
                    return null;
                  });

                  if (anyFormSection) {
                    console.log(`[Final Step] Found form section: ${anyFormSection.id}`);
                    console.log(`[Final Step] Content: ${anyFormSection.text}`);
                  }
                }

                // Try to complete the questionnaire with available data
                for (let qStep = 0; qStep < 5; qStep++) {
                  const hasQuestionnaire = await page.evaluate(() => {
                    return !!document.querySelector('#collapseCuestionario.show');
                  });

                  if (!hasQuestionnaire) {
                    console.log('[Final Step] Questionnaire section closed, checking if complete...');

                    // Check if there's a checkmark indicating completion
                    const isComplete = await page.evaluate(() => {
                      const item = document.querySelector('#collapseCuestionario')?.closest('.accordion-item');
                      if (item) {
                        return item.querySelector('.fa-check, .bi-check, [class*="check"]') !== null;
                      }
                      return false;
                    });

                    console.log(`[Final Step] Questionnaire appears complete: ${isComplete}`);
                    break;
                  }

                  // Use the same logic as analyzeAndFillForm
                  const action = await analyzeAndFillForm(page, availableData);
                  console.log('[Final Step] Questionnaire action:', action);

                  if (action.action === 'done' || !action) break;

                  await executeFormAction(page, action);
                  await page.screenshot({ path: `debug-recovery-q-step-${qStep}.png`, fullPage: true });
                }
              }

              // Reset stuck count since we're taking new action
              stuckCount = 0;
              previousMainText = '';
            }
            continue;
          }

          if (instruction.action === 'open_accordion') {
            console.log(`[Final Step] Opening accordion: ${instruction.accordionName}`);

            const opened = await page.evaluate((name) => {
              // Try to find accordion by partial text match
              const headers = document.querySelectorAll('.accordion-header, .accordion-button, [data-bs-toggle="collapse"]');
              for (const header of headers) {
                if (header.textContent.toLowerCase().includes(name.toLowerCase())) {
                  header.click();
                  return { success: true, text: header.textContent.trim() };
                }
              }
              return { success: false };
            }, instruction.accordionName);

            console.log('[Final Step] Accordion open result:', opened);
            await delay(2000);
            stuckCount = 0;
            previousMainText = '';
            continue;
          }

          if (instruction.action === 'click' && instruction.buttonText) {
            console.log(`[Final Step] Claude Vision says click: "${instruction.buttonText}" at ${instruction.location}`);

            // Enhanced button clicking with multiple methods
            const clicked = await page.evaluate((btnText) => {
              const result = { clicked: false, methods: [] };

              // Method 1: Find button in MAIN form-actions first (with mt-50, not in accordion)
              let formActions = document.querySelector('.form-actions.mt-50');
              if (!formActions) {
                // Fallback: find form-actions NOT inside an accordion
                const allFormActions = document.querySelectorAll('.form-actions');
                for (const fa of allFormActions) {
                  if (!fa.closest('.accordion-collapse')) {
                    formActions = fa;
                    break;
                  }
                }
              }
              if (formActions) {
                const formBtn = formActions.querySelector('button.btn-primary:not([disabled])');
                if (formBtn && formBtn.textContent.trim().includes(btnText)) {
                  // Try click()
                  formBtn.click();
                  result.methods.push('form-actions click');

                  // Also try dispatching events
                  formBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  result.methods.push('form-actions dispatchEvent');

                  result.clicked = true;
                  result.text = formBtn.textContent.trim();
                  result.html = formBtn.outerHTML.substring(0, 150);
                  return result;
                }
              }

              // Method 2: Search all buttons
              const buttons = document.querySelectorAll('button:not([disabled])');
              for (const btn of buttons) {
                if (btn.textContent.trim().includes(btnText) || btn.textContent.trim() === btnText) {
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  result.clicked = true;
                  result.text = btn.textContent.trim();
                  result.methods.push('button click');
                  return result;
                }
              }

              // Method 3: Try links
              const links = document.querySelectorAll('a');
              for (const link of links) {
                if (link.textContent.trim().includes(btnText)) {
                  link.click();
                  result.clicked = true;
                  result.text = link.textContent.trim();
                  result.type = 'link';
                  result.methods.push('link click');
                  return result;
                }
              }

              return result;
            }, instruction.buttonText);

            console.log(`[Final Step] Vision instruction executed:`, clicked);

            // If page-based click didn't work, try Puppeteer's click
            if (!clicked.clicked) {
              console.log('[Final Step] Trying Puppeteer click...');
              try {
                // Use the MAIN form-actions selector (with mt-50)
                const btnHandle = await page.$(`.form-actions.mt-50 button.btn-primary:not([disabled])`);
                if (btnHandle) {
                  await btnHandle.click();
                  console.log('[Final Step] Puppeteer click succeeded');
                } else {
                  // Fallback to any visible primary button
                  const altHandle = await page.$(`button.btn-primary:not([disabled])`);
                  if (altHandle) {
                    await altHandle.click();
                    console.log('[Final Step] Puppeteer fallback click succeeded');
                  }
                }
              } catch (e) {
                console.log('[Final Step] Puppeteer click failed:', e.message);
              }
            }

            await delay(3000);
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
            continue;
          }

          if (instruction.action === 'fill' && instruction.field) {
            console.log(`[Final Step] Claude Vision says fill: "${instruction.field}" with "${instruction.value}"`);

            // Check if this is a radio button fill (field contains "radio" or value matches a radio label)
            const isRadioFill = instruction.field.toLowerCase().includes('radio') ||
                                instruction.value.toLowerCase().includes('contenedor') ||
                                instruction.value.toLowerCase().includes('reciclables') ||
                                instruction.value.toLowerCase().includes('húmedos') ||
                                instruction.value.toLowerCase().includes('verde') ||
                                instruction.value.toLowerCase().includes('negro');

            if (isRadioFill) {
              // Handle radio button selection
              const radioClicked = await page.evaluate((value) => {
                // Find radio labels that match the value
                const labels = document.querySelectorAll('label.form-radio-label, .form-radio label, label[for^="respuesta"]');
                for (const label of labels) {
                  const text = label.textContent.trim().toLowerCase();
                  if (text.includes(value.toLowerCase()) ||
                      (value.toLowerCase().includes('verde') && text.includes('reciclables')) ||
                      (value.toLowerCase().includes('negro') && text.includes('húmedos')) ||
                      (value.toLowerCase().includes('reciclables') && text.includes('reciclables')) ||
                      (value.toLowerCase().includes('húmedos') && text.includes('húmedos'))) {
                    // Click the label
                    label.click();
                    // Also click the radio input directly
                    const radioId = label.getAttribute('for');
                    if (radioId) {
                      const radio = document.getElementById(radioId);
                      if (radio) {
                        radio.click();
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                    }
                    return { success: true, text: label.textContent.trim() };
                  }
                }
                return { success: false };
              }, instruction.value);

              if (radioClicked.success) {
                console.log(`[Final Step] Selected radio: ${radioClicked.text}`);
              } else {
                console.log(`[Final Step] Could not find radio matching: ${instruction.value}`);
              }
            } else {
              // Handle text input fill
              await page.evaluate((fieldName, value) => {
                const inputs = document.querySelectorAll('input:not([type="radio"]), textarea');
                for (const input of inputs) {
                  const label = input.closest('div')?.querySelector('label')?.textContent || '';
                  if (label.toLowerCase().includes(fieldName.toLowerCase()) || input.placeholder?.toLowerCase().includes(fieldName.toLowerCase())) {
                    input.value = value;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                  }
                }
                return false;
              }, instruction.field, instruction.value);
            }
            await delay(1000);
            continue;
          }
        }
      } catch (e) {
        console.error('[Final Step] Claude Vision error:', e.message);
        // If vision fails after multiple attempts, give up
        if (stuckCount >= 3) {
          throw new Error(`Formulario atascado después de ${stuckCount} intentos con visión. Verificar manualmente: ${pageContext.url}`);
        }
      }
      continue;
    } else {
      stuckCount = 0; // Reset if page changed
    }
    previousMainText = pageContext.mainText;

    // Check if we already succeeded
    if (pageContext.hasSuccess) {
      console.log('[Final Step] Success detected on page!');
      break;
    }

    // THINK: Check what page we're on and what action to take
    // Check if we're on the confirmation page (URL contains confirmacionSolicitud)
    const currentUrl = pageContext.url;
    if (currentUrl.includes('confirmacionSolicitud')) {
      console.log('[Final Step] ON CONFIRMATION PAGE - looking for Confirmar button');
    }

    const confirmationCheck = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const url = window.location.href;

      // Are we on the confirmation/review page?
      const isConfirmationPage = url.includes('confirmacionSolicitud') ||
                                  bodyText.includes('Revisá y confirmá') ||
                                  (bodyText.includes('Confirmar') && bodyText.includes('Cancelar') && bodyText.includes('Modificar'));

      // Look for "Confirmar" button ANYWHERE on the page (but not in modals)
      const allButtons = document.querySelectorAll('button:not([disabled])');
      const buttonInfo = [];

      for (const btn of allButtons) {
        const text = btn.textContent.trim();
        const inModal = !!btn.closest('.modal, [role="dialog"]');
        const inAccordion = !!btn.closest('.accordion-collapse');
        const classes = btn.className;

        buttonInfo.push({ text, inModal, inAccordion, classes: classes.substring(0, 50) });

        // Found "Confirmar" button (not in modal, not in accordion)
        if (text === 'Confirmar' && !inModal && !inAccordion) {
          return {
            hasConfirmation: true,
            buttonText: 'Confirmar',
            source: 'page',
            isConfirmationPage,
            buttonClasses: classes
          };
        }
      }

      // Also check for buttons inside grupo-botones (specific to confirmation page)
      const grupoBotones = document.querySelector('.grupo-botones');
      if (grupoBotones) {
        const confirmBtn = grupoBotones.querySelector('button.btn-primary');
        if (confirmBtn && confirmBtn.textContent.trim() === 'Confirmar') {
          return {
            hasConfirmation: true,
            buttonText: 'Confirmar',
            source: 'grupo-botones',
            isConfirmationPage,
            buttonClasses: confirmBtn.className
          };
        }
      }

      // PRIORITIZE: Look for "Confirmar" button in the main content (NOT in modals)
      const mainContent = document.querySelector('main, .main-container, [role="main"]');
      if (mainContent) {
        const mainButtons = mainContent.querySelectorAll('button:not([disabled])');
        for (const btn of mainButtons) {
          const text = btn.textContent.trim();
          const inModal = !!btn.closest('.modal, [role="dialog"]');
          const inAccordion = !!btn.closest('.accordion-collapse');

          // Found "Confirmar" in main content (not modal, not accordion) - THIS IS THE ONE
          if (text === 'Confirmar' && !inModal && !inAccordion) {
            return { hasConfirmation: true, buttonText: 'Confirmar', source: 'main-content', isConfirmationPage };
          }
        }
      }

      // Also check for "Sí" button (but NOT in cancellation modal)
      for (const btn of allButtons) {
        const text = btn.textContent.trim();
        const inAccordion = !!btn.closest('.accordion-collapse');
        const inModal = !!btn.closest('.modal, [role="dialog"]');

        // Check if this "Sí" is in a CANCELLATION modal - SKIP IT
        if (text === 'Sí' && inModal) {
          const modal = btn.closest('.modal, [role="dialog"], app-modal-simple');
          const modalText = modal ? modal.innerText : '';
          if (modalText.toLowerCase().includes('cancelar') || modalText.toLowerCase().includes('perderán')) {
            continue; // DON'T click this - it cancels the request!
          }
        }

        // "Sí" button outside accordion and NOT in cancellation modal
        if (text === 'Sí' && !inAccordion && !inModal) {
          return { hasConfirmation: true, buttonText: 'Sí', source: 'standalone', isConfirmationPage };
        }
      }

      return { hasConfirmation: false, isConfirmationPage, allButtons: buttonInfo };
    });

    // Log what we found on the confirmation page
    if (confirmationCheck.isConfirmationPage && !confirmationCheck.hasConfirmation) {
      console.log('[Final Step] ON CONFIRMATION PAGE but no Confirmar button found!');
      console.log('[Final Step] Available buttons:', JSON.stringify(confirmationCheck.allButtons, null, 2));
    }

    if (confirmationCheck.hasConfirmation) {
      console.log(`[Final Step] Found confirmation button: "${confirmationCheck.buttonText}" (${confirmationCheck.source}) - clicking it!`);

      // Use multiple click methods for better reliability
      const clicked = await page.evaluate((btnText) => {
        const buttons = document.querySelectorAll('button:not([disabled])');
        for (const btn of buttons) {
          if (btn.textContent.trim() === btnText) {
            // Multiple click methods
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { success: true, text: btn.textContent.trim() };
          }
        }

        // Also try grupo-botones specifically
        const grupoBotones = document.querySelector('.grupo-botones');
        if (grupoBotones) {
          const confirmBtn = grupoBotones.querySelector('button.btn-primary');
          if (confirmBtn) {
            confirmBtn.click();
            confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { success: true, text: confirmBtn.textContent.trim(), source: 'grupo-botones' };
          }
        }

        return { success: false };
      }, confirmationCheck.buttonText);

      console.log('[Final Step] Confirm button click result:', clicked);
      await delay(3000);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      continue;
    }

    // Ask Claude what to do
    const prompt = `Estás completando un formulario del gobierno de Buenos Aires. Analizá la página y decidí qué hacer.

URL: ${pageContext.url}

ERRORES EN PANTALLA: ${pageContext.errors.length > 0 ? pageContext.errors.join(', ') : 'Ninguno'}

ACCORDIONS/SECCIONES VISIBLES: ${pageContext.visibleAccordions.map(a => a.id).join(', ') || 'Ninguno abierto'}

ÁREA DE BOTONES: ${pageContext.formActionsText || 'No visible'}

CONTENIDO COMPLETO DE LA PÁGINA:
${pageContext.bodyText.substring(0, 2500)}

BOTONES HABILITADOS:
${pageContext.buttons.map(b => `- "${b.text}"`).join('\n')}

¿Qué hacer? Respondé con UN JSON:

1. Si hay errores de validación en pantalla: {"action": "error", "message": "el texto del error"}
2. Si hay accordions abiertos que necesitan completarse: {"action": "fill_accordion", "accordion": "id del accordion"}
3. Si hay botón "Confirmar" visible: {"action": "click_button", "text": "Confirmar"}
4. Si hay botón "Siguiente" y no hay accordions abiertos: {"action": "click_button", "text": "Siguiente"}
5. Si la página dice "éxito", "ingresada", o muestra número de solicitud: {"action": "done", "success": true}
6. Si la página parece atascada (mismo contenido después de click): {"action": "error", "message": "Formulario atascado - verificar manualmente"}

IMPORTANTE: Si ves el mismo contenido que antes, NO sigas clickeando el mismo botón.

Solo el JSON, nada más.`;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      });

      const responseText = response.content[0].text;
      console.log('[Final Step] Claude response:', responseText);

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const action = JSON.parse(jsonMatch[0]);

        if (action.action === 'done') {
          console.log('[Final Step] Complete!');
          break;
        }

        if (action.action === 'click_button') {
          const clicked = await page.evaluate((buttonText) => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              if (btn.textContent.includes(buttonText) && !btn.disabled) {
                btn.click();
                return { clicked: true, text: btn.textContent.trim() };
              }
            }
            return { clicked: false };
          }, action.text);
          console.log(`[Final Step] Clicked button: ${clicked.clicked ? clicked.text : 'NOT FOUND'}`);
          await delay(3000);
          continue;
        }

        if (action.action === 'fill_accordion') {
          console.log(`[Final Step] Need to fill accordion: ${action.accordion}`);
          // Try to click Siguiente in that accordion
          await page.evaluate((accordionId) => {
            const accordion = document.getElementById(accordionId) || document.querySelector(`#${accordionId}`);
            if (accordion) {
              const btn = accordion.querySelector('button');
              if (btn && !btn.disabled) {
                btn.click();
                return true;
              }
            }
            return false;
          }, action.accordion);
          await delay(2000);
          continue;
        }

        if (action.action === 'error') {
          throw new Error(action.message);
        }
      }
    } catch (e) {
      if (e.message && !e.message.includes('API')) {
        throw e;
      }
      console.error('[Final Step] Claude error:', e.message);
    }

    await delay(2000);
  }

  await page.screenshot({ path: 'debug-after-confirm.png', fullPage: true });

  // Check for success and extract solicitud number
  const result = await page.evaluate(() => {
    const pageText = document.body.innerText || '';
    const success = pageText.includes('éxito') || pageText.includes('ingresada');

    // Try to find the solicitud number (format: 01377880/25)
    let solicitudNumber = null;

    // Pattern 1: Look for the specific span with class numeroSolicitud
    const numeroSpan = document.querySelector('.numeroSolicitud, span.numeroSolicitud');
    if (numeroSpan) {
      const text = numeroSpan.textContent.trim();
      if (text.match(/\d+\/\d+/)) {
        solicitudNumber = text;
      }
    }

    // Pattern 2: "Nro de solicitud: 01377880/25" with the /XX suffix
    if (!solicitudNumber) {
      const nroMatch = pageText.match(/Nro\.?\s*de\s*solicitud:?\s*(\d+\/\d+)/i);
      if (nroMatch) {
        solicitudNumber = nroMatch[1];
      }
    }

    // Pattern 3: Match number/year pattern anywhere
    if (!solicitudNumber) {
      const numMatch = pageText.match(/(\d{6,}\/\d{2})/);
      if (numMatch) {
        solicitudNumber = numMatch[1];
      }
    }

    // Pattern 4: Look in the URL (format: 01377880&25 where & was /)
    if (!solicitudNumber) {
      const urlMatch = window.location.href.match(/detalleSolicitud\/(\d+)&(\d+)/i);
      if (urlMatch) {
        solicitudNumber = urlMatch[1] + '/' + urlMatch[2];
      }
    }

    // Fallback: just the number without suffix
    if (!solicitudNumber) {
      const boldElements = document.querySelectorAll('b, strong, .texto-resaltado-color');
      for (const el of boldElements) {
        const text = el.textContent || '';
        const numMatch = text.match(/^(\d{6,}(?:\/\d{2})?)$/);
        if (numMatch) {
          solicitudNumber = numMatch[1];
          break;
        }
      }
    }

    return {
      success,
      solicitudNumber,
      url: window.location.href
    };
  });

  console.log('Submission result:', result);

  if (result.success) {
    console.log(`Solicitud submitted successfully! Number: ${result.solicitudNumber || 'unknown'}`);
  } else {
    console.log('Solicitud may have been submitted, check screenshots');
  }

  return {
    success: result.success,
    solicitudNumber: result.solicitudNumber,
    message: result.success
      ? `Solicitud ${result.solicitudNumber ? '#' + result.solicitudNumber + ' ' : ''}submitted successfully`
      : 'Check debug-after-confirm.png for status',
    url: result.url
  };
}

async function clickSiguiente(page) {
  return page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if (text.includes('Siguiente') && !btn.disabled) {
        btn.click();
        return true;
      }
    }
    return false;
  });
}

async function closeBrowser() {
  if (browser) {
    console.log('Closing browser...');
    try {
      await browser.close();
    } catch (e) {
      console.log('Error closing browser:', e.message);
    }
    browser = null;
    page = null;
    isLoggedIn = false;
    console.log('Browser closed');
  }
}

// Helper function to click accordion button (handles both btn-primary and btn-default)
async function clickAccordionButton(page, accordionSelector) {
  const result = await page.evaluate((selector) => {
    const accordion = document.querySelector(selector);
    if (!accordion) {
      return { skipped: true, reason: 'not found' };
    }

    if (!accordion.classList.contains('show')) {
      return { skipped: true, reason: 'not visible' };
    }

    // Find any Siguiente button (btn-primary, btn-default, btn-sm)
    const buttons = accordion.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if (text.includes('Siguiente')) {
        if (btn.disabled) {
          return { skipped: true, reason: 'button disabled' };
        }
        btn.click();
        return { success: true, text: text.trim() };
      }
    }

    return { skipped: true, reason: 'no Siguiente button' };
  }, accordionSelector);

  return result;
}

async function clickAccordionSiguiente(page, accordionSelector) {
  // Wait for the accordion section to be visible (has class 'show')
  const selectorWithShow = accordionSelector + '.show';
  await page.waitForSelector(selectorWithShow, { timeout: 10000 }).catch(() => {
    console.log(`Accordion ${accordionSelector} may not be visible yet`);
  });

  const result = await page.evaluate((selector) => {
    // Find the accordion section
    const accordion = document.querySelector(selector);
    if (!accordion) {
      return { success: false, error: 'Accordion not found: ' + selector };
    }

    // Find the Siguiente button inside this accordion
    const buttons = accordion.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if (text.includes('Siguiente') && !btn.disabled) {
        console.log('Clicking Siguiente in accordion:', selector);
        btn.click();
        return { success: true, selector };
      }
    }

    // If no button found in accordion, try the accordion-body inside it
    const accordionBody = accordion.querySelector('.accordion-body');
    if (accordionBody) {
      const bodyButtons = accordionBody.querySelectorAll('button');
      for (const btn of bodyButtons) {
        const text = btn.textContent || '';
        if (text.includes('Siguiente') && !btn.disabled) {
          console.log('Clicking Siguiente in accordion-body:', selector);
          btn.click();
          return { success: true, selector, method: 'accordion-body' };
        }
      }
    }

    return { success: false, error: 'No Siguiente button found in accordion' };
  }, accordionSelector);

  console.log(`clickAccordionSiguiente(${accordionSelector}):`, result);
  return result;
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', loggedIn: isLoggedIn });
});

// Login endpoint
app.post('/login', async (req, res) => {
  try {
    const success = await login();
    res.json({ success, message: success ? 'Logged in successfully' : 'Login failed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Normalize address for deduplication
function normalizeAddressForDedup(address) {
  return address
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9]/g, '') // Remove non-alphanumeric
    .trim();
}

// Submit solicitud endpoint
app.post('/solicitud', async (req, res) => {
  const { address, containerType, description, photos, reportType, schedule } = req.body;

  if (!address) {
    return res.status(400).json({ success: false, error: 'Address is required' });
  }

  console.log(`API received: address="${address}", reportType="${reportType || 'recoleccion'}"${schedule ? `, schedule="${schedule}"` : ''}`);

  // Deduplication check - prevent submitting same address twice
  const normalizedAddr = normalizeAddressForDedup(address);
  const recent = recentSubmissions.get(normalizedAddr);
  if (recent && (Date.now() - recent.timestamp) < SUBMISSION_DEDUP_MS) {
    console.log(`[DEDUP] Blocking duplicate submission for "${address}" (submitted ${Math.round((Date.now() - recent.timestamp) / 1000)}s ago as #${recent.solicitudNumber})`);
    return res.json({
      success: true,
      solicitudNumber: recent.solicitudNumber,
      message: `Ya se envió esta solicitud hace menos de 5 minutos (#${recent.solicitudNumber})`,
      duplicate: true
    });
  }

  // Per-address locking - wait if another submission for same address is in progress
  if (submissionLocks.has(normalizedAddr)) {
    console.log(`[LOCK] Waiting for in-progress submission for "${address}"...`);
    try {
      const existingResult = await submissionLocks.get(normalizedAddr);
      if (existingResult && existingResult.success) {
        console.log(`[LOCK] Returning result from concurrent submission: #${existingResult.solicitudNumber}`);
        return res.json({ ...existingResult, duplicate: true });
      }
    } catch (e) {
      console.log(`[LOCK] Previous submission failed, proceeding with new one`);
    }
  }

  // Create a promise for this submission that others can wait on
  let resolveSubmission;
  const submissionPromise = new Promise(resolve => { resolveSubmission = resolve; });
  submissionLocks.set(normalizedAddr, submissionPromise);

  // Retry logic: if first attempt fails, close browser and try once more with fresh session
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`\n=== RETRY ATTEMPT ${attempt}/${maxAttempts} with fresh browser session ===\n`);
      }

      const result = await submitSolicitud({ address, containerType, description, photos, reportType, schedule });

      // Close browser after successful submission
      await closeBrowser();

      // Record successful submission for deduplication
      if (result.success && result.solicitudNumber) {
        recentSubmissions.set(normalizedAddr, {
          timestamp: Date.now(),
          solicitudNumber: result.solicitudNumber
        });
        console.log(`[DEDUP] Recorded submission for "${address}" -> #${result.solicitudNumber}`);
      }

      // Resolve for any waiting concurrent requests
      resolveSubmission(result);
      submissionLocks.delete(normalizedAddr);

      return res.json(result);
    } catch (error) {
      console.error(`Error on attempt ${attempt}:`, error.message);
      lastError = error;

      // Close browser before retry or final failure
      await closeBrowser();

      // Only retry for specific errors that might be fixed by a fresh session
      const isAddressError = error.message.includes('No address suggestions found') ||
                             error.message.includes('Address input not found');

      if (attempt < maxAttempts && isAddressError) {
        console.log('Retrying with fresh browser session...');
        await new Promise(r => setTimeout(r, 3000)); // Longer delay before retry
      } else {
        // Improve error message for address-related errors
        if (isAddressError) {
          lastError = new Error(`No pudimos encontrar la dirección "${address}". Verificá que esté bien escrita y volvé a intentar.`);
        }
        break;
      }
    }
  }

  // Cleanup lock on failure
  resolveSubmission(null);
  submissionLocks.delete(normalizedAddr);

  res.status(500).json({ success: false, error: lastError.message });
});

// Cleanup endpoint
app.post('/cleanup', async (req, res) => {
  await closeBrowser();
  res.json({ success: true, message: 'Browser closed' });
});

// Kill any existing process on the port (works on Mac and Linux)
function killExistingProcess(port) {
  try {
    // Try lsof first (works on Mac and most Linux)
    const pid = execSync(`lsof -ti:${port} 2>/dev/null || true`).toString().trim();
    if (pid) {
      console.log(`Killing existing process on port ${port} (PID: ${pid})...`);
      execSync(`kill -9 ${pid} 2>/dev/null || true`);
      // Brief delay to let the port free up
      execSync('sleep 0.5');
    }
  } catch (e) {
    // Try fuser as fallback (Linux)
    try {
      execSync(`fuser -k ${port}/tcp 2>/dev/null || true`);
    } catch (e2) {
      // Ignore errors - port may not be in use
    }
  }
}

// Kill any existing process before starting
killExistingProcess(PORT);

// Start server
app.listen(PORT, () => {
  console.log(`
==============================================
  BA Colaborativa Solicitud API Server
==============================================

Server running on http://localhost:${PORT}

Available endpoints:

  GET  /health     - Check server status
  POST /login      - Login to BA Colaborativa
  POST /solicitud  - Submit a solicitud
  POST /cleanup    - Close browser instance

Example usage:

  # Login
  curl -X POST http://localhost:${PORT}/login

  # Submit solicitud
  curl -X POST http://localhost:${PORT}/solicitud \\
    -H "Content-Type: application/json" \\
    -d '{"address": "Pasteur 415", "containerType": "negro"}'

  # Cleanup
  curl -X POST http://localhost:${PORT}/cleanup

==============================================
`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});
