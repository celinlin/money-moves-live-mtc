-- Demonstration content. Seeded once per host account (flagged is_sample, shown
-- with an "Exemple" badge) and never mixed with imported or user-created quizzes.

create or replace function public._sample_documents() returns jsonb language sql immutable as $json$
select $$[
{
  "title": "Money Talks — le sondage",
  "description": "11 questions anonymes pour lancer la discussion : épargne, investissement, ambitions.",
  "show_leaderboard": false,
  "is_sample": true,
  "questions": [
    {"kind":"poll","question_text":"As-tu déjà investi ?","time_limit_sec":30,
     "options":[{"text":"Oui, régulièrement"},{"text":"Oui, une fois ou deux"},{"text":"Pas encore mais je veux"},{"text":"Non"}]},
    {"kind":"poll","question_text":"Combien tu mets de côté ou investis par mois ?","time_limit_sec":30,
     "options":[{"text":"0 €"},{"text":"< 50 €"},{"text":"50–150 €"},{"text":"150–300 €"},{"text":"300 €+"},{"text":"Je préfère ne pas dire"}]},
    {"kind":"poll","allow_multiple":true,"question_text":"Tu as ouvert quoi ?","time_limit_sec":30,
     "options":[{"text":"Livret A"},{"text":"PEA"},{"text":"Compte-titres"},{"text":"Assurance-vie"},{"text":"PER"},{"text":"Crypto"},{"text":"Rien encore"}]},
    {"kind":"poll","allow_multiple":true,"question_text":"Ce que tu as en portefeuille","time_limit_sec":30,
     "options":[{"text":"ETF World"},{"text":"ETF S&P 500"},{"text":"ETF Nasdaq 100"},{"text":"Actions en direct (Nvidia, LVMH…)"},{"text":"Crypto"},{"text":"Immobilier ou SCPI"},{"text":"Rien"}]},
    {"kind":"poll","question_text":"Ton objectif n°1 en investissant","time_limit_sec":30,
     "options":[{"text":"Faire grossir mon patrimoine"},{"text":"Ma retraite"},{"text":"Un achat (appart…)"},{"text":"Mon indépendance financière"},{"text":"Apprendre"},{"text":"Je ne sais pas encore"}]},
    {"kind":"poll","question_text":"Ton horizon","time_limit_sec":30,
     "options":[{"text":"< 2 ans"},{"text":"2–5 ans"},{"text":"5–10 ans"},{"text":"10 ans+"}]},
    {"kind":"poll","question_text":"Ton profil","time_limit_sec":30,
     "options":[{"text":"🐢 Prudente"},{"text":"🦊 Équilibrée"},{"text":"🚀 Je prends des risques"},{"text":"🙈 Aucune idée"}]},
    {"kind":"poll","question_text":"Qui t’a parlé d’investissement en premier ?","time_limit_sec":30,
     "options":[{"text":"Mes parents"},{"text":"Une amie"},{"text":"Les réseaux sociaux"},{"text":"L’école"},{"text":"Personne"}]},
    {"kind":"poll","allow_multiple":true,"question_text":"Tu t’éduques comment financièrement ?","time_limit_sec":30,
     "options":[{"text":"YouTube"},{"text":"TikTok"},{"text":"Instagram"},{"text":"Newsletters"},{"text":"Podcasts"},{"text":"Livres"},{"text":"Mon entourage"},{"text":"Pas encore"}]},
    {"kind":"poll","question_text":"As-tu déjà négocié ton salaire ?","time_limit_sec":30,
     "options":[{"text":"Oui et j’ai obtenu plus"},{"text":"Oui mais refusé"},{"text":"Non, je n’ai pas osé"},{"text":"Pas encore eu l’occasion"}]},
    {"kind":"poll","question_text":"Tu as un side business à côté ?","time_limit_sec":30,
     "options":[{"text":"Oui, en cours"},{"text":"Oui, une idée"},{"text":"Non"}]}
  ]
},
{
  "title": "Quiz finance express",
  "description": "8 questions notées pour tester ses bases. Rapidité récompensée !",
  "show_leaderboard": true,
  "is_sample": true,
  "questions": [
    {"kind":"quiz","question_text":"Que signifie « ETF » ?","time_limit_sec":20,
     "explanation":"Un ETF (Exchange Traded Fund) est un fonds coté en Bourse qui réplique un indice, comme le MSCI World.",
     "options":[{"text":"Exchange Traded Fund","is_correct":true},{"text":"European Tax Fund"},{"text":"Equity Transfer Fee"},{"text":"Electronic Trading Fund"}]},
    {"kind":"quiz","question_text":"Quel est le plafond de versement du Livret A ?","time_limit_sec":20,
     "explanation":"22 950 € hors intérêts capitalisés : les intérêts peuvent faire dépasser ce plafond.",
     "options":[{"text":"10 000 €"},{"text":"15 300 €"},{"text":"22 950 €","is_correct":true},{"text":"50 000 €"}]},
    {"kind":"quiz","question_text":"À 7 % par an, en combien de temps ton capital double-t-il environ ?","time_limit_sec":20,
     "explanation":"Règle de 72 : 72 ÷ 7 ≈ 10 ans. C'est la magie des intérêts composés.",
     "options":[{"text":"~5 ans"},{"text":"~10 ans","is_correct":true},{"text":"~20 ans"},{"text":"~30 ans"}]},
    {"kind":"quiz","question_text":"Le PEA permet d’investir principalement dans…","time_limit_sec":20,
     "explanation":"Le PEA est réservé aux actions européennes (et aux ETF éligibles, y compris certains ETF World).",
     "options":[{"text":"Des cryptomonnaies"},{"text":"Des actions européennes","is_correct":true},{"text":"De l’immobilier physique"},{"text":"Des matières premières"}]},
    {"kind":"quiz","question_text":"Après combien d’années le PEA devient-il fiscalement avantageux ?","time_limit_sec":20,
     "explanation":"Après 5 ans, les gains ne sont plus soumis à l'impôt sur le revenu (seuls les prélèvements sociaux restent dus).",
     "options":[{"text":"2 ans"},{"text":"5 ans","is_correct":true},{"text":"8 ans"},{"text":"10 ans"}]},
    {"kind":"quiz","question_text":"Diversifier son portefeuille sert surtout à…","time_limit_sec":15,
     "explanation":"Répartir ses placements limite l'impact d'une mauvaise surprise sur un seul actif.",
     "options":[{"text":"Garantir un gain"},{"text":"Réduire le risque","is_correct":true},{"text":"Éviter les impôts"},{"text":"Payer moins de frais"}]},
    {"kind":"quiz","question_text":"Les intérêts composés, c’est…","time_limit_sec":15,
     "explanation":"Tes intérêts produisent à leur tour des intérêts : l'effet boule de neige.",
     "options":[{"text":"Un taux fixe garanti"},{"text":"Gagner des intérêts sur ses intérêts","is_correct":true},{"text":"Un type de prêt bancaire"},{"text":"Une taxe sur l’épargne"}]},
    {"kind":"quiz","question_text":"Vrai ou faux : un rendement élevé sans aucun risque, ça existe.","time_limit_sec":10,
     "explanation":"Faux ! Rendement et risque vont toujours de pair. Méfie-toi des promesses trop belles.",
     "options":[{"text":"Vrai"},{"text":"Faux","is_correct":true}]}
  ]
}
]$$::jsonb
$json$;

create or replace function public.ensure_sample_quizzes()
returns int language plpgsql security definer set search_path = public as $$
declare
  doc jsonb;
  n int := 0;
begin
  perform public._assert_host();
  insert into public.host_profiles (user_id) values (auth.uid()) on conflict do nothing;
  if (select samples_seeded_at from public.host_profiles where user_id = auth.uid()) is not null then
    return 0;
  end if;
  for doc in select * from jsonb_array_elements(public._sample_documents()) loop
    perform public.save_quiz(null, doc);
    n := n + 1;
  end loop;
  update public.host_profiles set samples_seeded_at = now() where user_id = auth.uid();
  return n;
end $$;

revoke execute on function public._sample_documents() from public, anon, authenticated;
revoke execute on function public.ensure_sample_quizzes() from public, anon;
grant execute on function public.ensure_sample_quizzes() to authenticated;
