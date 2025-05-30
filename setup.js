#!/usr/bin/env node

/**
 * AI Caller Setup and Test Script
 * Helps configure and test your Railway deployment
 */

import dotenv from 'dotenv';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

const required_vars = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID', 
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER'
];

function checkEnvironmentVariables() {
  console.log('🔍 Checking environment variables...\n');
  
  const missing = [];
  required_vars.forEach(varName => {
    const value = process.env[varName];
    if (!value) {
      missing.push(varName);
      console.log(`❌ ${varName}: MISSING`);
    } else {
      const masked = value.length > 8 
        ? value.substring(0, 4) + '...' + value.substring(value.length - 4)
        : '****';
      console.log(`✅ ${varName}: ${masked}`);
    }
  });

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing ${missing.length} required environment variables:`);
    missing.forEach(varName => console.log(`   - ${varName}`));
    console.log('\n📝 Add these to your .env file or Railway environment variables');
    return false;
  }

  console.log('\n✅ All environment variables are configured!\n');
  return true;
}

async function testElevenLabsAPI() {
  console.log('🎤 Testing ElevenLabs API...');
  
  try {
    // Test voice generation with a simple request
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: "Test message for setup verification",
        model_id: "eleven_flash_v2_5"
      })
    });

    if (response.ok) {
      console.log('✅ ElevenLabs API: Connected successfully');
      return true;
    } else {
      const error = await response.text();
      console.log(`❌ ElevenLabs API: ${response.status} ${response.statusText}`);
      console.log(`   Error: ${error}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ ElevenLabs API: ${error.message}`);
    return false;
  }
}

async function testTwilioAPI() {
  console.log('📞 Testing Twilio API...');
  
  try {
    // Test Twilio connection by validating credentials
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}.json`, {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });

    if (response.ok) {
      const account = await response.json();
      console.log('✅ Twilio API: Connected successfully');
      console.log(`   Account: ${account.friendly_name || account.sid}`);
      console.log(`   Status: ${account.status}`);
      return true;
    } else {
      console.log(`❌ Twilio API: ${response.status} ${response.statusText}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Twilio API: ${error.message}`);
    return false;
  }
}

async function testLocalServer() {
  console.log('🖥️  Testing local server...');
  
  try {
    const response = await fetch('http://localhost:8000/optimization-status');
    
    if (response.ok) {
      const status = await response.json();
      console.log('✅ Local server: Running successfully');
      console.log(`   Cached greetings: ${status.greetingCache?.totalPersonalizedCached || 0}`);
      console.log(`   Expected latency (cached): ${status.recommendations?.expectedLatency?.cachedNames || 'N/A'}`);
      return true;
    } else {
      console.log(`❌ Local server: ${response.status} ${response.statusText}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Local server: Not running or not accessible`);
    console.log(`   Start with: node index.js`);
    return false;
  }
}

function printDeploymentInstructions() {
  console.log('\n🚀 Ready for Railway Deployment!\n');
  console.log('Next steps:');
  console.log('1. Push your code to GitHub');
  console.log('2. Connect GitHub repo to Railway at https://railway.app');
  console.log('3. Add environment variables in Railway dashboard');
  console.log('4. Deploy and get your public URL');
  console.log('\nDetailed instructions: See RAILWAY_DEPLOYMENT.md\n');
}

function printIntegrationExamples() {
  console.log('🔗 Integration Examples:\n');
  
  console.log('JavaScript/Node.js:');
  console.log('```javascript');
  console.log('const AICallerIntegration = require("./integration-helper.js");');
  console.log('const caller = new AICallerIntegration("https://your-app.up.railway.app");');
  console.log('');
  console.log('const result = await caller.makeCall({');
  console.log('  name: "John Doe",');
  console.log('  number: "+1234567890"');
  console.log('});');
  console.log('```\n');

  console.log('cURL:');
  console.log('```bash');
  console.log('curl -X POST https://your-app.up.railway.app/outbound-call \\');
  console.log('  -H "Content-Type: application/json" \\');
  console.log('  -d \'{"name": "John Doe", "number": "+1234567890"}\'');
  console.log('```\n');

  console.log('Zapier Webhook URL:');
  console.log('https://your-app.up.railway.app/outbound-call\n');
}

async function main() {
  console.log('🤖 AI Caller Setup & Test Tool\n');
  console.log('=' * 50);
  
  // Check environment variables
  const envOk = checkEnvironmentVariables();
  if (!envOk) {
    process.exit(1);
  }

  // Test APIs
  console.log('🧪 Testing API connections...\n');
  const elevenLabsOk = await testElevenLabsAPI();
  const twilioOk = await testTwilioAPI();
  const serverOk = await testLocalServer();

  console.log('\n' + '=' * 50);
  
  if (elevenLabsOk && twilioOk) {
    console.log('🎉 All API connections successful!');
    
    if (serverOk) {
      console.log('✅ System is ready for production deployment');
      printDeploymentInstructions();
    } else {
      console.log('⚠️  Start local server to test full functionality');
      console.log('   Run: node index.js');
    }
    
    printIntegrationExamples();
    
  } else {
    console.log('❌ Some API connections failed');
    console.log('   Please check your environment variables and API keys');
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export default main; 