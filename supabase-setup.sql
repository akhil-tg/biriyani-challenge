-- Biriyani Challenge — Fresh-start schema (name + PIN auth, no Supabase Auth)
--
-- ⚠️ RUNNING THIS WIPES ALL EXISTING DATA (coordinators, items, orders).
-- Run the whole script in the Supabase SQL Editor once.
--
-- Auth model: coordinators (incl. the admin, flagged is_admin) log in with
-- name + 6-digit PIN. PINs are stored only as PBKDF2-SHA256 hashes.
-- Access tokens are HMAC-signed by the worker using the AUTH_SECRET secret.

drop table if exists orders;
drop table if exists items;
drop table if exists coordinators;
drop sequence if exists coordinators_id_seq;
drop sequence if exists items_id_seq;
drop sequence if exists orders_id_seq;
drop sequence if exists orders_token_seq;

create sequence coordinators_id_seq;
create sequence items_id_seq;
create sequence orders_id_seq;
create sequence orders_token_seq;

create table coordinators (
  id         bigint primary key default nextval('coordinators_id_seq'),
  name       text not null,
  pin_hash   text not null,
  is_admin   boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table items (
  id     bigint primary key default nextval('items_id_seq'),
  name   text not null,
  price  int not null default 0,
  sort   int not null default 0,
  active boolean not null default true
);

create table orders (
  id                bigint primary key default nextval('orders_id_seq'),
  token_no          bigint not null default nextval('orders_token_seq'),
  taken_by          bigint,
  taken_by_name     text,
  customer_name     text not null,
  customer_phone    text,
  customer_place    text,
  customer_address  text,
  total             int not null default 0,
  status            text not null default 'pending',
  cash_collected    int,
  delivered_by      bigint,
  delivered_by_name text,
  delivered_at      timestamptz,
  items             jsonb not null default '[]',
  request_key       text unique,
  created_at        timestamptz not null default now()
);

-- Optional menu seed (remove the comments to load it)
-- insert into items (name, price, sort) values
--   ('Chicken Biriyani', 120, 1),
--   ('Mutton Biriyani', 180, 2),
--   ('Veg Biriyani', 100, 3),
--   ('Fried Rice', 90, 4),
--   ('Ghee Rice (Half)', 60, 5),
--   ('Lime Juice', 20, 6);
