import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Apply stealth plugin to avoid bot detection
puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// X/Twitter credentials
const X_USERNAME = 'onceordenado';
const X_PASSWORD = 'VillaSur87*';

// Session storage
const USER_DATA_DIR = path.join(__dirname, '.x-browser-data');

// Configuration - set to true for production/headless
const HEADLESS_MODE = process.env.X_HEADLESS === 'true' || false;

// Browser instance for reuse
let xBrowser = null;
let xPage = null;
let isXLoggedIn = false;

// Report type labels in Spanish
const REPORT_TYPE_LABELS = {
  recoleccion: 'recolección de residuos',
  barrido: 'mejora de barrido',
  obstruccion: 'obstrucción de vereda',
  ocupacion_comercial: 'ocupación por local comercial',
  ocupacion_gastronomica: 'ocupación gastronómica',
  manteros: 'vendedores ambulantes'
};

// Human-like delay with randomization
function delay(ms) {
  const variance = ms * 0.3; // 30% variance
  const randomDelay = ms + (Math.random() * variance * 2 - variance);
  return new Promise(resolve => setTimeout(resolve, randomDelay));
}

// Simulate human-like typing with variable speed
async function humanType(page, text, selector = null) {
  if (selector) {
    await page.click(selector);
    await delay(200);
  }

  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    // Occasional longer pause (like thinking)
    if (Math.random() < 0.1) {
      await delay(200 + Math.random() * 300);
    }
  }
}

// Simulate mouse movement to an element before clicking
async function humanClick(page, selector) {
  const element = await page.$(selector);
  if (!element) return false;

  const box = await element.boundingBox();
  if (!box) return false;

  // Move to element with some randomness
  const x = box.x + box.width / 2 + (Math.random() * 10 - 5);
  const y = box.y + box.height / 2 + (Math.random() * 10 - 5);

  await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 10) });
  await delay(100 + Math.random() * 200);
  await page.mouse.click(x, y);

  return true;
}

// Random scroll to simulate reading
async function humanScroll(page) {
  const scrollAmount = 100 + Math.random() * 300;
  await page.evaluate((amount) => {
    window.scrollBy({ top: amount, behavior: 'smooth' });
  }, scrollAmount);
  await delay(500 + Math.random() * 500);
}

async function initXBrowser() {
  if (xBrowser) {
    try {
      const pages = await xBrowser.pages();
      if (pages.length > 0) {
        return { browser: xBrowser, page: xPage };
      }
    } catch (e) {
      console.log('[X] Browser disconnected, reinitializing...');
    }
  }

  console.log('[X] Launching stealth browser for X/Twitter...');
  console.log('[X] Headless mode:', HEADLESS_MODE);

  // Clean up any old data that might be corrupted
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const isLinux = process.platform === 'linux';

  // Browser launch options
  const launchOptions = {
    // Use 'new' headless mode which is harder to detect than old headless
    // Set to false for first-time login (to complete any captchas manually)
    headless: HEADLESS_MODE ? 'new' : false,
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900',
      '--start-maximized',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-pings'
    ],
    userDataDir: USER_DATA_DIR,
    ignoreDefaultArgs: ['--enable-automation']
  };

  // Linux-specific settings
  if (isLinux) {
    launchOptions.args.push(
      '--disable-gpu',
      '--single-process',
      '--no-zygote'
    );
    console.log('[X] Running on Linux - added Linux-specific flags');
  }

  xBrowser = await puppeteer.launch(launchOptions);

  const pages = await xBrowser.pages();
  xPage = pages.length > 0 ? pages[0] : await xBrowser.newPage();

  // Set a realistic viewport
  await xPage.setViewport({
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    hasTouch: false,
    isLandscape: true,
    isMobile: false
  });

  // Set realistic user agent
  await xPage.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Set extra headers
  await xPage.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
  });

  return { browser: xBrowser, page: xPage };
}

async function isLoggedInToX(page) {
  try {
    console.log('[X] Checking login status...');
    await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

    const url = page.url();
    console.log('[X] Current URL:', url);

    // If redirected to login, not logged in
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      console.log('[X] Not logged in (redirected to login)');
      return false;
    }

    // Check for compose tweet button or home timeline
    const isLoggedIn = await page.evaluate(() => {
      const composeTweet = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
      const homeTimeline = document.querySelector('[data-testid="primaryColumn"]');
      const tweetButton = document.querySelector('[data-testid="tweetButtonInline"]');
      return !!(composeTweet || homeTimeline || tweetButton);
    });

    if (isLoggedIn) {
      console.log('[X] Already logged in!');
      isXLoggedIn = true;
      return true;
    }

    console.log('[X] Not logged in');
    return false;
  } catch (e) {
    console.log('[X] Error checking login status:', e.message);
    return false;
  }
}

async function loginToX(page) {
  console.log('[X] Starting login process...');

  try {
    await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000 + Math.random() * 2000);

    // Take screenshot to see what loaded
    await page.screenshot({ path: 'debug-x-page-loaded.png' });
    console.log('[X] Screenshot saved: debug-x-page-loaded.png');

    // Log page content for debugging
    const pageContent = await page.evaluate(() => {
      return {
        title: document.title,
        bodyText: document.body?.innerText?.substring(0, 500) || 'no body',
        hasLoginForm: !!document.querySelector('input'),
        inputs: Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type,
          name: i.name,
          autocomplete: i.autocomplete
        }))
      };
    });
    console.log('[X] Page content:', JSON.stringify(pageContent, null, 2));

    // Random scroll to appear human
    await humanScroll(page);

    // Step 1: Enter username
    console.log('[X] Step 1: Entering username...');

    // Wait for and find the username input
    await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
    await delay(1000 + Math.random() * 1000);

    // Click and type username with human-like behavior
    const usernameInput = await page.$('input[autocomplete="username"]');
    if (!usernameInput) {
      console.log('[X] Could not find username input');
      return false;
    }

    await usernameInput.click();
    await delay(500);
    await humanType(page, X_USERNAME);
    await delay(1000 + Math.random() * 500);

    // Click Next button
    console.log('[X] Clicking Next...');
    const nextClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent || '';
        if (text.includes('Next') || text.includes('Siguiente')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!nextClicked) {
      await page.keyboard.press('Enter');
    }

    await delay(3000 + Math.random() * 2000);

    // Step 2: Check for verification challenge
    console.log('[X] Checking for verification challenges...');
    const verificationInput = await page.$('input[data-testid="ocfEnterTextTextInput"]');
    if (verificationInput) {
      console.log('[X] Verification required - please complete manually in browser');
      // Wait for user to complete verification
      await delay(30000);
    }

    // Step 3: Enter password
    console.log('[X] Step 2: Looking for password field...');

    // Wait for password field
    let passwordInput = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      passwordInput = await page.$('input[type="password"]');
      if (passwordInput) break;

      console.log(`[X] Waiting for password field... (${attempt + 1}/15)`);
      await delay(2000);

      // Check if we're on a different verification screen
      const currentUrl = page.url();
      if (!currentUrl.includes('login') && !currentUrl.includes('flow')) {
        console.log('[X] Navigated away from login - might be logged in?');
        break;
      }
    }

    if (!passwordInput) {
      // Take screenshot for debugging
      await page.screenshot({ path: 'debug-x-no-password.png' });
      console.log('[X] Could not find password field. Screenshot saved.');

      // Check if we somehow got logged in
      const url = page.url();
      if (url.includes('/home')) {
        console.log('[X] Appears to be logged in!');
        isXLoggedIn = true;
        return true;
      }

      console.log('[X] Login failed - password field not found');
      return false;
    }

    // Enter password with human-like behavior
    console.log('[X] Entering password...');
    await passwordInput.click();
    await delay(500);
    await humanType(page, X_PASSWORD);
    await delay(1000 + Math.random() * 500);

    // Click Log in button
    console.log('[X] Clicking Log in...');
    const loginClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent || '';
        if (text.includes('Log in') || text.includes('Iniciar sesión')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!loginClicked) {
      await page.keyboard.press('Enter');
    }

    await delay(5000 + Math.random() * 3000);

    // Check result
    const finalUrl = page.url();
    console.log('[X] Final URL:', finalUrl);

    if (finalUrl.includes('/home') || (!finalUrl.includes('/login') && !finalUrl.includes('/flow'))) {
      console.log('[X] Login successful!');
      isXLoggedIn = true;
      return true;
    }

    // Maybe there's 2FA
    console.log('[X] Login may require additional verification');
    console.log('[X] Please complete any verification in the browser...');
    await delay(30000);

    // Check again
    const url2 = page.url();
    if (url2.includes('/home') || (!url2.includes('/login') && !url2.includes('/flow'))) {
      console.log('[X] Login successful after verification!');
      isXLoggedIn = true;
      return true;
    }

    await page.screenshot({ path: 'debug-x-login-failed.png' });
    console.log('[X] Login failed. Screenshot saved.');
    return false;

  } catch (e) {
    console.log('[X] Login error:', e.message);
    await page.screenshot({ path: 'debug-x-login-error.png' });
    return false;
  }
}

async function ensureLoggedIn() {
  const { page } = await initXBrowser();

  if (isXLoggedIn) {
    return true;
  }

  const loggedIn = await isLoggedInToX(page);
  if (loggedIn) {
    return true;
  }

  return await loginToX(page);
}

/**
 * Post a tweet to X with photo and text
 */
export async function postToX({ address, reportType, solicitudNumber, photoPath }) {
  console.log('\n[X] Posting to X/Twitter...');
  console.log(`[X] Address: ${address}`);
  console.log(`[X] Type: ${reportType}`);
  console.log(`[X] Case #: ${solicitudNumber}`);
  console.log(`[X] Photo: ${photoPath}`);

  try {
    const loggedIn = await ensureLoggedIn();
    if (!loggedIn) {
      return { success: false, error: 'Could not log in to X' };
    }

    const { page } = await initXBrowser();

    // Navigate to compose
    console.log('[X] Opening compose dialog...');
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000 + Math.random() * 2000);

    // Wait for tweet textarea
    let tweetTextarea = await page.$('[data-testid="tweetTextarea_0"]');
    if (!tweetTextarea) {
      // Try clicking the compose button
      const composeBtn = await page.$('[data-testid="SideNav_NewTweet_Button"]');
      if (composeBtn) {
        await humanClick(page, '[data-testid="SideNav_NewTweet_Button"]');
        await delay(2000);
      }
      tweetTextarea = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    }

    // Build tweet text
    const reportLabel = REPORT_TYPE_LABELS[reportType] || 'recolección de residuos';
    const tweetText = `${address} - ${reportLabel}
${solicitudNumber}
@ibaistrocchi
@jorgemacri`;

    console.log('[X] Typing tweet...');
    await tweetTextarea.click();
    await delay(500);
    await humanType(page, tweetText);
    await delay(1500);

    // Upload photo
    if (photoPath && fs.existsSync(photoPath)) {
      console.log('[X] Uploading photo...');
      const fileInput = await page.$('input[data-testid="fileInput"]');
      if (fileInput) {
        await fileInput.uploadFile(photoPath);
        console.log('[X] Photo uploaded, waiting for processing...');
        await delay(5000 + Math.random() * 3000);

        // Wait for media to be attached
        const mediaAttached = await page.$('[data-testid="attachments"]');
        if (mediaAttached) {
          console.log('[X] Photo attached successfully');
        }
      } else {
        console.log('[X] Could not find file input');
      }
    }

    await delay(3000);

    // Take screenshot before posting
    await page.screenshot({ path: 'debug-x-before-post.png' });
    console.log('[X] Screenshot saved: debug-x-before-post.png');

    // Find and click the Post button - X uses a specific button structure
    console.log('[X] Looking for Post button...');

    // Wait a bit more for everything to settle
    await delay(2000);

    // Click Post button - try multiple approaches
    console.log('[X] Clicking Post button...');

    // Method 1: Click by data-testid
    let clicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="tweetButtonInline"]');
      if (btn) {
        console.log('Found button by testid');
        btn.click();
        return { method: 'testid', clicked: true };
      }
      return { method: 'testid', clicked: false };
    });
    console.log('[X] Method 1 (testid):', clicked);

    await delay(1000);

    // Method 2: Click by button text content
    if (!clicked.clicked) {
      clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (text === 'Post') {
            btn.click();
            return { method: 'text', clicked: true };
          }
        }
        return { method: 'text', clicked: false };
      });
      console.log('[X] Method 2 (text):', clicked);
    }

    await delay(1000);

    // Method 3: Use Puppeteer's click on the element
    try {
      const postBtn = await page.$('[data-testid="tweetButtonInline"]');
      if (postBtn) {
        await postBtn.click();
        console.log('[X] Method 3 (puppeteer click): clicked');
      }
    } catch (e) {
      console.log('[X] Method 3 error:', e.message);
    }

    await delay(1000);

    // Method 4: Keyboard shortcut (Ctrl+Enter to post)
    console.log('[X] Method 4: Trying Ctrl+Enter...');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');

    // Also try Cmd+Enter for Mac
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');

    console.log('[X] All click methods attempted');

    // Wait for post to complete
    await delay(5000 + Math.random() * 3000);

    // Take screenshot after clicking
    await page.screenshot({ path: 'debug-x-after-post.png' });
    console.log('[X] Screenshot saved: debug-x-after-post.png');

    // Check for success - look for confirmation or URL change
    const currentUrl = page.url();
    console.log('[X] Current URL after post:', currentUrl);

    // Check if compose dialog closed
    const dialogStillOpen = await page.$('[data-testid="tweetTextarea_0"]');
    if (!dialogStillOpen) {
      console.log('[X] Compose dialog closed - tweet posted!');
      return { success: true };
    }

    // Check for toast message
    const toast = await page.$('[data-testid="toast"]');
    if (toast) {
      const toastText = await page.evaluate(el => el.textContent, toast);
      console.log('[X] Toast message:', toastText);
      if (toastText.toLowerCase().includes('sent') || toastText.toLowerCase().includes('posted') || toastText.toLowerCase().includes('your post')) {
        return { success: true };
      }
    }

    // Check if textarea is now empty (tweet was sent)
    const textareaEmpty = await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
      return textarea ? textarea.textContent.trim() === '' : true;
    });

    if (textareaEmpty) {
      console.log('[X] Textarea is empty - tweet likely posted');
      return { success: true };
    }

    console.log('[X] Could not confirm tweet was posted');
    return { success: false, error: 'Could not confirm post' };

  } catch (error) {
    console.error('[X] Error posting:', error.message);
    return { success: false, error: error.message };
  }
}

export async function closeXBrowser() {
  if (xBrowser) {
    try {
      await xBrowser.close();
    } catch (e) {
      console.log('[X] Error closing browser:', e.message);
    }
    xBrowser = null;
    xPage = null;
    isXLoggedIn = false;
  }
}

export async function initXPoster() {
  console.log('[X] Initializing X poster with stealth mode...');
  try {
    const loggedIn = await ensureLoggedIn();
    if (loggedIn) {
      console.log('[X] X poster ready!');
      return true;
    } else {
      console.log('[X] X poster not logged in');
      return false;
    }
  } catch (e) {
    console.error('[X] Error initializing:', e.message);
    return false;
  }
}

export default { postToX, closeXBrowser, initXPoster };
