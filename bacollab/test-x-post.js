import { postToX, initXPoster, closeXBrowser } from './x-poster.js';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function testXPost() {
  console.log('=== Testing X/Twitter Post (Stealth Mode) ===\n');

  // Test data
  const testData = {
    address: 'Tucuman 1000',
    reportType: 'recoleccion',
    solicitudNumber: '01433372/25',
    photoPath: path.join(__dirname, 'photos', '115182600765459_lid_1765735444519.jpeg')
  };

  console.log('Test data:');
  console.log('  Address:', testData.address);
  console.log('  Report type:', testData.reportType);
  console.log('  Case #:', testData.solicitudNumber);
  console.log('  Photo:', testData.photoPath);
  console.log('');

  try {
    // Initialize with stealth browser
    console.log('Initializing X poster with stealth mode...');
    let initResult = await initXPoster();
    console.log('Init result:', initResult);

    if (!initResult) {
      console.log('\n========================================');
      console.log('  LOGIN REQUIRED');
      console.log('========================================');
      console.log('Please log in to X in the browser window.');
      console.log('The stealth plugin should help avoid detection.');
      console.log('');

      await prompt('Press Enter after you have logged in...');

      // Check again
      console.log('\nVerifying login...');
      initResult = await initXPoster();

      if (!initResult) {
        console.log('Still not logged in.');
        await prompt('Press Enter to try posting anyway, or Ctrl+C to exit...');
      }
    }

    // Post the tweet
    console.log('\n========================================');
    console.log('  POSTING TO X');
    console.log('========================================');
    const result = await postToX(testData);

    console.log('\n=== Result ===');
    console.log(result);

    if (result.success) {
      console.log('\nTweet posted successfully!');
    } else {
      console.log('\nFailed to post tweet:', result.error);
    }

  } catch (error) {
    console.error('Error:', error);
  }

  // Keep browser open for 10 seconds to see the result
  console.log('\nKeeping browser open for 10 seconds...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // Close browser
  await closeXBrowser();
  console.log('\nDone!');
}

testXPost();
