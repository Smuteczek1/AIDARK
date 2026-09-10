# DARK — Archiwum

Czat ze wspomaganiem AI (Gemini) do budowania spójnego lore uniwersum DARK.
Frontend to statyczny HTML (`public/index.html`), backend to mały serwer
Node.js/Express (`server.js`), który chowa klucz Gemini i przekazuje zapytania dalej.

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env
# wklej swój klucz z https://aistudio.google.com/apikey do pliku .env
npm start
```

Aplikacja wystartuje na `http://localhost:3000`.

## Struktura

```
dark-archiwum/
├── public/
│   └── index.html      # frontend (czat + baza jednostek)
├── server.js            # backend — proxy do Gemini API
├── package.json
├── .env.example          # wzór zmiennych środowiskowych (bez klucza!)
└── .gitignore
```

## Wdrożenie na Render

1. Wypchnij ten projekt na GitHub (patrz niżej).
2. Na [dashboard.render.com](https://dashboard.render.com) kliknij **New +** → **Web Service**.
3. Połącz swoje konto GitHub i wybierz to repozytorium.
4. Ustaw:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. W zakładce **Environment** dodaj zmienną `GEMINI_API_KEY` (Twój klucz z aistudio.google.com).
6. Kliknij **Create Web Service** — Render zbuduje i wystartuje appkę pod adresem
   `https://twoja-nazwa.onrender.com`.

Każdy `git push` na branch główny automatycznie wywoła nowy deploy.

## Uwaga o kluczu Gemini

Klucz Gemini istnieje WYŁĄCZNIE jako zmienna środowiskowa na Renderze —
nigdy nie trafia do repozytorium ani do kodu frontendu.

## Supabase (później)

Obecnie stan (historia rozmowy + baza jednostek) trzyma się w `localStorage`
przeglądarki — czyli lokalnie, tylko na jednym urządzeniu/przeglądarce.
Gdy dojdzie Supabase, `entities` i `messages` można przenieść do tabel Postgresa,
żeby archiwum było wspólne dla wszystkich urządzeń/osób.
