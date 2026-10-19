-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- Upload from the planner page.
--
-- These are the only write paths anon can reach, and they are deliberately
-- narrow. The Worker holds the anon key and is a public endpoint — the CORS
-- allowlist stops browsers, not curl — so these functions are written on the
-- assumption that anyone may call them.
--
-- Containment: every uploaded document gets a source_key forced into the
-- 'upload:' namespace, and kb_upload_chunks refuses any document outside it.
-- An uploader therefore cannot overwrite, re-chunk, or empty a harvested
-- transcript, a crawled article, or anything else the pipeline owns. The worst
-- it can do is add to its own namespace, which is the point of the feature.
-- ---------------------------------------------------------------------------

create or replace function public.kb_upload_document(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare
    v_brand uuid;
    v_type  text;
    v_body  text;
    v_key   text;
    v_hash  text;
    v_id    uuid;
    v_old   text;
begin
    v_brand := (select id from kb.brands where slug = coalesce(payload ->> 'brand_slug', 'aiko'));
    if v_brand is null then
        raise exception 'unknown brand';
    end if;

    v_type := lower(coalesce(payload ->> 'document_type', 'other'));
    if v_type not in ('transcript','research','article','report','recording','interview','other') then
        raise exception 'unsupported document_type: %', v_type;
    end if;

    v_body := coalesce(payload ->> 'raw_content', '');
    if length(btrim(v_body)) < 40 then
        raise exception 'document is empty or too short to be worth retrieving';
    end if;
    if length(v_body) > 500000 then
        raise exception 'document is too large (% characters, limit 500000)', length(v_body);
    end if;

    /* The namespace is imposed here, not accepted from the caller. Passing
     * 'file:kb/files/research/x.md' must not let an upload take over a
     * pipeline-owned row, so any prefix the caller sends is stripped. */
    v_key := 'upload:' || regexp_replace(coalesce(payload ->> 'source_key', ''), '^[a-z]+:', '');
    if v_key = 'upload:' then
        raise exception 'source_key is required';
    end if;

    v_hash := encode(extensions.digest(v_body, 'sha256'), 'hex');

    select id, content_hash into v_id, v_old
    from kb.documents where brand_id = v_brand and source_key = v_key;

    insert into kb.documents (
        brand_id, document_type, title, source, source_url, published_at,
        source_key, content_hash, raw_content, metadata, status
    )
    values (
        v_brand, v_type,
        left(coalesce(nullif(btrim(payload ->> 'title'), ''), 'Untitled upload'), 300),
        nullif(btrim(coalesce(payload ->> 'source', '')), ''),
        null,
        (payload ->> 'published_at')::timestamptz,
        v_key, v_hash, v_body,
        coalesce(payload -> 'metadata', '{}'::jsonb)
            || jsonb_build_object('ingest_route', 'upload', 'uploaded_at', now()),
        'pending'
    )
    on conflict (brand_id, source_key) do update set
        document_type = excluded.document_type,
        title         = excluded.title,
        source        = excluded.source,
        published_at  = excluded.published_at,
        metadata      = excluded.metadata,
        raw_content   = case when kb.documents.content_hash is distinct from excluded.content_hash
                             then excluded.raw_content else kb.documents.raw_content end,
        content_hash  = excluded.content_hash,
        status        = case when kb.documents.content_hash is distinct from excluded.content_hash
                             then 'pending' else kb.documents.status end
    returning id into v_id;

    if v_old is null or v_old is distinct from v_hash then
        delete from kb.document_chunks where document_id = v_id;
        update kb.documents set chunk_count = 0 where id = v_id;
        return jsonb_build_object('id', v_id, 'changed', true);
    end if;

    return jsonb_build_object('id', v_id, 'changed', false);
end;
$fn$;

create or replace function public.kb_upload_chunks(p_document_id uuid, payload jsonb)
returns integer
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare
    v_brand uuid;
    v_key   text;
    n integer;
begin
    select brand_id, source_key into v_brand, v_key
    from kb.documents where id = p_document_id;

    if v_brand is null then
        raise exception 'no such document';
    end if;

    /* The containment check. Without it, an uploader who learned any document
     * id could replace the chunks of a harvested podcast with text of their
     * choosing, and the planner would cite it as the brand's own words. */
    if v_key not like 'upload:%' then
        raise exception 'this document was not uploaded and cannot be rewritten here';
    end if;

    if jsonb_array_length(payload) > 400 then
        raise exception 'too many chunks (%), limit 400', jsonb_array_length(payload);
    end if;

    delete from kb.document_chunks where document_id = p_document_id;

    insert into kb.document_chunks
        (document_id, brand_id, chunk_index, heading, content, token_count, metadata, embedding)
    select
        p_document_id, v_brand,
        (e ->> 'chunk_index')::integer,
        left(e ->> 'heading', 500),
        left(e ->> 'content', 20000),
        (e ->> 'token_count')::integer,
        coalesce(e -> 'metadata', '{}'::jsonb),
        nullif(btrim(coalesce(e ->> 'embedding', '')), '')::extensions.vector(1024)
    from jsonb_array_elements(payload) e
    where length(btrim(coalesce(e ->> 'content', ''))) > 0;

    get diagnostics n = row_count;

    update kb.documents
       set chunk_count   = n,
           status        = case when n > 0 then 'ready' else 'failed' end,
           status_detail = case when n > 0 then null else 'upload produced no chunks' end,
           processed_at  = now()
     where id = p_document_id;

    return n;
end;
$fn$;

-- Anon may call these two and nothing else that writes.
grant execute on function public.kb_upload_document(jsonb) to anon, authenticated, service_role;
grant execute on function public.kb_upload_chunks(uuid, jsonb) to anon, authenticated, service_role;

comment on function public.kb_upload_document is
  'Upload path for the planner page. Forces the upload: source_key namespace so '
  'an uploader can never take over a pipeline-owned document.';
comment on function public.kb_upload_chunks is
  'Writes chunks for an uploaded document only. Refuses any document whose '
  'source_key is outside the upload: namespace.';;
