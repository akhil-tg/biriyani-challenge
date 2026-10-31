-- Biriyani Challenge — normalized tables (run ONCE in Supabase SQL Editor)
-- Creates clean tables: coordinators, items, orders (+ sequences for ids/tokens)

create sequence if not exists coordinators_id_seq;
create sequence if not exists items_id_seq;
create sequence if not exists orders_id_seq;
create sequence if not exists orders_token_seq;

create table if not exists coordinators (
  id         bigint primary key default nextval('coordinators_id_seq'),
  auth_uid   uuid unique,
  name       text not null,
  email      text,
  is_admin   boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists items (
  id     bigint primary key default nextval('items_id_seq'),
  name   text not null,
  price  int not null default 0,
  sort   int not null default 0,
  active boolean not null default true
);

create table if not exists orders (
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
  created_at        timestamptz not null default now()
);
