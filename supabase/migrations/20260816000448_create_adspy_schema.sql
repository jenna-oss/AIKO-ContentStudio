-- Competitive ad corpus. Isolated in its own schema so it never tangles with
-- the scraper tables in public.
create schema if not exists adspy;

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- advertisers
create table adspy.advertisers (
  id            bigserial primary key,
  name          text not null unique,
  fb_page_id    text unique,
  fb_followers  integer,
  ig_handle     text,
  ig_followers  integer,
  -- lender | broker | loan_officer | creator | other
  kind          text not null default 'other',
  -- true when the daily job queries this advertiser by page id directly
  is_tracked    boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table adspy.advertisers is
  'One row per advertiser. fb_page_id is the numeric Facebook page id used to query Meta''s Ad Library exactly; name-based lookup fuzzy-matches badly and should not be relied on.';

-- ----------------------------------------------------------------------- ads
create table adspy.ads (
  library_id      text primary key,
  advertiser_id   bigint references adspy.advertisers(id) on delete set null,
  -- denormalised so the common filter needs no join
  advertiser_name text not null,
  copy            text not null default '',
  -- started: when the advertiser launched it, per Meta.
  -- first_seen: when OUR sweep first observed it. Only first_seen is ours, and
  -- it is the only honest basis for "new this week" — Meta offers no recency sort.
  started         date,
  first_seen      date not null,
  last_seen       date not null,
  seen_count      integer not null default 1,
  -- which sweep found it, e.g. kw:dscr, page:kiavi, api:HOUSING_ADS
  source          text,
  platform        text,
  -- derived tags: dscr, fix-and-flip, bridge, ground-up, portfolio
  product_lines   text[] not null default '{}',
  -- borrower | broker | unknown
  audience        text not null default 'unknown',
  raw             jsonb,
  copy_tsv        tsvector generated always as (to_tsvector('english', coalesce(copy, ''))) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column adspy.ads.first_seen is
  'Date our sweep first observed this ad. Distinct from started, which is Meta''s launch date.';

-- --------------------------------------------------------------------- sweeps
-- Run log, so a gap in the data can be told apart from a gap in the market.
create table adspy.sweeps (
  id                 bigserial primary key,
  run_at             timestamptz not null default now(),
  source             text not null default 'scrape',
  healthy            boolean not null,
  ads_found          integer,
  advertisers_found  integer,
  new_ads            integer,
  per_target         jsonb,
  notes              text
);

-- -------------------------------------------------------------------- indexes
create index ads_copy_tsv_idx      on adspy.ads using gin (copy_tsv);
create index ads_copy_trgm_idx     on adspy.ads using gin (copy gin_trgm_ops);
create index ads_advertiser_idx    on adspy.ads (advertiser_name);
create index ads_adv_trgm_idx      on adspy.ads using gin (advertiser_name gin_trgm_ops);
create index ads_first_seen_idx    on adspy.ads (first_seen desc);
create index ads_started_idx       on adspy.ads (started desc);
create index ads_product_lines_idx on adspy.ads using gin (product_lines);
create index ads_audience_idx      on adspy.ads (audience);
create index ads_advertiser_fk_idx on adspy.ads (advertiser_id);

-- ------------------------------------------------------------------------ RLS
-- Read-only to anon/authenticated; writes go through the service role only.
-- The existing public tables were left without RLS; not repeating that here.
alter table adspy.advertisers enable row level security;
alter table adspy.ads         enable row level security;
alter table adspy.sweeps      enable row level security;

create policy "read advertisers" on adspy.advertisers for select to anon, authenticated using (true);
create policy "read ads"         on adspy.ads         for select to anon, authenticated using (true);
create policy "read sweeps"      on adspy.sweeps      for select to anon, authenticated using (true);

grant usage on schema adspy to anon, authenticated, service_role;
grant select on all tables in schema adspy to anon, authenticated;
grant all    on all tables in schema adspy to service_role;
grant usage, select on all sequences in schema adspy to service_role;;
