-- ============================================================
-- Bacly Admin : à coller UNE FOIS dans Supabase → SQL Editor → New query → Run
-- Remplace ton-email@exemple.com (ligne « insert into public.admins ») par ton e-mail.
-- ============================================================

-- 1) Qui a le droit de déposer : la liste des administrateurs
create table if not exists public.admins (email text primary key);
insert into public.admins (email) values (lower('mandestephane5@gmail.com')) on conflict do nothing;
alter table public.admins enable row level security;

create or replace function public.est_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
grant execute on function public.est_admin() to authenticated;

-- 2) Les dépôts faits depuis le téléphone (le PC les récupère)
create table if not exists public.depots (
  id uuid primary key default gen_random_uuid(),
  cree timestamptz not null default now(),
  maj timestamptz not null default now(),
  nom text not null check (char_length(nom) between 1 and 200),
  fichier text not null,                 -- chemin dans le casier « depot »
  taille bigint not null default 0,
  source text not null default 'fichier' check (source in ('fichier', 'photos')),
  matiere text, type text, annee text,   -- classement choisi (facultatif)
  statut text not null default 'envoye'
    check (statut in ('envoye', 'au_pc', 'a_verifier', 'a_classer', 'publie', 'erreur', 'a_supprimer')),
  message text,
  resultat jsonb                         -- ce que le PC a décidé : matière, type, année, titre, pages
);
create index if not exists depots_statut on public.depots (statut, cree);
alter table public.depots enable row level security;
drop policy if exists "admin depots" on public.depots;
create policy "admin depots" on public.depots for all to authenticated using (public.est_admin()) with check (public.est_admin());
grant select, insert, update, delete on public.depots to authenticated;

-- 3) État du PC (le serveur écrit « je suis allumé » toutes les 30 s)
create table if not exists public.etat_pc (
  id int primary key default 1 check (id = 1),
  vu timestamptz,
  version text,
  matieres jsonb,
  types jsonb
);
alter table public.etat_pc enable row level security;
drop policy if exists "admin lit etat" on public.etat_pc;
create policy "admin lit etat" on public.etat_pc for select to authenticated using (public.est_admin());
grant select on public.etat_pc to authenticated;

-- 4) Demandes des élèves (table déjà créée par le serveur) : l'admin peut les lire et les marquer « traitées »
do $$ begin
  if to_regclass('public.demandes') is not null then
    execute 'drop policy if exists "admin lit demandes" on public.demandes';
    execute 'create policy "admin lit demandes" on public.demandes for select to authenticated using (public.est_admin())';
    execute 'drop policy if exists "admin supprime demandes" on public.demandes';
    execute 'create policy "admin supprime demandes" on public.demandes for delete to authenticated using (public.est_admin())';
    execute 'grant select, delete on public.demandes to authenticated';
  end if;
end $$;

-- 5) Casier privé « depot » pour les fichiers envoyés (50 Mo max par fichier)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('depot', 'depot', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'];

drop policy if exists "admin depose" on storage.objects;
create policy "admin depose" on storage.objects for insert to authenticated with check (bucket_id = 'depot' and public.est_admin());
drop policy if exists "admin lit depot" on storage.objects;
create policy "admin lit depot" on storage.objects for select to authenticated using (bucket_id = 'depot' and public.est_admin());
drop policy if exists "admin efface depot" on storage.objects;
create policy "admin efface depot" on storage.objects for delete to authenticated using (bucket_id = 'depot' and public.est_admin());
