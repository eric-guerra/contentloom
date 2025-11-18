'use client';
import { useEffect, useState } from 'react';

type Item = {
  id: string; status: string; draft: string;
  brief: { sku: string; locale: string; category: string; facts: Record<string, string> };
  score: { total: number; facts: number; claims: number; judge: number | null; notes: string[] };
};

// The SSO proxy in front of this app injects x-user / x-roles on the way to the API.
async function api(path: string, init?: RequestInit) {
  const r = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? r.statusText);
  return r.json();
}

export default function Review() {
  const [queue, setQueue] = useState<Item[]>([]);
  const [i, setI] = useState(0);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const item = queue[i];

  const load = () => api('/review').then((q) => { setQueue(q); setI(0); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { setText(item?.draft ?? ''); setNote(''); }, [item?.id]);

  async function decide(decision: 'approve' | 'reject' | 'revise') {
    try {
      await api(`/items/${item.id}/review`, { method: 'POST', body: JSON.stringify({ decision, editedText: text !== item.draft ? text : undefined, note: note || undefined }) });
      setQueue((q) => q.filter((x) => x.id !== item.id));
    } catch (e) { setErr((e as Error).message); }
  }

  if (err) return <p style={{ padding: 16, color: '#c62828' }}>{err}</p>;
  if (!item) return <main style={{ padding: 16 }}><h1>Review queue</h1><p>Nothing to review.</p><button onClick={load}>Refresh</button></main>;

  return (
    <main style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <section>
        <h1 style={{ fontSize: 18 }}>{item.brief.sku} · {item.brief.locale} · {item.brief.category} <small>({queue.length} left)</small></h1>
        <table>{Object.entries(item.brief.facts).map(([k, v]) => <tr key={k}><th align="left">{k}</th><td>{v}</td></tr>)}</table>
        <h2 style={{ fontSize: 15 }}>Why it's here (score {item.score.total.toFixed(2)})</h2>
        <ul>{item.score.notes.map((n, j) => <li key={j}>{n}</li>)}</ul>
      </section>
      <section>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} style={{ width: '100%', fontSize: 15, lineHeight: 1.5 }} aria-label="Draft" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for revision / rejection" style={{ width: '100%', padding: 8, marginTop: 8 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => decide('approve')}>{text !== item.draft ? 'Approve with edits' : 'Approve'}</button>
          <button onClick={() => decide('revise')} disabled={note.trim().length < 5}>Send back for revision</button>
          <button onClick={() => decide('reject')}>Reject</button>
          <button onClick={() => setI((i + 1) % queue.length)}>Skip</button>
        </div>
      </section>
    </main>
  );
}
