export default function SetupRequiredPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-lg rounded-2xl bg-card p-8 ring-1 ring-line">
        <h1 className="text-2xl font-semibold">Configuration requise</h1>
        <p className="mt-3 text-muted">
          Les variables <code className="text-gold">VITE_SUPABASE_URL</code> et <code className="text-gold">VITE_SUPABASE_ANON_KEY</code> sont
          manquantes. Copie <code>.env.example</code> vers <code>.env.local</code> et renseigne les clés de ton projet Supabase (voir README).
        </p>
      </div>
    </main>
  );
}
