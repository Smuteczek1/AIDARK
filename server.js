// Serwer Node.js / Express — backend do DARK Archiwum, przeznaczony na Render.
//
// Robi trzy rzeczy:
// 1. Serwuje statyczny frontend (folder /public).
// 2. /api/chat — dokłada sekretny klucz Gemini, woła Gemini, parsuje odpowiedź
//    i od razu zapisuje nowe/zaktualizowane jednostki do wspólnej bazy (Supabase).
// 3. /api/entities i /api/documents — REST-owy dostęp do wspólnej bazy, żeby
//    ludzie (nie tylko AI) też mogli dodawać/edytować/usuwać wpisy.
//
// Oba sekrety (GEMINI_API_KEY oraz klucz Supabase) żyją WYŁĄCZNIE jako zmienne
// środowiskowe na serwerze — nigdy nie trafiają do przeglądarki.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Podbite z 32768 -> 65536: na modelach Gemini 3 tokeny "myślenia" (thinking)
// liczą się do TEGO SAMEGO budżetu co realna odpowiedź, nawet przy niskim
// thinkingLevel. Przy JSON mode + responseSchema łatwo się w to wjeżdża
// (MAX_TOKENS = odpowiedź ucięta w połowie). Więcej luzu na start = mniej
// ucinanych tur. Da się to też nadpisać zmienną środowiskową bez redeployu.
const GEMINI_MAX_OUTPUT_TOKENS = parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 65536;
// Sufit, do którego wolno automatycznie podbijać budżet przy retry na MAX_TOKENS.
const GEMINI_MAX_OUTPUT_TOKENS_CEILING = parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS_CEILING, 10) || 131072;

// Supabase jest opcjonalne — jeśli zmienne nie są ustawione albo są niepoprawne,
// endpointy związane z bazą zwrócą czytelny błąd zamiast wywalać cały serwer
// (a czat z Gemini, który Supabase w ogóle nie potrzebuje, ma dalej działać).
let supabase = null;
{
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (url && key) {
    try {
      supabase = createClient(url, key);
    } catch (err) {
      console.error('Nie udało się zainicjować klienta Supabase — sprawdź SUPABASE_URL i SUPABASE_SERVICE_KEY:', err.message);
      supabase = null;
    }
  } else {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_KEY nie są ustawione — funkcje bazy danych będą wyłączone.');
  }
}

function requireSupabase(res) {
  if (!supabase) {
    res.status(500).json({ error: 'Brak skonfigurowanego SUPABASE_URL / SUPABASE_SERVICE_KEY na serwerze.' });
    return false;
  }
  return true;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('Niespodziewany błąd:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Błąd serwera: ' + err.message });
    });
  };
}

// ---------- Jednostki ----------

app.get('/api/entities', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data, error } = await supabase.from('entities').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.put('/api/entities', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const e = req.body || {};
  if (!e.name || !e.name.trim()) return res.status(400).json({ error: 'Brak pola "name".' });

  const row = {
    key: e.name.trim().toLowerCase(),
    name: e.name.trim(),
    kategoria: e.kategoria || null,
    tajnosc: e.tajnosc || null,
    opis: e.opis || null,
    status: e.status || null,
    powiazania: e.powiazania || null,
    nadrzedna: e.nadrzedna || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('entities')
    .upsert(row, { onConflict: 'key' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.delete('/api/entities/:key', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { error } = await supabase.from('entities').delete().eq('key', req.params.key);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}));

// ---------- Dokumenty (drzewo: każdy dokument może mieć poddokumenty) ----------

app.get('/api/documents', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data, error } = await supabase.from('documents').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.post('/api/documents', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { title, parent_id } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Brak tytułu.' });

  const { data, error } = await supabase
    .from('documents')
    .insert({ title: title.trim(), parent_id: parent_id || null, content: '', created_by: 'user' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.put('/api/documents/:id', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { title, content } = req.body || {};
  const patch = { updated_at: new Date().toISOString() };
  if (title !== undefined) patch.title = title;
  if (content !== undefined) patch.content = content;

  const { data, error } = await supabase
    .from('documents')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.delete('/api/documents/:id', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  // ON DELETE CASCADE w schemacie SQL sam usunie poddokumenty.
  const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}));

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kategoria: { type: 'string' },
          tajnosc: { type: 'string' },
          opis: { type: 'string' },
          status: { type: 'string' },
          powiazania: { type: 'string' },
          nadrzedna: { type: 'string' },
        },
        required: ['name'],
      },
    },
    inconsistencies: { type: 'array', items: { type: 'string' } },
  },
  required: ['reply', 'entities', 'inconsistencies'],
};

// Ten projekt to świadomie mroczna, dojrzała fikcja (styl SCP) — łagodzimy
// domyślne progi Gemini dla przemocy/treści niepokojących, żeby nie blokował
// zwykłych opisów anomalii czy starć. Treści jednoznacznie zakazane (np.
// seksualizacja nieletnich) i tak zawsze zostaną odrzucone przez Google.
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function callGeminiWithRetry(url, body, maxRetries = 3) {
  let lastResponse, lastData;
  let currentBody = body;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const geminiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentBody),
    });
    const data = await geminiResponse.json();

    // 503 (przeciążenie) i 429 (limit zapytań) bywają chwilowe — warto spróbować ponownie.
    if ((geminiResponse.status === 503 || geminiResponse.status === 429) && attempt < maxRetries) {
      lastResponse = geminiResponse;
      lastData = data;
      const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
      console.warn(`Gemini zwrócił ${geminiResponse.status}, próba ${attempt + 1}/${maxRetries + 1} — ponawiam za ${waitMs}ms.`);
      await sleep(waitMs);
      continue;
    }

    // Odpowiedź ucięta, bo thinking + treść nie zmieściły się w budżecie
    // tokenów (MAX_TOKENS). Zamiast tracić całą turę, podbij budżet i
    // spróbuj jeszcze raz — aż do rozsądnego sufitu.
    const candidate = geminiResponse.ok && data.candidates && data.candidates[0];
    const finishReason = candidate && candidate.finishReason;
    if (finishReason === 'MAX_TOKENS' && attempt < maxRetries) {
      lastResponse = geminiResponse;
      lastData = data;
      const oldBudget = currentBody.generationConfig.maxOutputTokens;
      const newBudget = Math.min(oldBudget * 2, GEMINI_MAX_OUTPUT_TOKENS_CEILING);
      if (newBudget === oldBudget) {
        // Już na suficie — nie ma sensu próbować dalej z tym samym budżetem.
        return { geminiResponse, data };
      }
      console.warn(`Gemini uciął odpowiedź na MAX_TOKENS (budżet ${oldBudget}), próba ${attempt + 1}/${maxRetries + 1} — podbijam do ${newBudget}.`);
      currentBody = {
        ...currentBody,
        generationConfig: { ...currentBody.generationConfig, maxOutputTokens: newBudget },
      };
      continue;
    }

    return { geminiResponse, data };
  }
  return { geminiResponse: lastResponse, data: lastData };
}

// ---------- Czat z Gemini ----------

app.post('/api/chat', asyncRoute(async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Brak skonfigurowanego klucza GEMINI_API_KEY na serwerze.' });
  }

  const { contents, systemInstruction } = req.body || {};
  if (!Array.isArray(contents)) {
    return res.status(400).json({ error: 'Brak pola "contents" w zapytaniu.' });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  try {
    const { geminiResponse, data } = await callGeminiWithRetry(url, {
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        // 'minimal' zamiast 'low': Gemini 3 zużywa tokeny myślenia z TEGO
        // SAMEGO budżetu co odpowiedź, nawet przy niskich poziomach. To
        // zadanie to głównie ekstrakcja danych + zwięzła odpowiedź — nie
        // potrzebuje głębokiego rozumowania, więc ograniczamy je maksymalnie,
        // żeby zostawić jak najwięcej miejsca na treść.
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    });

    if (!geminiResponse.ok) {
      const msg = (data && data.error && data.error.message) || 'Błąd Gemini.';
      if (geminiResponse.status === 503) {
        return res.status(503).json({ error: 'Gemini jest chwilowo przeciążone (nawet po kilku automatycznych próbach). Spróbuj wysłać wiadomość ponownie za chwilę.' });
      }
      return res.status(geminiResponse.status).json({ error: msg });
    }

    // Zapytanie zablokowane w całości, zanim model zaczął odpowiadać.
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      console.error('Gemini zablokował zapytanie:', JSON.stringify(data.promptFeedback));
      return res.json({
        reply: `Gemini zablokował tę wiadomość swoimi filtrami bezpieczeństwa (powód: ${data.promptFeedback.blockReason}). Spróbuj przeformułować wiadomość.`,
        entities: [],
        inconsistencies: [],
        parseFailed: true,
      });
    }

    const candidate = data.candidates && data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const raw = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const finishReason = candidate && candidate.finishReason;

    let parsed;
    let parseFailed = false;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      parseFailed = true;
      console.error('Nie udało się sparsować JSON od Gemini. finishReason:', finishReason, '| surowy tekst:', raw.slice(0, 500));

      // Nawet jeśli JSON jako całość jest niepoprawny (ucięty w połowie),
      // spróbuj odzyskać z niego kompletne obiekty jednostek z tablicy
      // "entities" — żeby retry na MAX_TOKENS + ten fallback razem dawały
      // jak najmniejszą szansę na utratę całej tury.
      const salvaged = salvageEntitiesFromTruncatedJson(clean);

      let hint = 'Nie udało się odczytać odpowiedzi.';
      if (finishReason === 'SAFETY') hint = 'Odpowiedź została zablokowana przez filtry bezpieczeństwa Gemini (finishReason: SAFETY).';
      else if (finishReason === 'MAX_TOKENS') {
        hint = salvaged.length
          ? `Odpowiedź została ucięta mimo automatycznych ponowień (finishReason: MAX_TOKENS). Udało się jednak odzyskać ${salvaged.length} jednostek z uciętej odpowiedzi — zostały zapisane. Spróbuj krótszej wiadomości albo poproś o mniej jednostek naraz.`
          : 'Odpowiedź została ucięta, bo przekroczyła limit tokenów (finishReason: MAX_TOKENS) — spróbuj krótszej wiadomości.';
      }
      else if (finishReason === 'RECITATION') hint = 'Gemini odmówił odpowiedzi z powodu podejrzenia o cytowanie chronionej treści (finishReason: RECITATION).';
      else if (!raw) hint = `Model nie zwrócił żadnej treści (finishReason: ${finishReason || 'nieznany'}).`;

      parsed = { reply: hint, entities: salvaged, inconsistencies: [] };
    }

    const entities = Array.isArray(parsed.entities) ? parsed.entities : [];

    // Zapisz nowe/zaktualizowane jednostki od razu do wspólnej bazy.
    if (supabase && entities.length) {
      const rows = entities
        .filter((e) => e && e.name && e.name.trim())
        .map((e) => ({
          key: e.name.trim().toLowerCase(),
          name: e.name.trim(),
          kategoria: e.kategoria || null,
          tajnosc: e.tajnosc || null,
          opis: e.opis || null,
          status: e.status || null,
          powiazania: e.powiazania || null,
          nadrzedna: e.nadrzedna || null,
          updated_at: new Date().toISOString(),
        }));
      if (rows.length) {
        const { error: upsertError } = await supabase.from('entities').upsert(rows, { onConflict: 'key' });
        if (upsertError) console.error('Błąd zapisu jednostek do Supabase:', upsertError.message);
      }
    }

    res.json({
      reply: parsed.reply || '(brak treści odpowiedzi)',
      entities,
      inconsistencies: Array.isArray(parsed.inconsistencies) ? parsed.inconsistencies : [],
      parseFailed,
    });
  } catch (err) {
    res.status(502).json({ error: 'Nie udało się połączyć z Gemini: ' + err.message });
  }
}));

// Próbuje wyciągnąć kompletne obiekty jednostek z tablicy "entities" wewnątrz
// uciętego (niepoprawnego) JSON-a. Działa na zasadzie zliczania nawiasów
// klamrowych, żeby złapać tylko te obiekty {...}, które model zdążył w pełni
// domknąć przed przekroczeniem limitu tokenów.
function salvageEntitiesFromTruncatedJson(text) {
  const marker = '"entities"';
  const idx = text.indexOf(marker);
  if (idx === -1) return [];

  const arrayStart = text.indexOf('[', idx);
  if (arrayStart === -1) return [];

  const results = [];
  let i = arrayStart + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] !== '{') break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let objStart = i;
    let objEnd = -1;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = j; break; }
      }
    }

    if (objEnd === -1) break; // obiekt ucięty w połowie — koniec odzyskiwania

    const objText = text.slice(objStart, objEnd + 1);
    try {
      const obj = JSON.parse(objText);
      if (obj && obj.name && String(obj.name).trim()) results.push(obj);
    } catch { /* pomiń niepoprawny fragment */ }

    i = objEnd + 1;
  }

  return results;
}

// Prosty health-check — przydatny dla Render, żeby wiedział, że usługa żyje
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`DARK Archiwum działa na porcie ${PORT}`);
});
