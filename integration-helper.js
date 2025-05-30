/**
 * AI Caller Integration Helper
 * Easy integration with your existing workflow
 */

class AICallerIntegration {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Initiate an outbound call
   * @param {Object} options - Call options
   * @param {string} options.name - Customer name
   * @param {string} options.number - Phone number (+1234567890 format)
   * @param {string} [options.airtableRecordId] - Optional Airtable record ID
   * @returns {Promise<Object>} Call result
   */
  async makeCall({ name, number, airtableRecordId }) {
    try {
      const response = await fetch(`${this.baseUrl}/outbound-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          number,
          airtableRecordId
        })
      });

      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      return {
        success: true,
        callSid: result.callSid,
        optimizations: result.optimizations,
        message: result.message
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * End an active call
   * @param {string} callSid - Twilio call SID
   * @returns {Promise<Object>} End call result
   */
  async endCall(callSid) {
    try {
      const response = await fetch(`${this.baseUrl}/end-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ callSid })
      });

      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get optimization status and performance metrics
   * @returns {Promise<Object>} Status information
   */
  async getStatus() {
    try {
      const response = await fetch(`${this.baseUrl}/optimization-status`);
      return await response.json();
    } catch (error) {
      return {
        error: error.message
      };
    }
  }

  /**
   * Batch process multiple calls
   * @param {Array<Object>} calls - Array of call objects
   * @param {number} [delay=1000] - Delay between calls in ms
   * @returns {Promise<Array>} Results array
   */
  async makeMultipleCalls(calls, delay = 1000) {
    const results = [];
    
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      console.log(`Making call ${i + 1}/${calls.length} to ${call.name} (${call.number})`);
      
      const result = await this.makeCall(call);
      results.push({
        ...result,
        originalCall: call,
        index: i
      });

      // Add delay between calls to prevent overwhelming the system
      if (i < calls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return results;
  }

  /**
   * Check if a name is pre-cached for instant audio delivery
   * @param {string} name - Customer name to check
   * @returns {Promise<boolean>} Whether the name is cached
   */
  async isNameCached(name) {
    try {
      const status = await this.getStatus();
      const cachedNames = status.greetingCache?.availableNames || [];
      return cachedNames.includes(name.toLowerCase());
    } catch (error) {
      return false;
    }
  }

  /**
   * Get estimated latency for a customer name
   * @param {string} name - Customer name
   * @returns {Promise<string>} Estimated latency
   */
  async getEstimatedLatency(name) {
    const isCached = await this.isNameCached(name);
    const status = await this.getStatus();
    
    if (isCached) {
      return status.recommendations?.expectedLatency?.cachedNames || "<50ms (instant)";
    } else {
      return status.recommendations?.expectedLatency?.uncachedNames || "~200-300ms";
    }
  }
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  // Node.js
  module.exports = AICallerIntegration;
} else if (typeof window !== 'undefined') {
  // Browser
  window.AICallerIntegration = AICallerIntegration;
}

// Usage Examples:

/*
// Node.js / Server-side
const AICallerIntegration = require('./integration-helper.js');
const caller = new AICallerIntegration('https://your-app-name.up.railway.app');

// Single call
const result = await caller.makeCall({
  name: 'John Doe',
  number: '+1234567890',
  airtableRecordId: 'rec123456789'
});

// Multiple calls
const calls = [
  { name: 'John Doe', number: '+1234567890' },
  { name: 'Jane Smith', number: '+0987654321' }
];
const results = await caller.makeMultipleCalls(calls);

// Check performance
const status = await caller.getStatus();
console.log('System performance:', status.latencyOptimizations);

// Browser / Client-side
<script src="integration-helper.js"></script>
<script>
const caller = new AICallerIntegration('https://your-app-name.up.railway.app');

document.getElementById('call-button').addEventListener('click', async () => {
  const result = await caller.makeCall({
    name: document.getElementById('name').value,
    number: document.getElementById('number').value
  });
  console.log('Call result:', result);
});
</script>
*/ 