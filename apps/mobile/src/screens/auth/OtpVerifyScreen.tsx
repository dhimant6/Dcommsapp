import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParams } from '../../navigation/RootNavigator';
import { api } from '../../api/client';
import { useAuthStore } from '../../state/authStore';

type Props = NativeStackScreenProps<AuthStackParams, 'OtpVerify'>;

/**
 * Step 2: exchange the OTP for the token pair. Note that success does NOT
 * navigate anywhere â€” signIn() flips the auth store, and RootNavigator swaps
 * the entire navigator tree. State drives navigation, not the other way round.
 */
export function OtpVerifyScreen({ route }: Props) {
  const { phoneE164 } = route.params;
  const signIn = useAuthStore((s) => s.signIn);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post('/api/auth/otp/verify', {
        phone: phoneE164,
        code,
        device: { platform: 'android' }, // TODO(Platform.OS): expo-device gives model/os version
      });
      await signIn({ access: data.access, refresh: data.refresh, userId: data.user.id });
    } catch (e) {
      setError('Wrong or expired code.');
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Enter the 6-digit code sent to {phoneE164}</Text>
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        maxLength={6}
        autoFocus
        placeholder="â€¢â€¢â€¢â€¢â€¢â€¢"
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable
        style={[styles.button, (busy || code.length < 6) && styles.buttonDisabled]}
        onPress={verify}
        disabled={busy || code.length < 6}
      >
        <Text style={styles.buttonText}>{busy ? 'Verifyingâ€¦' : 'Verify'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
  heading: { fontSize: 18, fontWeight: '500' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 14, fontSize: 24, letterSpacing: 8, textAlign: 'center' },
  error: { color: '#c0392b' },
  button: { backgroundColor: '#128C7E', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
});

