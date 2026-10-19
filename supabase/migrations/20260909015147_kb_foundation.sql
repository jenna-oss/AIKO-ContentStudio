create schema if not exists kb;

create extension if not exists vector with schema extensions;

comment on schema kb is 'Content intelligence knowledge base: ingested source material, its embeddings, published content, idea memory, and the retrieval layer over all of it.';

create table if not exists kb.embedding_config (
    singleton   boolean primary key default true check (singleton),
    provider    text        not null,
    model       text        not null,
    dimensions  integer     not null check (dimensions between 1 and 16000),
    input_type_supported boolean not null default true,
    notes       text,
    updated_at  timestamptz not null default now()
);

comment on table kb.embedding_config is 'Single row. The embedding model currently in force. Application code reads dimensions from here and never hard-codes it.';
comment on column kb.embedding_config.input_type_supported is 'True when the provider distinguishes query embeddings from document embeddings (Voyage does; asymmetric encoding measurably improves recall). The pipeline passes input_type only when this is true.';

insert into kb.embedding_config (singleton, provider, model, dimensions, input_type_supported, notes)
values (true, 'voyage', 'voyage-3.5', 1024, true,
        'Voyage supports Matryoshka output_dimension of 256/512/1024/2048. 1024 is the default and the value the vector columns are declared at.')
on conflict (singleton) do nothing;

create table if not exists kb.ranking_weights (
    intent      text primary key,
    semantic    numeric(4,3) not null default 0.600 check (semantic  between 0 and 1),
    keyword     numeric(4,3) not null default 0.200 check (keyword   between 0 and 1),
    recency     numeric(4,3) not null default 0.200 check (recency   between 0 and 1),
    strategic   numeric(4,3) not null default 0.000 check (strategic between 0 and 1),
    diversity_penalty numeric(4,3) not null default 0.150 check (diversity_penalty between 0 and 1),
    max_per_document  integer not null default 2 check (max_per_document >= 1),
    notes       text,
    updated_at  timestamptz not null default now()
);

comment on table kb.ranking_weights is 'Configurable ranking weights per query intent (spec section 21 and 28). Scores built from these are never exposed to the user.';
comment on column kb.ranking_weights.diversity_penalty is 'Score multiplier subtracted per additional chunk already taken from the same document, applied during reranking (spec section 24).';
comment on column kb.ranking_weights.max_per_document is 'Hard ceiling on chunks returned from any single document, so five consecutive chunks of one podcast can never fill the result set.';

insert into kb.ranking_weights (intent, semantic, keyword, recency, strategic, diversity_penalty, max_per_document, notes) values
    ('DEFAULT',    0.600, 0.200, 0.200, 0.000, 0.150, 2, 'Spec 21 weights with strategic held at 0 and the rest renormalised.'),
    ('DISCOVERY',  0.600, 0.120, 0.280, 0.000, 0.250, 1, 'Finding topics: lean on recency, and spread hard across sources.'),
    ('SUPPORT',    0.640, 0.280, 0.080, 0.000, 0.100, 3, 'Evidence for a chosen topic: precision over freshness.'),
    ('REPETITION', 0.680, 0.240, 0.080, 0.000, 0.050, 5, 'Have we said this before: recall matters more than variety.'),
    ('SOURCE',     0.400, 0.560, 0.040, 0.000, 0.000, 5, 'Where did this exact statement come from: keyword carries it.'),
    ('RECALL',     0.660, 0.220, 0.120, 0.000, 0.150, 3, 'Something the user mentioned earlier; phrasing will be approximate.'),
    ('TIMELY',     0.440, 0.140, 0.420, 0.000, 0.200, 2, 'Recent developments: recency is most of the question.')
on conflict (intent) do nothing;

create table if not exists kb.recency_curve (
    age_days integer primary key check (age_days >= 0),
    factor   numeric(4,3) not null check (factor between 0 and 1)
);

insert into kb.recency_curve (age_days, factor) values
    (0, 1.000), (7, 0.950), (30, 0.850), (90, 0.650), (365, 0.300), (1095, 0.100)
on conflict (age_days) do nothing;

comment on table kb.recency_curve is 'Control points for the recency decay curve (spec section 22). Interpolated linearly between knots, flat after the last one.';

create table if not exists kb.recency_profile (
    document_type text primary key,
    tau           numeric(5,2) not null default 1.00 check (tau > 0),
    notes         text
);

insert into kb.recency_profile (document_type, tau, notes) values
    ('research',   1.00, 'Strong recency weighting: a market report ages fast.'),
    ('report',     1.00, 'Same as research.'),
    ('article',    1.50, 'Ages, but less sharply than a rates report.'),
    ('transcript', 3.00, 'Evergreen: an explanation of how DSCR works does not expire.'),
    ('recording',  3.00, 'Evergreen.'),
    ('interview',  3.00, 'Evergreen.'),
    ('other',      2.00, 'Unknown provenance, middling decay.'),
    ('published',  1.00, 'Published content: recency matters for repetition detection, not merit.')
on conflict (document_type) do nothing;

comment on column kb.recency_profile.tau is 'Age divisor. tau = 3 means a 90-day-old transcript is scored as though it were 30 days old, which is how "lower recency weighting for evergreen material" is expressed against a single shared curve.';

create table if not exists kb.brands (
    id          uuid primary key default gen_random_uuid(),
    slug        text not null unique,
    name        text not null,
    description text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

comment on table kb.brands is 'Spec section 5. One row per brand. AIKO is brand one.';

create table if not exists kb.content_strategies (
    id           uuid primary key default gen_random_uuid(),
    brand_id     uuid not null references kb.brands(id) on delete cascade,
    audience     text,
    positioning  text,
    goals        jsonb not null default '[]'::jsonb,
    core_beliefs jsonb not null default '[]'::jsonb,
    tone         jsonb not null default '{}'::jsonb,
    is_current   boolean not null default true,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create unique index if not exists content_strategies_one_current
    on kb.content_strategies (brand_id) where is_current;

create table if not exists kb.content_pillars (
    id          uuid primary key default gen_random_uuid(),
    brand_id    uuid not null references kb.brands(id) on delete cascade,
    name        text not null,
    description text,
    priority    integer not null default 1,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now()
);

create index if not exists content_pillars_brand on kb.content_pillars (brand_id, priority);
create unique index if not exists content_pillars_brand_name on kb.content_pillars (brand_id, lower(name));

comment on table kb.content_pillars is 'Spec section 5. Deliberately unembedded (section 12) — the pillar set is small enough to hand the planner whole.';

insert into kb.brands (slug, name, description)
values ('aiko', 'AIKO Group',
        'AIKO Content Studio: a self-serve tool that turns one planning conversation into a week of finished, on-brand educational videos for founders of expertise-led businesses.')
on conflict (slug) do nothing;;
