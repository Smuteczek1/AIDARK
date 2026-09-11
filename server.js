// Serwer Node.js / Express — backend do DARK Archiwum, przeznaczony na Render.
//
// Robi trzy rzeczy:
// 1. Serwuje statyczny frontend (folder /public).
// 2. /api/chat — agentowa pętla z Gemini function calling: model dostaje
//    zestaw narzędzi (propose_create_entity, propose_create_document, itd.),
//    może je wywoływać wielokrotnie w dowolnej kolejności zanim odpowie
//    tekstem. Każde wywołanie propose_* NIE zmienia bazy od razu — zapisuje
//    wiersz w tabeli "proposals" (status pending) i czeka na ręczne
//    zatwierdzenie przez użytkownika. flag_inconsistency i search_documents
//    wykonują się od razu (odpowiednio: nie dotykają bazy / tylko czytają).
// 3. /api/entities, /api/documents, /api/proposals — REST-owy dostęp do
//    wspólnej bazy: ludzie mogą edytować jednostki/dokumenty ręcznie,
//    zatwierdzać lub odrzucać propozycje AI (pojedynczo albo całą partią).
//
// Oba sekrety (GEMINI_API_KEY oraz klucz Supabase) żyją WYŁĄCZNIE jako zmienne
// środowiskowe na serwerze — nigdy nie trafiają do przeglądarki.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Tokeny "myślenia" (thinking) liczą się do TEGO SAMEGO budżetu co realna
// odpowiedź, nawet przy niskim thinkingLevel — więc dajemy spory luz na start,
// żeby pętla wywołań narzędzi nie ucinała się w połowie.
const GEMINI_MAX_OUTPUT_TOKENS = parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 65536;
// Sufit, do którego wolno automatycznie podbijać budżet przy retry na MAX_TOKENS.
const GEMINI_MAX_OUTPUT_TOKENS_CEILING = parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS_CEILING, 10) || 131072;
// Ile razy model może wywołać narzędzia w jednej turze użytkownika, zanim
// wymusimy zakończenie (zabezpieczenie przed nieskończoną pętlą).
const MAX_TOOL_ITERATIONS = parseInt(process.env.MAX_TOOL_ITERATIONS, 10) || 8;

const CATEGORIES = ['Korporacja', 'Jednostka / Wydział', 'Frakcja', 'Postać', 'Anomalia', 'Miejsce', 'Wydarzenie', 'Inne'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Supabase jest opcjonalne — jeśli zmienne nie są ustawione albo są niepoprawne,
// endpointy związane z bazą zwrócą czytelny błąd zamiast wywalać cały serwer
// (a czat z Gemini, który do samego generowania tekstu Supabase nie potrzebuje,
// ma dalej działać — choć narzędzia propose_* bez bazy nie zapiszą propozycji).
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

// ---------- Jednostki (edycja ręczna — AI zmienia je wyłącznie przez propozycje) ----------

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

// ---------- Propozycje AI (zatwierdzanie / odrzucanie przez człowieka) ----------

app.get('/api/proposals', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const status = req.query.status || 'pending';
  let q = supabase.from('proposals').select('*').order('created_at');
  if (status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.post('/api/proposals/:id/approve', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const result = await approveProposal(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

app.post('/api/proposals/:id/reject', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { error } = await supabase
    .from('proposals')
    .update({ status: 'rejected', resolved_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('status', 'pending');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}));

// Zatwierdza całą partię (batch) naraz — w kilku przebiegach, żeby np.
// dokumenty-dzieci mogły poczekać, aż ich dokument nadrzędny (z tej samej
// partii) zostanie już utworzony i dostanie realne ID.
app.post('/api/proposals/batch/:batchId/approve', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data: rows, error } = await supabase
    .from('proposals')
    .select('*')
    .eq('batch_id', req.params.batchId)
    .eq('status', 'pending');
  if (error) return res.status(500).json({ error: error.message });

  const results = [];
  let remaining = rows || [];
  let progressed = true;
  while (remaining.length && progressed) {
    progressed = false;
    const stillPending = [];
    for (const row of remaining) {
      const r = await approveProposal(row.id, row);
      if (r.error) {
        stillPending.push(row);
      } else {
        results.push({ id: row.id, ok: true });
        progressed = true;
      }
    }
    remaining = stillPending;
  }
  remaining.forEach((row) => results.push({ id: row.id, ok: false, error: 'Nie udało się rozwiązać zależności (np. brakujący dokument nadrzędny).' }));

  res.json({ results });
}));

app.post('/api/proposals/batch/:batchId/reject', asyncRoute(async (req, res) => {
  if (!requireSupabase(res)) return;
  const { error } = await supabase
    .from('proposals')
    .update({ status: 'rejected', resolved_at: new Date().toISOString() })
    .eq('batch_id', req.params.batchId)
    .eq('status', 'pending');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}));

// Wykonuje faktyczną zmianę w entities/documents dla jednej zatwierdzonej
// propozycji. `preloadedRow` pozwala pętli zatwierdzania partii uniknąć
// dodatkowego SELECT-a na każdą propozycję.
async function approveProposal(id, preloadedRow) {
  let row = preloadedRow;
  if (!row) {
    const { data, error } = await supabase.from('proposals').select('*').eq('id', id).single();
    if (error || !data) return { error: 'Nie znaleziono propozycji.' };
    row = data;
  }
  if (row.status !== 'pending') return { error: 'Ta propozycja została już rozstrzygnięta.' };

  const p = row.payload || {};

  try {
    switch (row.action) {
      case 'create_entity': {
        if (!p.name || !String(p.name).trim()) return { error: 'Propozycja nie ma nazwy jednostki.' };
        const entityRow = {
          key: String(p.name).trim().toLowerCase(),
          name: String(p.name).trim(),
          kategoria: p.kategoria || null,
          tajnosc: p.tajnosc || null,
          opis: p.opis || null,
          status: p.status || null,
          powiazania: p.powiazania || null,
          nadrzedna: p.nadrzedna || null,
          updated_at: new Date().toISOString(),
        };
        const { error } = await supabase.from('entities').upsert(entityRow, { onConflict: 'key' });
        if (error) return { error: error.message };
        break;
      }

      case 'update_entity': {
        if (!p.key) return { error: 'Brak klucza jednostki.' };
        const { data: existing, error: fetchErr } = await supabase.from('entities').select('*').eq('key', p.key).single();
        if (fetchErr || !existing) return { error: 'Jednostka o tym kluczu już nie istnieje w bazie.' };

        const merged = { ...existing };
        ['name', 'kategoria', 'tajnosc', 'opis', 'status', 'powiazania', 'nadrzedna'].forEach((f) => {
          if (p[f] !== undefined && p[f] !== null && p[f] !== '') merged[f] = p[f];
        });
        merged.updated_at = new Date().toISOString();
        const newKey = p.name ? String(p.name).trim().toLowerCase() : existing.key;

        if (newKey !== existing.key) {
          merged.key = newKey;
          const { error: insErr } = await supabase.from('entities').insert(merged);
          if (insErr) return { error: insErr.message };
          const { error: delErr } = await supabase.from('entities').delete().eq('key', existing.key);
          if (delErr) return { error: delErr.message };
        } else {
          const { error } = await supabase.from('entities').update(merged).eq('key', existing.key);
          if (error) return { error: error.message };
        }
        break;
      }

      case 'delete_entity': {
        if (!p.key) return { error: 'Brak klucza jednostki.' };
        const { error } = await supabase.from('entities').delete().eq('key', p.key);
        if (error) return { error: error.message };
        break;
      }

      case 'create_document': {
        let parentId = null;
        const ref = p.parent_ref;
        if (ref) {
          if (UUID_RE.test(ref)) {
            parentId = ref;
          } else {
            return { error: `Dokument nadrzędny (tymczasowe ID "${ref}") nie został jeszcze zatwierdzony. Zatwierdź go najpierw, albo użyj "Zatwierdź całą partię".` };
          }
        }
        const { data: created, error } = await supabase
          .from('documents')
          .insert({ title: (p.title || 'Bez tytułu').trim(), content: p.content || '', parent_id: parentId, created_by: 'ai' })
          .select()
          .single();
        if (error) return { error: error.message };

        // Rozwiąż propozycje-dzieci z tej samej partii, które czekały na
        // ten temp_id jako rodzica — podmień im parent_ref na realne ID.
        if (p.temp_id) {
          const { data: siblings } = await supabase
            .from('proposals')
            .select('*')
            .eq('batch_id', row.batch_id)
            .eq('action', 'create_document')
            .eq('status', 'pending');
          if (siblings && siblings.length) {
            for (const sib of siblings) {
              if (sib.payload && sib.payload.parent_ref === p.temp_id) {
                const newPayload = { ...sib.payload, parent_ref: created.id };
                await supabase.from('proposals').update({ payload: newPayload }).eq('id', sib.id);
              }
            }
          }
        }
        break;
      }

      case 'update_document': {
        if (!p.id) return { error: 'Brak ID dokumentu.' };
        const patch = { updated_at: new Date().toISOString() };
        if (p.title !== undefined) patch.title = p.title;
        if (p.content !== undefined) patch.content = p.content;
        const { error } = await supabase.from('documents').update(patch).eq('id', p.id);
        if (error) return { error: error.message };
        break;
      }

      case 'delete_document': {
        if (!p.id) return { error: 'Brak ID dokumentu.' };
        const { error } = await supabase.from('documents').delete().eq('id', p.id);
        if (error) return { error: error.message };
        break;
      }

      case 'move_document': {
        if (!p.id) return { error: 'Brak ID dokumentu.' };
        const newParent = p.new_parent_id && UUID_RE.test(p.new_parent_id) ? p.new_parent_id : null;
        const { error } = await supabase
          .from('documents')
          .update({ parent_id: newParent, updated_at: new Date().toISOString() })
          .eq('id', p.id);
        if (error) return { error: error.message };
        break;
      }

      default:
        return { error: 'Nieznany typ propozycji: ' + row.action };
    }
  } catch (err) {
    return { error: err.message };
  }

  const { error: statusErr } = await supabase
    .from('proposals')
    .update({ status: 'approved', resolved_at: new Date().toISOString() })
    .eq('id', row.id);
  if (statusErr) return { error: statusErr.message };
  return { ok: true };
}

// ---------- Narzędzia (function calling) udostępniane Gemini ----------
// Każde "propose_*" tylko ZAPISUJE propozycję (status pending) — nie zmienia
// bazy. search_documents i flag_inconsistency wykonują się od razu.

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'propose_create_entity',
      description: 'Zaproponuj dodanie nowej jednostki (korporacji, postaci, anomalii, frakcji, miejsca, wydarzenia...) do wspólnej bazy. To tylko propozycja — trafia do kolejki i wymaga zatwierdzenia przez użytkownika.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa jednostki.' },
          kategoria: { type: 'string', enum: CATEGORIES },
          tajnosc: { type: 'string', description: 'Poziom tajności/klasyfikacji, jeśli świat go ma. Pomiń, jeśli nie dotyczy.' },
          opis: { type: 'string' },
          status: { type: 'string' },
          powiazania: { type: 'string' },
          nadrzedna: { type: 'string', description: 'Nazwa organizacji nadrzędnej, jeśli ta jednostka jest jej częścią.' },
          reasoning: { type: 'string', description: 'Krótkie, konkretne uzasadnienie tej propozycji dla użytkownika (1-2 zdania).' },
        },
        required: ['name', 'kategoria', 'opis', 'reasoning'],
      },
    },
    {
      name: 'propose_update_entity',
      description: 'Zaproponuj aktualizację istniejącej jednostki. Podaj tylko pola, które faktycznie się zmieniają.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Klucz jednostki (nazwa małymi literami) — dokładnie taki, jaki widnieje w bazie danych jednostek.' },
          name: { type: 'string' },
          kategoria: { type: 'string', enum: CATEGORIES },
          tajnosc: { type: 'string' },
          opis: { type: 'string' },
          status: { type: 'string' },
          powiazania: { type: 'string' },
          nadrzedna: { type: 'string' },
          reasoning: { type: 'string' },
        },
        required: ['key', 'reasoning'],
      },
    },
    {
      name: 'propose_delete_entity',
      description: 'Zaproponuj usunięcie jednostki z bazy. Używaj oszczędnie — tylko gdy jednostka naprawdę przestała mieć sens (np. duplikat, błąd).',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' }, reasoning: { type: 'string' } },
        required: ['key', 'reasoning'],
      },
    },
    {
      name: 'propose_create_document',
      description: 'Zaproponuj utworzenie nowego dokumentu (albo folderu, jeśli planujesz dodać mu poddokumenty). Żeby zbudować całe drzewo naraz, wywołaj to narzędzie kilka razy w tej samej turze: nadaj dokumentowi-rodzicowi jakiś temp_id (np. "doc1"), a w poddokumentach ustaw parent_ref na ten sam temp_id.',
      parameters: {
        type: 'object',
        properties: {
          temp_id: { type: 'string', description: 'Krótki identyfikator TEGO dokumentu, unikalny w obrębie tej tury — żeby inne wywołania w tej samej turze mogły się do niego odwołać jako do rodzica.' },
          parent_ref: { type: 'string', description: 'ID istniejącego dokumentu w bazie ALBO temp_id innego dokumentu proponowanego w tej samej turze. Pomiń dla elementu głównego (bez rodzica).' },
          title: { type: 'string' },
          content: { type: 'string', description: 'Treść dokumentu. Może być pusta, jeśli to ma być folder.' },
          reasoning: { type: 'string' },
        },
        required: ['temp_id', 'title', 'reasoning'],
      },
    },
    {
      name: 'propose_update_document',
      description: 'Zaproponuj zmianę tytułu i/lub treści istniejącego dokumentu.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID istniejącego dokumentu.' },
          title: { type: 'string' },
          content: { type: 'string' },
          reasoning: { type: 'string' },
        },
        required: ['id', 'reasoning'],
      },
    },
    {
      name: 'propose_delete_document',
      description: 'Zaproponuj usunięcie dokumentu razem z jego poddokumentami. Używaj oszczędnie.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, reasoning: { type: 'string' } },
        required: ['id', 'reasoning'],
      },
    },
    {
      name: 'propose_move_document',
      description: 'Zaproponuj przeniesienie istniejącego dokumentu pod innego rodzica (reorganizacja drzewa).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          new_parent_id: { type: 'string', description: 'ID nowego dokumentu-rodzica. Pomiń, żeby przenieść na najwyższy poziom.' },
          reasoning: { type: 'string' },
        },
        required: ['id', 'reasoning'],
      },
    },
    {
      name: 'search_documents',
      description: 'Przeszukaj istniejące dokumenty po tytule/treści, żeby sprawdzić, czy coś już istnieje, zanim zaproponujesz nowy dokument (unikaj duplikatów). To zapytanie tylko do odczytu — wykonuje się od razu, bez zatwierdzania.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    {
      name: 'flag_inconsistency',
      description: 'Zgłoś konkretną sprzeczność logiczną między nową treścią a tym, co już ustalono w bazie. Nie wymaga zatwierdzenia — trafia od razu do użytkownika jako ostrzeżenie.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}];

// Wykonuje jedno wywołanie narzędzia zgłoszone przez model. Zwraca kind:
// 'inconsistency' (od razu do usera), 'tool' (wynik odczytu, np. search),
// albo 'proposal' (zapisane w kolejce, czeka na zatwierdzenie).
async function executeFunctionCall(fc, batchId) {
  const name = fc.name;
  const args = fc.args || {};

  if (name === 'flag_inconsistency') {
    return { kind: 'inconsistency', text: args.text || '', response: { status: 'ok' } };
  }

  if (name === 'search_documents') {
    if (!supabase) return { kind: 'tool', response: { error: 'Baza dokumentów niedostępna.' } };
    const q = String(args.query || '').toLowerCase();
    const { data, error } = await supabase.from('documents').select('id,title,content,parent_id').limit(300);
    if (error) return { kind: 'tool', response: { error: error.message } };
    const matches = (data || [])
      .filter((d) => d.title.toLowerCase().includes(q) || (d.content || '').toLowerCase().includes(q))
      .slice(0, 15)
      .map((d) => ({ id: d.id, title: d.title, parent_id: d.parent_id, snippet: (d.content || '').slice(0, 200) }));
    return { kind: 'tool', response: { matches } };
  }

  // Wszystko inne to propose_* — zapisz jako propozycję oczekującą.
  const action = name.replace(/^propose_/, '');
  const reasoning = args.reasoning || null;
  const payload = { ...args };
  delete payload.reasoning;

  if (!supabase) {
    return { kind: 'tool', response: { error: 'Baza danych niedostępna — nie można zapisać propozycji.' } };
  }

  const { data: row, error } = await supabase
    .from('proposals')
    .insert({ batch_id: batchId, action, payload, reasoning, status: 'pending' })
    .select()
    .single();

  if (error) return { kind: 'tool', response: { error: error.message } };
  return {
    kind: 'proposal',
    proposal: row,
    response: { status: 'proposed', proposal_id: row.id, note: 'Zapisano jako propozycję oczekującą na zatwierdzenie użytkownika. To jeszcze nie jest część bazy.' },
  };
}

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

function describeFinishReason(finishReason) {
  if (finishReason === 'SAFETY') return 'Odpowiedź została zablokowana przez filtry bezpieczeństwa Gemini (finishReason: SAFETY).';
  if (finishReason === 'MAX_TOKENS') return 'Odpowiedź została ucięta, bo przekroczyła limit tokenów mimo automatycznych ponowień (finishReason: MAX_TOKENS) — spróbuj krótszej wiadomości.';
  if (finishReason === 'RECITATION') return 'Gemini odmówił odpowiedzi z powodu podejrzenia o cytowanie chronionej treści (finishReason: RECITATION).';
  return `Model nie zwrócił żadnej treści (finishReason: ${finishReason || 'nieznany'}).`;
}

// ---------- Czat z Gemini: agentowa pętla wywołań narzędzi ----------

app.post('/api/chat', asyncRoute(async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Brak skonfigurowanego klucza GEMINI_API_KEY na serwerze.' });
  }

  const { contents, systemInstruction } = req.body || {};
  if (!Array.isArray(contents)) {
    return res.status(400).json({ error: 'Brak pola "contents" w zapytaniu.' });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const batchId = randomUUID();
  let workingContents = [...contents];
  let finalText = '';
  const proposals = [];
  const inconsistencies = [];

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const { geminiResponse, data } = await callGeminiWithRetry(url, {
        contents: workingContents,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        safetySettings: SAFETY_SETTINGS,
        tools: TOOLS,
        generationConfig: {
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          // 'low' zamiast 'minimal': to zadanie wymaga trochę rozumowania,
          // żeby dobrze dobrać narzędzia i kolejność ich wywołań.
          thinkingConfig: { thinkingLevel: 'low' },
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
          proposals: [],
          inconsistencies: [],
          blocked: true,
        });
      }

      const candidate = data.candidates && data.candidates[0];
      const content = candidate && candidate.content;
      const parts = (content && content.parts) || [];
      const finishReason = candidate && candidate.finishReason;

      const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const textPieces = parts.filter((p) => typeof p.text === 'string' && p.text).map((p) => p.text);
      if (textPieces.length) finalText += (finalText ? '\n' : '') + textPieces.join('');

      if (!functionCalls.length) {
        if (!finalText) finalText = describeFinishReason(finishReason);
        break;
      }

      // Dopisz turę modelu tak, jak przyszła (z częściami functionCall) —
      // wymagane, żeby kolejne zapytanie miało spójną historię.
      workingContents.push({ role: 'model', parts });

      const responseParts = [];
      for (const fc of functionCalls) {
        const result = await executeFunctionCall(fc, batchId);
        if (result.kind === 'inconsistency') inconsistencies.push(result.text);
        if (result.kind === 'proposal') proposals.push(result.proposal);
        responseParts.push({ functionResponse: { name: fc.name, response: result.response } });
      }
      workingContents.push({ role: 'user', parts: responseParts });

      if (iter === MAX_TOOL_ITERATIONS - 1 && !finalText) {
        finalText = 'Wykonałem serię działań, ale nie zdążyłem sformułować podsumowania w tej turze — sprawdź zakładkę „Propozycje", zapisałem tam to, co zdążyłem zaproponować.';
      }
    }

    res.json({
      reply: finalText || '(brak treści odpowiedzi)',
      proposals,
      inconsistencies,
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
