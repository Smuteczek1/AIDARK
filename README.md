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

## Jak to działa

- **Baza jednostek** — wspólna dla wszystkich, kto wejdzie na stronę. Gemini
  dopisuje/aktualizuje jednostki automatycznie po każdej turze czatu (backend
  zapisuje je od razu do Supabase), a Ty możesz też dodawać/edytować/usuwać
  ręcznie przyciskiem "+ Nowa" w zakładce Jednostki.
- **Dokumenty** — druga zakładka w bocznym panelu. Każdy dokument może mieć
  poddokumenty (przycisk "+ pod" przy dowolnym elemencie) — jeśli ma dzieci,
  w praktyce działa jak folder, jeśli nie, jest zwykłym dokumentem z treścią.
  Można zagnieżdżać dowolnie głęboko. Na razie dokumenty tworzą/edytują tylko
  ludzie — AI ich nie dotyka (można to dodać później, jeśli chcecie).
- **Historia czatu** — zostaje lokalnie w przeglądarce (`localStorage`), więc
  przycisk "Resetuj" czyści tylko Twój lokalny podgląd rozmowy, nie rusza
  wspólnej bazy jednostek ani dokumentów.

## Wdrożenie na Render

1. Wypchnij projekt na GitHub (`git add .`, `git commit`, `git push`).
2. Na [dashboard.render.com](https://dashboard.render.com): **New +** → **Web Service**
   → wybierz repo.
3. Environment: `Node` · Build Command: `npm install` · Start Command: `npm start`.
4. W zakładce **Environment** dodaj: `GEMINI_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`.
5. **Create Web Service** — każdy kolejny `git push` na branch główny
   automatycznie wywoła nowy deploy.
