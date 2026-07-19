import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../state/authStore';
import { PhoneEntryScreen } from '../screens/auth/PhoneEntryScreen';
import { OtpVerifyScreen } from '../screens/auth/OtpVerifyScreen';
import { ChatListScreen } from '../screens/chats/ChatListScreen';
import { ChatRoomScreen } from '../screens/chats/ChatRoomScreen';

/**
 * Route params are typed here so `navigation.navigate('OtpVerify', {...})`
 * is compile-checked everywhere â€” the same "one contract file" philosophy
 * as packages/shared/protocol.ts, applied to navigation.
 */
export type AuthStackParams = {
  PhoneEntry: undefined;
  OtpVerify: { phoneE164: string };
};

export type MainStackParams = {
  ChatList: undefined;
  ChatRoom: { conversationId: string; title: string };
};

const Auth = createNativeStackNavigator<AuthStackParams>();
const Main = createNativeStackNavigator<MainStackParams>();

export function RootNavigator() {
  // SWITCHING PATTERN: we don't "navigate" between auth and main â€” we render a
  // different navigator entirely. Logging out unmounts the whole main tree, so
  // no stale authenticated screen can survive in the back stack.
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);

  if (!isAuthenticated) {
    return (
      <Auth.Navigator>
        <Auth.Screen name="PhoneEntry" component={PhoneEntryScreen} options={{ title: 'Your phone' }} />
        <Auth.Screen name="OtpVerify" component={OtpVerifyScreen} options={{ title: 'Verify' }} />
      </Auth.Navigator>
    );
  }

  return (
    <Main.Navigator>
      <Main.Screen name="ChatList" component={ChatListScreen} options={{ title: 'Chats' }} />
      <Main.Screen
        name="ChatRoom"
        component={ChatRoomScreen}
        options={({ route }) => ({ title: route.params.title })}
      />
    </Main.Navigator>
  );
}

