// Serwer Node.js / Express — backend do DARK Archiwum, przeznaczony na Render.
//
// Serwuje statyczny frontend (folder /public) oraz endpoint /api/chat,
// który dokłada sekretny klucz Gemini (z zmiennej środowiskowej) i przekazuje
// zapytanie dalej. Klucz nigdy nie trafia do przeglądarki.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

app.use(express.json({ limit: '2mb' }));

// Frontend (index.html + zasoby) — serwowane statycznie z /public
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Brak skonfigurowanego klucza GEMINI_API_KEY na serwerze.' });
  }

  const { contents, systemInstruction } = req.body || {};
  if (!Array.isArray(contents)) {
    return res.status(400).json({ error: 'Brak pola "contents" w zapytaniu.' });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  try {
    const geminiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        generationConfig: {
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      }),
    });

    const data = await geminiResponse.json();
    res.status(geminiResponse.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Nie udało się połączyć z Gemini: ' + err.message });
  }
});

// Prosty health-check — przydatny dla Render, żeby wiedział, że usługa żyje
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`DARK Archiwum działa na porcie ${PORT}`);
});
