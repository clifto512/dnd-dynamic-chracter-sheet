const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(express.json());

// ── CORS: allow requests from Netlify, GitHub Pages + localhost for testing ──
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);           // allow curl / server-to-server
    if (
      origin.endsWith('.netlify.app') ||
      origin.endsWith('.github.io')  ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')
    ) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));

// ── Configuration ─────────────────────────────────────────────────────────
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;  // set in Render dashboard
const GEN_LIMIT           = 25;   // generations per pack
const GEN_PACK_PRICE_ID   = process.env.STRIPE_PRICE_ID || null; // optional, for future Stripe

// ── In-memory generation store ─────────────────────────────────────────────
// Key: purchaseId (a unique string per customer)
// Value: { used: number, total: number, createdAt: ISO string }
//
// NOTE: This resets when the server restarts. For production, swap this
// Map for a real database (e.g. Render's free PostgreSQL). The API surface
// stays identical — only the read/write calls change.
const genStore = new Map();

function getGenRecord(purchaseId) {
  if (!genStore.has(purchaseId)) {
    genStore.set(purchaseId, {
      used: 0,
      total: GEN_LIMIT,
      createdAt: new Date().toISOString()
    });
  }
  return genStore.get(purchaseId);
}

// ── Helper: poll Replicate until the prediction is done ───────────────────
async function pollReplicate(predictionId, extractUrl) {
  const url = `https://api.replicate.com/v1/predictions/${predictionId}`;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res  = await fetch(url, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
    });
    const data = await res.json();
    if (data.status === 'succeeded') {
      const imageUrl = extractUrl(data.output);
      if (imageUrl) return imageUrl;
      throw new Error('No image URL in completed prediction');
    }
    if (data.status === 'failed') throw new Error(data.error || 'Prediction failed');
  }
  throw new Error('Prediction timed out');
}

// ── Routes ────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'D&D Portrait API' }));

// Check remaining generations for a purchaseId
app.get('/gens/:purchaseId', (req, res) => {
  const rec       = getGenRecord(req.params.purchaseId);
  const remaining = Math.max(0, rec.total - rec.used);
  res.json({ remaining, total: rec.total, used: rec.used });
});

// Add a generation pack (called after purchase verification)
// In production: verify a Stripe payment intent here before adding credits
app.post('/purchase/:purchaseId', (req, res) => {
  const { secret } = req.body;
  // Basic shared secret check — replace with Stripe webhook verification later
  if (secret !== process.env.PURCHASE_SECRET) {
    return res.status(403).json({ error: 'Invalid purchase secret' });
  }
  const rec = getGenRecord(req.params.purchaseId);
  rec.total += GEN_LIMIT;
  res.json({ remaining: rec.total - rec.used, total: rec.total });
});

// Generate a portrait
app.post('/generate', async (req, res) => {
  try {
    const { purchaseId, prompt } = req.body;

    if (!purchaseId || !prompt) {
      return res.status(400).json({ error: 'purchaseId and prompt are required' });
    }

    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: 'Server not configured — missing REPLICATE_API_TOKEN' });
    }

    // Check generation limit
    const rec       = getGenRecord(purchaseId);
    const remaining = rec.total - rec.used;
    if (remaining <= 0) {
      return res.status(402).json({
        error: 'No generations remaining',
        remaining: 0,
        purchaseRequired: true
      });
    }

    // Reserve one generation before calling the API
    rec.used += 1;

    // Call Replicate — Stable Diffusion 3.5 Large
    const createRes = await fetch('https://api.replicate.com/v1/models/stability-ai/stable-diffusion-3.5-large/predictions', {
      method:  'POST',
      headers: {
        Authorization:  `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        Prefer:         'wait'
      },
      body: JSON.stringify({
        input: {
          prompt,
          negative_prompt: 'background, scenery, landscape, rocks, caves, ruins, environment, sky, ground, floor, walls, outdoors, indoors, nudity, bare skin, shirtless, topless, revealing clothing, skimpy outfit, NSFW, adult content, cropped, cut off, partial body, floating, disembodied, cartoon, anime, chibi, digital art, 3d render, watermark, text, signature',
          aspect_ratio:         '2:3',
          num_inference_steps:    40,
          guidance_scale:          4.5,
          num_outputs:             1,
          output_format:        'webp',
          output_quality:           80,
        }
      })
    });

    const prediction = await createRes.json();
    console.log('Replicate response status:', createRes.status);
    console.log('Replicate prediction:', JSON.stringify(prediction).slice(0, 500));
    console.log('Replicate response status:', createRes.status);
    console.log('Prediction status:', prediction.status);
    console.log('Prediction output:', JSON.stringify(prediction.output).slice(0, 200));
    console.log('Prediction error:', prediction.error);

    // SD 3.5 Large returns output as a plain string URL
    // FLUX returns output as an array of URL strings
    // Handle both formats
    const extractUrl = (output) => {
      if (!output) return null;
      if (typeof output === 'string') return output;
      if (Array.isArray(output)) {
        const first = output[0];
        if (typeof first === 'string') return first;
        if (first && typeof first.url === 'function') return first.url();
        if (first && typeof first.url === 'string') return first.url;
      }
      return null;
    };

    // If Replicate responded immediately with output (Prefer: wait)
    if (prediction.output) {
      const imageUrl = extractUrl(prediction.output);
      if (imageUrl) {
        return res.json({ imageUrl, remaining: rec.total - rec.used });
      }
    }

    // Otherwise poll until done
    if (prediction.id) {
      const imageUrl = await pollReplicate(prediction.id, extractUrl);
      return res.json({ imageUrl, remaining: rec.total - rec.used });
    }

    // Log unexpected response for debugging
    console.error('Unexpected prediction response:', JSON.stringify(prediction).slice(0, 300));
    rec.used -= 1;
    return res.status(500).json({ error: prediction.detail || 'Unexpected Replicate response' });

  } catch (err) {
    // Refund generation on error if we can
    if (req.body?.purchaseId) {
      const rec = genStore.get(req.body.purchaseId);
      if (rec && rec.used > 0) rec.used -= 1;
    }
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D&D Portrait API running on port ${PORT}`));
