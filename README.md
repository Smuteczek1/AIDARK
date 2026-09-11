# DARK — Archiwum

Czat ze wspomaganiem AI (Gemini) do budowania spójnego lore uniwersum DARK,
plus wspólna baza jednostek i drzewo dokumentów/folderów (Supabase).

- `public/index.html` — frontend (czat, baza jednostek, dokumenty)
- `server.js` — backend: proxy do Gemini + REST API do Supabase
- `supabase-schema.sql` — SQL do jednorazowego uruchomienia w Supabase

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env
# wklej do .env: klucz Gemini oraz dane Supabase (patrz sekcja niżej)
npm start
```

Aplikacja wystartuje na `http://localhost:3000`.

## Konfiguracja Supabase

1. Załóż darmowy projekt na [supabase.com](https://supabase.com).
2. W panelu projektu wejdź w **SQL Editor** → **New query**, wklej całą zawartość
   pliku `supabase-schema.sql` i kliknij **Run**. To tworzy dwie tabele:
   `entities` (baza jednostek) i `documents` (drzewo dokumentów/folderów).
3. Wejdź w **Project Settings** → **API** i skopiuj:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** (sekretny klucz, NIE `anon`) → `SUPABASE_SERVICE_KEY`
4. Wklej obie wartości do `.env` (lokalnie) i jako zmienne środowiskowe w Render
   (Environment → dodaj `SUPABASE_URL` i `SUPABASE_SERVICE_KEY`).

`service_role` omija reguły bezpieczeństwa (RLS) i ma pełny dostęp do bazy —
dlatego istnieje WYŁĄCZNIE po stronie serwera (zmienna środowiskowa), nigdy
w kodzie frontendu.

### Aktualizacja istniejącego projektu (masz już `entities`/`documents`)

`supabase-schema.sql` używa `create table if not exists`, więc bezpiecznie
uruchomisz cały plik ponownie — istniejące tabele `entities` i `documents`
zostaną nietknięte, dopisze się tylko nowa tabela `proposals` (kolejka
propozycji AI czekających na zatwierdzenie). Nic nie trzeba czyścić ręcznie.

## Jak to działa

- **Agent z narzędziami** — Gemini nie zwraca już jednego sztywnego bloku
  JSON. Dostaje zestaw osobnych narzędzi (function calling):
  `propose_create_entity`, `propose_update_entity`, `propose_delete_entity`,
  `propose_create_document`, `propose_update_document`,
  `propose_delete_document`, `propose_move_document`, `search_documents`
  i `flag_inconsistency`. W jednej turze może wywołać ich dowolną liczbę,
  w dowolnej kolejności (np. najpierw sprawdzić `search_documents`, żeby
  uniknąć duplikatu, potem złożyć kilka propozycji, na końcu odpowiedzieć
  tekstem) — backend (`/api/chat`) obsługuje to jako pętlę: wysyła
  wiadomość do Gemini, wykonuje zgłoszone wywołania, odsyła wyniki, i tak
  aż model skończy i zwróci czysty tekst.
- **Propozycje zamiast bezpośrednich zmian** — każde wywołanie `propose_*`
  NIE zmienia bazy od razu. Zapisuje wiersz w tabeli `proposals` (status
  `pending`) razem z uzasadnieniem AI. Zmiana trafia do bazy dopiero, gdy
  człowiek ją zatwierdzi w zakładce **Propozycje** w bocznym panelu —
  pojedynczo albo całą partią naraz (np. całe drzewo dokumentów założone
  w jednej turze). Odrzucona propozycja znika bez śladu w bazie.
  `flag_inconsistency` to wyjątek — to tylko ostrzeżenie tekstowe, nie
  zmienia niczego, więc nie wymaga zatwierdzania.
- **Baza jednostek** — wspólna dla wszystkich, kto wejdzie na stronę.
  Zmienia się tylko przez zatwierdzone propozycje AI albo ręcznie,
  przyciskiem "+ Nowa" / edycją karty w zakładce Jednostki.
- **Dokumenty** — druga zakładka w bocznym panelu. Każdy dokument może mieć
  poddokumenty — jeśli ma dzieci, w praktyce działa jak folder, jeśli nie,
  jest zwykłym dokumentem z treścią. Można zagnieżdżać dowolnie głęboko,
  ręcznie albo przez zatwierdzone propozycje AI (które budują całe drzewo
  naraz, odwołując się do tymczasowych `temp_id` w obrębie jednej tury).
- **Historia czatu** — zostaje lokalnie w przeglądarce (`localStorage`), więc
  przycisk "Resetuj" czyści tylko Twój lokalny podgląd rozmowy, nie rusza
  wspólnej bazy jednostek, dokumentów ani kolejki propozycji.

## Wdrożenie na Render

1. Wypchnij projekt na GitHub (`git add .`, `git commit`, `git push`).
2. Na [dashboard.render.com](https://dashboard.render.com): **New +** → **Web Service**
   → wybierz repo.
3. Environment: `Node` · Build Command: `npm install` · Start Command: `npm start`.
4. W zakładce **Environment** dodaj: `GEMINI_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`.
5. **Create Web Service** — każdy kolejny `git push` na branch główny
   automatycznie wywoła nowy deploy.
