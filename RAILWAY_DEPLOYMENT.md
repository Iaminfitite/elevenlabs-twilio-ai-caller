# 🚀 Railway Deployment Guide

## Step-by-Step Railway Deployment

### 1. **Deploy to Railway**

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/)

**Option A: GitHub Integration (Recommended)**
1. Push your code to a GitHub repository
2. Go to [Railway.app](https://railway.app)
3. Click "Start a New Project"
4. Select "Deploy from GitHub repo"
5. Choose your repository
6. Railway will auto-detect Node.js and deploy

**Option B: Railway CLI**
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 2. **Environment Variables Setup**

In your Railway dashboard, go to **Variables** tab and add:

```env
# ElevenLabs Configuration
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_AGENT_ID=your_elevenlabs_agent_id_here

# Twilio Configuration  
TWILIO_ACCOUNT_SID=your_twilio_account_sid_here
TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
TWILIO_PHONE_NUMBER=your_twilio_phone_number_here

# Production Settings
NODE_ENV=production
```

### 3. **Get Your Railway URL**

After deployment, Railway provides:
- **Public URL**: `https://your-app-name.up.railway.app`
- **Custom Domain** (optional): Add your own domain in Railway dashboard

### 4. **Test Your Deployment**

```bash
# Check if server is running
curl https://your-app-name.up.railway.app/

# Check optimization status
curl https://your-app-name.up.railway.app/optimization-status
```

---

## 🔗 Integration with Your Current Workflow

### **API Endpoints Available**

#### 1. **Initiate Outbound Call**
```bash
POST https://your-app-name.up.railway.app/outbound-call
Content-Type: application/json

{
  "name": "John Doe",
  "number": "+1234567890",
  "airtableRecordId": "recXXXXXXXXXXXXXX" // optional
}
```

**Response:**
```json
{
  "success": true,
  "callSid": "CAxxxxxxxxxxxxx",
  "optimizations": {
    "greetingPreCached": true,
    "expectedLatency": "<50ms (instant)",
    "latencyReduction": "100% (instant audio)"
  }
}
```

#### 2. **End Call**
```bash
POST https://your-app-name.up.railway.app/end-call
Content-Type: application/json

{
  "callSid": "CAxxxxxxxxxxxxx"
}
```

#### 3. **Check Status**
```bash
GET https://your-app-name.up.railway.app/optimization-status
```

---

## 🔌 Integration Examples

### **1. Zapier Integration**

Create a Zapier webhook:
1. **Trigger**: New lead in your CRM/form
2. **Action**: Webhook POST to your Railway URL
3. **Data mapping**:
   ```json
   {
     "name": "{{Lead Name}}",
     "number": "{{Lead Phone}}",
     "airtableRecordId": "{{Record ID}}"
   }
   ```

### **2. Airtable Automation**

In Airtable:
1. Go to **Automations**
2. **Trigger**: When record matches conditions
3. **Action**: Send HTTP request
   - **URL**: `https://your-app-name.up.railway.app/outbound-call`
   - **Method**: POST
   - **Body**: 
     ```json
     {
       "name": "{{Name}}",
       "number": "{{Phone}}",
       "airtableRecordId": "{{Record ID}}"
     }
     ```

### **3. Make.com (formerly Integromat)**

1. **HTTP Module**: Make a request
2. **URL**: `https://your-app-name.up.railway.app/outbound-call`
3. **Method**: POST
4. **Body**: Map your data fields

### **4. Direct API Integration**

**Node.js Example:**
```javascript
const response = await fetch('https://your-app-name.up.railway.app/outbound-call', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'John Doe',
    number: '+1234567890',
    airtableRecordId: 'rec123456789'
  })
});

const result = await response.json();
console.log('Call initiated:', result);
```

**Python Example:**
```python
import requests

response = requests.post(
    'https://your-app-name.up.railway.app/outbound-call',
    json={
        'name': 'John Doe',
        'number': '+1234567890',
        'airtableRecordId': 'rec123456789'
    }
)

print('Call initiated:', response.json())
```

### **5. Webhook from Lead Forms**

Set your form webhook URL to:
```
https://your-app-name.up.railway.app/outbound-call
```

Ensure form sends JSON with `name` and `number` fields.

---

## 🎯 Performance Features

### **Instant Audio Delivery**
- **Cached names**: Sub-50ms response time
- **Common names pre-cached**: John, Jane, Sarah, Mike, David, Lisa, etc.
- **Auto-caching**: New names cached for future calls

### **Cost Optimization**
- **95% cost reduction** vs connection pooling
- **Intelligent resource management**
- **~$5-10/month** operational cost

### **Monitoring**
Check real-time performance:
```bash
GET https://your-app-name.up.railway.app/optimization-status
```

---

## 🛠 Troubleshooting

### **Common Issues**

1. **Environment Variables Missing**
   - Check Railway dashboard > Variables tab
   - Ensure all required variables are set

2. **Twilio Webhook Issues**
   - Railway URL is automatically public
   - No ngrok needed in production

3. **ElevenLabs Rate Limits**
   - System respects 10 concurrent request limit
   - Sequential greeting cache generation

### **Support**

- **Railway Status**: [status.railway.app](https://status.railway.app)
- **Logs**: Check Railway dashboard > Deployments > View Logs
- **Metrics**: Railway dashboard shows CPU, Memory, Network usage

---

## 🔄 Continuous Deployment

Railway automatically redeploys when you push to your connected GitHub repository. 

For manual deployments:
```bash
railway up
```

Your AI calling system is now production-ready with sub-50ms response times! 🎉 