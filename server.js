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

// Supabase jest opcjonalne — jeśli zmienne nie są ustawione, endpointy
// związane z bazą zwrócą czytelny błąd zamiast wywalać cały serwer.
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

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

    if (!geminiResponse.ok) {
      const msg = (data && data.error && data.error.message) || 'Błąd Gemini.';
      return res.status(geminiResponse.status).json({ error: msg });
    }

    const candidate = data.candidates && data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const raw = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
    const clean = raw.replace(/```json|```/g, '').trim();

    let parsed;
    let parseFailed = false;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      parseFailed = true;
      parsed = { reply: raw || 'Nie udało się odczytać odpowiedzi.', entities: [], inconsistencies: [] };
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

// Prosty health-check — przydatny dla Render, żeby wiedział, że usługa żyje
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`DARK Archiwum działa na porcie ${PORT}`);
});
