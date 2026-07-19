import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParams } from '../../navigation/RootNavigator';
import { api } from '../../api/client';

type Props = NativeStackScreenProps<AuthStackParams, 'PhoneEntry'>;

/**
 * Step 1 of phone auth. Client-side we only sanity-check the shape; the server
 * owns real E.164 validation + rate limiting (never trust the client â€” the API
 * is callable without the app).
 */
export function PhoneEntryScreen({ navigation }: Props) {
  const [phone, setPhone] = useState('+91');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestOtp = async () => {
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      setError('Enter your number in international format, e.g. +919876543210');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/otp/request', { phone });
      // In OTP_MODE=mock the code appears in the gateway console log.
      navigation.navigate('OtpVerify', { phoneE164: phone });
    } catch (e) {
      setError('Could not send a code. Is the gateway running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>What's your phone number?</Text>
      <TextInput
        style={styles.input}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoFocus
        placeholder="+919876543210"
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={requestOtp} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Sendingâ€¦' : 'Send code'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
  heading: { fontSize: 22, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 14, fontSize: 18 },
  error: { color: '#c0392b' },
  button: { backgroundColor: '#128C7E', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
});

