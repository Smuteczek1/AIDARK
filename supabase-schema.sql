-- Uruchom to RAZ w Supabase: Dashboard -> Twój projekt -> SQL Editor -> New query -> wklej -> Run

create extension if not exists pgcrypto;

-- Baza jednostek (to samo, co dotąd trzymało się w localStorage)
create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,          -- nazwa.toLowerCase(), klucz naturalny
  name text not null,
  kategoria text,
  tajnosc text,
  opis text,
  status text,
  powiazania text,
  nadrzedna text,
  updated_at timestamptz not null default now()
);

-- Dokumenty: każdy wiersz może być zarówno "dokumentem" jak i "folderem" —
-- jeśli ma dzieci (inne dokumenty wskazujące na niego jako parent_id),
-- w interfejsie zachowuje się jak folder. parent_id = null -> element główny.
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references documents(id) on delete cascade,
  title text not null,
  content text not null default '',
  created_by text not null default 'user',  -- 'user' albo 'ai' (na przyszłość)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_parent_id_idx on documents (parent_id);
