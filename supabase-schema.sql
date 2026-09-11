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

-- Propozycje: AI nigdy nie zmienia entities/documents bezpośrednio. Każda
-- akcja (create/update/delete jednostki, create/update/delete/move
-- dokumentu) trafia najpierw tutaj jako "pending" i czeka na ręczne
-- zatwierdzenie/odrzucenie przez użytkownika w panelu "Propozycje".
-- batch_id grupuje wszystkie propozycje wygenerowane w jednej turze czatu
-- (np. cały drzewo dokumentów naraz), żeby dało się je zatwierdzić razem.
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  action text not null,   -- create_entity | update_entity | delete_entity |
                          -- create_document | update_document | delete_document | move_document
  payload jsonb not null,
  reasoning text,
  status text not null default 'pending',  -- pending | approved | rejected
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists proposals_status_idx on proposals (status);
create index if not exists proposals_batch_idx on proposals (batch_id);
