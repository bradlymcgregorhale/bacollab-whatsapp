import puppeteer from 'puppeteer';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

// Store browser instance for reuse
let browser = null;
let page = null;
let isLoggedIn = false;

const URLS = {
  prestaciones: 'https://bacolaborativa.buenosaires.gob.ar/prestaciones',
  recoleccionResiduos: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/1462821007742',
  mejoraBarrido: 'https://bacolaborativa.buenosaires.gob.ar/confirmacion/096059',
  ubicacion: 'https://bacolaborativa.buenosaires.gob.ar/ubicacion'
};

// Report types
const REPORT_TYPES = {
  recoleccion: 'recoleccionResiduos',  // Trash around containers
  barrido: 'mejoraBarrido'              // Dirt/trash on street/curbs
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

async function initBrowser() {
  if (!browser) {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: process.platform === 'linux' ? 'new' : false,
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
  const { address, containerType = 'negro', description = '', reportType = 'recoleccion' } = data;

  if (!isLoggedIn) {
    const loginSuccess = await login();
    if (!loginSuccess) {
      throw new Error('Login failed');
    }
  }

  const { page } = await initBrowser();

  // Determine which URL to use based on report type
  const urlKey = REPORT_TYPES[reportType] || 'recoleccionResiduos';
  const targetUrl = URLS[urlKey];
  const reportTypeName = reportType === 'barrido' ? 'Mejora de barrido' : 'Recolección de residuos';

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
  console.log('Waiting for address input to appear...');
  try {
    await page.waitForSelector('ng-autocomplete input, input[placeholder*="Lugar"], input[role="combobox"]', {
      timeout: 15000,
      visible: true
    });
    console.log('Address input selector found');
  } catch (e) {
    console.log('Timeout waiting for address input selector');
  }

  await delay(1000); // Brief delay for Angular to finish binding

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

  // Step 6 & 7: Only for 'recoleccion' type - fill questionnaire and click Siguiente
  if (reportType === 'recoleccion') {
    console.log('Step 6: Selecting container type...');

    await page.screenshot({ path: 'debug-questionnaire.png', fullPage: true });

    // Click the radio button for container type
    const radioClicked = await page.evaluate((type) => {
      // Try clicking the label directly (more reliable)
      const labels = document.querySelectorAll('label.form-radio-label');
      for (const label of labels) {
        const text = label.textContent || '';
        if (type === 'verde' && text.includes('reciclables')) {
          label.click();
          return { success: true, text };
        }
        if (type === 'negro' && text.includes('húmedos')) {
          label.click();
          return { success: true, text };
        }
      }
      // Fallback to radio button IDs
      const radioId = type === 'verde' ? 'respuesta45731' : 'respuesta45732';
      const radio = document.getElementById(radioId);
      if (radio) {
        radio.click();
        return { success: true, method: 'radio id' };
      }
      return { success: false };
    }, containerType);

    console.log('Radio click result:', radioClicked);
    await delay(1000);

    // Step 7: Click Siguiente inside the questionnaire accordion
    console.log('Step 7: Clicking Siguiente in questionnaire section...');
    await clickAccordionSiguiente(page, '#collapseCuestionario');
    await delay(2000);
  } else {
    console.log('Step 6-7: Skipping questionnaire (not required for barrido)');
  }

  // Step 8: Description section - click Siguiente inside that accordion
  console.log('Step 8: Clicking Siguiente in description section...');
  await page.screenshot({ path: 'debug-description.png', fullPage: true });
  await clickAccordionSiguiente(page, '#collapseDescribirSituacion');
  await delay(2000);

  // Step 9: Photos section - upload photos if provided, then click Siguiente
  console.log('Step 9: Handling photos section...');
  await page.screenshot({ path: 'debug-photos.png', fullPage: true });

  // Upload photos if provided
  if (data.photos && data.photos.length > 0) {
    console.log(`Uploading ${data.photos.length} photo(s)...`);

    for (let i = 0; i < Math.min(data.photos.length, 3); i++) {
      const photoPath = data.photos[i];
      console.log(`  Uploading photo ${i + 1}: ${photoPath}`);

      try {
        // Find the file input (there are multiple, get the first available one)
        const fileInputs = await page.$$('input[type="file"]#file-upload');
        if (fileInputs.length > i) {
          await fileInputs[i].uploadFile(photoPath);
          console.log(`  Photo ${i + 1} uploaded`);
          await delay(2000); // Wait for upload to process
        }
      } catch (uploadError) {
        console.log(`  Failed to upload photo ${i + 1}:`, uploadError.message);
      }
    }

    await page.screenshot({ path: 'debug-after-photo-upload.png', fullPage: true });
  }

  await clickAccordionSiguiente(page, '#collapseFotos');
  await delay(2000);

  // Step 10: Contact section is last - now click the main Siguiente at bottom
  console.log('Step 10: Clicking main Siguiente button (form-actions)...');
  await page.screenshot({ path: 'debug-contact.png', fullPage: true });

  // Wait for contact section to be visible
  await page.waitForSelector('#collapseSolicitudContacto.show', { timeout: 10000 }).catch(() => {
    console.log('Contact section may already be visible or skipped');
  });

  // Click the main Siguiente button at the bottom (.form-actions)
  const mainSiguienteClicked = await page.evaluate(() => {
    // Target specifically the form-actions container at the bottom
    const formActions = document.querySelector('.form-actions.mt-50');
    if (formActions) {
      const btn = formActions.querySelector('button.btn-primary');
      if (btn && btn.textContent.includes('Siguiente')) {
        console.log('Found main Siguiente button in form-actions');
        btn.click();
        return { success: true, method: 'form-actions' };
      }
    }

    // Fallback: find the Siguiente button that's NOT inside an accordion
    const allButtons = document.querySelectorAll('button.btn-primary');
    for (const btn of allButtons) {
      const text = btn.textContent || '';
      if (text.includes('Siguiente')) {
        // Check if it's inside an accordion-body (skip those)
        const isInAccordion = btn.closest('.accordion-body');
        if (!isInAccordion) {
          console.log('Found Siguiente button outside accordion');
          btn.click();
          return { success: true, method: 'fallback' };
        }
      }
    }
    return { success: false };
  });

  console.log('Main Siguiente click result:', mainSiguienteClicked);

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
    console.log('Navigation timeout after main Siguiente');
  });
  await delay(3000);

  await page.screenshot({ path: 'debug-after-form.png', fullPage: true });

  // Step 11: Confirmation page - click "Confirmar"
  console.log('Step 11: Final confirmation...');
  await page.screenshot({ path: 'debug-before-confirm.png', fullPage: true });

  const confirmed = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button.btn-primary');
    for (const btn of buttons) {
      if ((btn.textContent || '').includes('Confirmar')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!confirmed) {
    throw new Error('Could not find final Confirmar button');
  }

  // Wait for success modal or redirect
  await delay(5000);
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

// Submit solicitud endpoint
app.post('/solicitud', async (req, res) => {
  const { address, containerType, description, photos, reportType } = req.body;

  if (!address) {
    return res.status(400).json({ success: false, error: 'Address is required' });
  }

  console.log(`API received: address="${address}", reportType="${reportType || 'recoleccion'}"`);

  // Retry logic: if first attempt fails, close browser and try once more with fresh session
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`\n=== RETRY ATTEMPT ${attempt}/${maxAttempts} with fresh browser session ===\n`);
      }

      const result = await submitSolicitud({ address, containerType, description, photos, reportType });

      // Close browser after successful submission
      await closeBrowser();

      return res.json(result);
    } catch (error) {
      console.error(`Error on attempt ${attempt}:`, error.message);
      lastError = error;

      // Close browser before retry or final failure
      await closeBrowser();

      // Only retry for specific errors that might be fixed by a fresh session
      if (attempt < maxAttempts && error.message.includes('No address suggestions found')) {
        console.log('Retrying with fresh browser session...');
        await new Promise(r => setTimeout(r, 2000)); // Brief delay before retry
      } else {
        break;
      }
    }
  }

  res.status(500).json({ success: false, error: lastError.message });
});

// Cleanup endpoint
app.post('/cleanup', async (req, res) => {
  await closeBrowser();
  res.json({ success: true, message: 'Browser closed' });
});

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
