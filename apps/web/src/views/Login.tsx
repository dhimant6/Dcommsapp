import { FormEvent, useEffect, useState } from 'react';
import { api, setTokens } from '../api';
import { wsConnect } from '../socket';
import { useStore } from '../store';
import type { TokenPair } from '@dcom/shared';

/**
 * Phone + OTP. In OTP_MODE=mock the server returns the code (devCode) and we
 * prefill it — the full production choreography, minus the SMS bill.
 * Room devices sign in the same way (a "resource account" phone number),
 * mirroring how MTR hardware signs into a Teams resource account.
 */
export function Login({ roomMode }: { roomMode: boolean }) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('+91');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [gateCode, setGateCode] = useState('');
  const [gated, setGated] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Ask the server whether an access code is required (GATE_CODE env set).
  useEffect(() => {
    void api<{ gated: boolean }>('GET', '/api/auth/gate')
      .then((g) => setGated(g.gated))
      .catch(() => {});
  }, []);

  const requestOtp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ devCode?: string }>('POST', '/api/auth/otp/request', {
        phone,
        gateCode: gateCode || undefined,
      });
      if (res.devCode) setCode(res.devCode); // mock mode convenience
      setStep('code');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const pair = await api<TokenPair>('POST', '/api/auth/otp/verify', {
        phone,
        code,
        platform: roomMode ? 'room' : 'web',
        displayName: name || undefined,
        gateCode: gateCode || undefined,
      });
      setTokens(pair);
      if (roomMode) await api('PATCH', '/api/me', { isRoomDevice: true });
      useStore.getState().set({ user: pair.user });
      wsConnect();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className={`center-page ${roomMode ? 'kiosk' : ''}`}>
      <div className="card login-card">
        <h1>{roomMode ? 'Dcom Rooms' : 'Dcom'}</h1>
        <p className="muted">
          {roomMode ? 'Sign this room device in with its resource account.' : 'Chat + calls. Sign in with your phone.'}
        </p>
        {step === 'phone' ? (
          <form onSubmit={requestOtp}>
            <label>Phone (E.164)</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" autoFocus />
            <label>{roomMode ? 'Room name' : 'Display name'}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={roomMode ? 'Boardroom 4A' : 'Alice'} />
            {gated && (
              <>
                <label>Access code</label>
                <input value={gateCode} onChange={(e) => setGateCode(e.target.value)} placeholder="from your invite" />
              </>
            )}
            <button disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <label>6-digit code sent to {phone}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} autoFocus />
            <button disabled={busy || code.length < 6}>{busy ? 'Verifying…' : 'Verify'}</button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
