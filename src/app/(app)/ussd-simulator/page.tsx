'use client';

import { useState } from 'react';
import { useAuthStore } from '@/lib/authStore';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface LogEntry {
  from: 'system' | 'user';
  text: string;
}

export default function UssdSimulatorPage() {
  const [phone, setPhone] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState('');
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(false);
  const token = useAuthStore((s) => s.token);

  async function callUssd(type: 'Initiation' | 'Response', message: string, sid: string) {
    setLoading(true);
    try {
      const res = await fetch('/api/ussd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ SessionId: sid, Mobile: phone, Message: message, Type: type }),
      });
      const body = await res.json();
      if (!res.ok) {
        setLog((l) => [...l, { from: 'system', text: body.error ?? 'The simulator is not available.' }]);
        setEnded(true);
        return;
      }
      setLog((l) => [...l, { from: 'system', text: body.Message }]);
      // AddToCart ends the session by handing the customer to Hubtel's own
      // checkout — which no simulator can stand in for.
      if (body.Type === 'AddToCart') {
        setLog((l) => [...l, { from: 'system', text: `[Hubtel's checkout would now prompt this number for GHS ${Number(body.Item?.Price ?? 0).toFixed(2)} — "${body.Item?.ItemName}". Nothing has been charged.]` }]);
      }
      setEnded(body.Type !== 'response');
    } finally {
      setLoading(false);
    }
  }

  function dial() {
    if (!phone.trim()) return;
    const sid = `sim-${Date.now()}`;
    setSessionId(sid);
    setLog([{ from: 'user', text: `*920# dialed from ${phone}` }]);
    setEnded(false);
    void callUssd('Initiation', '', sid);
  }

  function send() {
    if (!sessionId || !input.trim()) return;
    setLog((l) => [...l, { from: 'user', text: input }]);
    void callUssd('Response', input, sessionId);
    setInput('');
  }

  function reset() {
    setSessionId(null);
    setLog([]);
    setEnded(false);
    setInput('');
  }

  return (
    <div className="max-w-md space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Hubtel USSD Simulator</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Walks through the same menu a customer gets on their phone. Dial in with a phone number that has a
          registered customer with an outstanding balance. In mock mode a confirmed payment is recorded with no
          money moving; once Hubtel payments are live it sends a real prompt to that phone.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="border border-gray-800 bg-black p-4 text-green-400 font-mono text-sm shadow-inner min-h-[280px] flex flex-col">
            {log.length === 0 && <div className="text-gray-500">Enter a phone number and press Dial to begin.</div>}
            <div className="flex-1 space-y-2 overflow-y-auto">
              {log.map((entry, i) => (
                <div key={i} className={entry.from === 'user' ? 'text-cyan-300' : 'whitespace-pre-wrap'}>
                  {entry.from === 'user' ? '> ' : ''}
                  {entry.text}
                </div>
              ))}
              {loading && <div className="text-gray-500">...</div>}
            </div>
          </div>

          {!sessionId && (
            <div className="mt-4 flex gap-2">
              <Input placeholder="e.g. 0244000111" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Button onClick={dial} disabled={loading}>Dial</Button>
            </div>
          )}

          {sessionId && !ended && (
            <div className="mt-4 flex gap-2">
              <Input
                placeholder="Type your reply..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
              <Button onClick={send} disabled={loading}>Send</Button>
            </div>
          )}

          {(ended || sessionId) && (
            <button className="mt-4 text-sm text-gray-500 hover:text-gray-700 underline" onClick={reset}>
              Start a new session
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
